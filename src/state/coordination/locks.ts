import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LOCKS } from "../../config/defaults.ts";
import { getCrewEnvBool } from "../../config/env-vars.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { sleepSync } from "../../utils/sleep.ts";
import { ensureDirSync, isSymlinkSafeDirCached, isSymlinkSafePath } from "../atomic-write.ts";
import type { TeamRunManifest } from "../types.ts";
import { acquireProcessLock, isProcessLockHeldError, type ProcessLockHandle } from "./process-lock.ts";

export interface RunLockOptions {
	staleMs?: number;
}

const DEFAULT_STALE_MS = DEFAULT_LOCKS.staleMs;

function lockPath(manifest: TeamRunManifest): string {
	return path.join(manifest.stateRoot, "run.lock");
}

function parseCreatedAtFromLock(raw: string): number | undefined {
	try {
		const payload = JSON.parse(raw) as unknown;
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
		const candidate = payload as { createdAt?: unknown };
		if (typeof candidate.createdAt !== "string") return undefined;
		const parsed = Date.parse(candidate.createdAt);
		return Number.isNaN(parsed) ? undefined : parsed;
	} catch {
		return undefined;
	}
}

function isLockStale(filePath: string, staleMs: number): boolean {
	try {
		const stat = fs.statSync(filePath);
		let createdAt = parseCreatedAtFromLock(fs.readFileSync(filePath, "utf-8"));
		if (createdAt === undefined) createdAt = stat.mtimeMs;
		return Date.now() - createdAt > staleMs;
	} catch {
		return false;
	}
}

function isLockHolderAlive(filePath: string): boolean {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { pid?: unknown };
		const pid = typeof parsed.pid === "number" ? parsed.pid : undefined;
		if (pid === undefined) return true; // Unknown holder — assume alive to be safe
		try {
			process.kill(pid, 0);
			return true; // Signal 0 succeeded — process is alive
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// EPERM: process exists but we don't have permission to signal it.
			// Since we cannot verify liveness, treat the holder as potentially
			// stale so the lock can be stolen rather than blocking indefinitely.
			// This is an acceptable trade-off: EPERM requires elevated privileges,
			// and blocking indefinitely would be worse. The risk is low.
			// Other errors (ESRCH — process doesn't exist) also mean holder is dead.
			return false;
		}
	} catch {
		return true; // Can't read — assume alive to be safe
	}
}

/**
 * Round 26 (BUG 1): read the lock file ONCE and evaluate staleness + holder
 * liveness from that single snapshot.
 *
 * Previously `acquireLockWithRetry` called `isLockStale()` and
 * `isLockHolderAlive()` separately, each performing its own `readFileSync`.
 * Between those two reads the lock could transition stale→fresh (old holder
 * released, new holder acquired): isLockStale saw the OLD createdAt → stale,
 * isLockHolderAlive saw the NEW pid → alive, yielding `!stale && alive` =
 * false → we forcibly rm the NEW holder's freshly-acquired lock and take it
 * ourselves → BOTH in the critical section. Reading once closes the window.
 *
 * Returns `{ canSteal: true }` if the lock is stale OR the holder is dead
 * (safe to forcibly remove); `{ canSteal: false }` if it is fresh AND held by
 * a live process (must keep waiting). RR-011 additionally reports
 * `heldByLiveInProcess: true` when the stored token belongs to a run-lock
 * acquisition of THIS process that is still inside its critical section — the
 * async acquire loop then WAITS (timer-based retry) instead of throwing or
 * stealing. W6 (steal-rm-dual-holder) additionally returns `holderToken` —
 * the snapshotted corpse's token (undefined for a token-less legacy payload,
 * a vanished file, or an unreadable snapshot) — so the acquire loop's
 * destructive removal can be INSTANCE-BOUND to the verified corpse
 * (removeLockIfTokenMatches) instead of deleting whatever currently occupies
 * the path.
 *
 * ## EPERM Handling (Accepted Risk)
 *
 * When `process.kill(pid, 0)` returns EPERM, it means the holder process
 * EXISTS but we lack permission to signal it. We treat this as "not alive"
 * (stealable) because:
 *
 * 1. **Blocking indefinitely is worse** — on shared systems, a holder running
 *    under a different user/permission context would block us forever.
 * 2. **EPERM requires elevated privileges** — on single-user workstations
 *    (the typical pi-crew environment), EPERM is rare.
 * 3. **Defense in depth** — the lock staleness check provides a secondary
 *    safeguard; we only steal if the lock is also stale.
 *
 * **Trade-off:** On multi-user systems, this could theoretically allow two
 * processes in the critical section simultaneously if: (a) holder is alive
 * under different permissions, AND (b) our steal attempt races with holder's
 * release. The practical risk is low because:
 * - Lock holders typically complete quickly
 * - Stale timeout provides a safety window
 * - Critical sections are designed to tolerate rare races
 *
 * See also: SECURITY-ISSUES.md SEC-008 for documented acceptance.
 */
function readLockSnapshot(
	filePath: string,
	staleMs: number,
	options?: { treatOwnPidAsStealable?: boolean; activeHolderTokens?: ReadonlySet<string> },
): { canSteal: boolean; heldByLiveInProcess: boolean; holderToken?: string } {
	const treatOwnPidAsStealable = options?.treatOwnPidAsStealable === true;
	let stat: fs.Stats | undefined;
	let raw: string | undefined;
	try {
		stat = fs.statSync(filePath);
		raw = fs.readFileSync(filePath, "utf-8");
	} catch (error) {
		// FIX (CI flake): when the lock file vanishes between writeLockFile's
		// EEXIST and our read here, the holder has released — return canSteal:true
		// so the acquire loop retries the create instead of throwing a false
		// "locked" error.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return { canSteal: true, heldByLiveInProcess: false, holderToken: undefined };
		}
		// Transient I/O error — be conservative (don't steal, retry the read on
		// next attempt).
		return { canSteal: false, heldByLiveInProcess: false, holderToken: undefined };
	}
	// Staleness from a single snapshot.
	let createdAt = parseCreatedAtFromLock(raw);
	if (createdAt === undefined) createdAt = stat.mtimeMs;
	const isStale = Date.now() - createdAt > staleMs;
	let holderPid: number | undefined;
	let holderToken: string | undefined;
	let isAlive = true;
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
		holderPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
		holderToken = typeof parsed.token === "string" ? parsed.token : undefined;
	} catch {
		/* malformed payload — keep isAlive=true */
	}
	if (holderPid !== undefined) {
		try {
			process.kill(holderPid, 0);
			isAlive = true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// EPERM/ESRCH → treat as not-alive (stealable), see isLockHolderAlive.
			isAlive = false;
		}
	}
	// Steal if stale OR holder dead. Optionally steal if holder is our own pid
	// (used by withRunLock* which is single-process — a fresh lock with our pid
	// between acquisitions is just a leftover from a previous call that
	// releaseOwnLock didn't get to delete yet; safe to steal).
	//
	// RR-011 (F02): "our own pid" alone can no longer authorize a steal for the
	// async run-lock path — a lock CURRENTLY HELD by another async context of
	// this process also carries our pid while its holder is merely awaiting
	// inside the critical section. The on-disk token disambiguates: a token in
	// `activeHolderTokens` (runLockHeldTokens — every live acquisition of this
	// process registers its token) means the holder is ALIVE in-process → the
	// own-pid steal branch is suppressed (see acquireLockWithRetryAsync: such a
	// holder WAITS instead of stealing/throwing). A token-less payload (legacy
	// lock file) or a token not in the set is a leftover corpse → still stealable,
	// preserving the anti-CI-flake behaviour the flag was added for.
	// NOTE (trap, design.md §4.2): comparing the stored token to the CURRENT
	// acquisition's token would be WRONG — each acquisition mints a fresh
	// randomUUID, so a live holder's token always differs from ours and the
	// predicate would steal anyway. Only a lookup into the LIVE-token set is
	// correct.
	const isOurOwnHolder = holderPid === process.pid;
	const holderIsLiveInProcess = holderToken !== undefined && (options?.activeHolderTokens?.has(holderToken) ?? false);
	const ownPidStealable = treatOwnPidAsStealable && isOurOwnHolder && !holderIsLiveInProcess;
	return {
		canSteal: isStale || !isAlive || ownPidStealable,
		heldByLiveInProcess: holderIsLiveInProcess,
		holderToken,
	};
}

/**
 * Lock file kinds. Discriminator written to the lock file payload so that:
 *   - Debugging tools (e.g. a future `pi-crew locks` command) can identify
 *     what a lock is protecting.
 *   - Cross-kind ambiguity is prevented if two locks somehow resolve to the
 *     same path (defense in depth).
 *   - Forward compat: new lock types can be added without changing the
 *     on-disk format (the `kind` field is the only discriminator).
 */
export type LockKind = "run" | "file";

function writeLockFile(filePath: string, token: string, kind: LockKind = "file"): void {
	// Reject a pre-existing symlink at the lock path before O_CREAT|O_EXCL.
	// O_EXCL fails with EEXIST if the path exists (including as a symlink),
	// but the failure mode is confusing — an explicit lstatSync gives a
	// clean, distinguishable error instead.
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) {
			throw new Error(`Refusing to create lock file over symlink: ${filePath}`);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// ENOENT means the path doesn't exist yet — that's fine, proceed.
		// Anything else (EACCES, EPERM, etc.) should surface immediately.
		if (code !== "ENOENT") throw error;
	}
	// Ensure parent directory exists (may have been cleaned up by a concurrent process)
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		fs.writeSync(
			fd,
			JSON.stringify({
				kind,
				pid: process.pid,
				createdAt: new Date().toISOString(),
				token,
			}),
		);
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * Read the token stored in a lock file. Returns undefined if the file
 * cannot be read or parsed.
 */
function readLockToken(filePath: string): string | undefined {
	try {
		// Refuse to read a symlink — prevents reading a target an attacker placed
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) return undefined;
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { token?: unknown };
		return typeof parsed.token === "string" ? parsed.token : undefined;
	} catch {
		return undefined;
	}
}

/**
 * W6 (steal-rm-dual-holder): INSTANCE-BOUND steal removal.
 *
 * Removes the lock file at `filePath` ONLY when its currently stored token
 * still equals `corpseToken` — the token of the stale/dead holder that the
 * caller's single-snapshot read verified as stealable. This binds the
 * destructive removal to the exact file instance that was verified: a
 * contender that created a FRESH lock between the snapshot and this removal
 * carries a different randomUUID token (or ANY token at all when the corpse
 * was a legacy token-less payload), which never matches → no removal, and the
 * caller's retry loop re-snapshots cleanly instead of deleting a live
 * holder's lock (the dual-holder window the un-tokened `fs.rmSync` created).
 * Symlinks are refused via readLockToken (undefined for a symlink).
 *
 * Exported for unit tests of the steal-race fix; production callers are the
 * steal branches of acquireLockWithRetry / acquireLockWithRetryAsync.
 */
export function removeLockIfTokenMatches(filePath: string, corpseToken: string | undefined): boolean {
	const currentToken = readLockToken(filePath);
	const matches =
		corpseToken === undefined
			? currentToken === undefined
			: currentToken !== undefined && timingSafeTokenMatch(currentToken, corpseToken);
	if (!matches) return false;
	try {
		fs.rmSync(filePath, { force: true });
		return true;
	} catch {
		/* race — let the caller's loop retry */
		return false;
	}
}

/**
 * Release a lock file, but ONLY if the stored token matches. This prevents
 * the "losing contender wipes winner's lock" race that occurs when:
 *   1. Process A acquires lock with token T_A
 *   2. Process B times out waiting, steals the lock (overwriting with T_B)
 *   3. Process A finishes, tries to release — would otherwise rm Process B's lock
 *
 * With token matching, A's release is a no-op for B's lock.
 */
function timingSafeTokenMatch(a: string, b: string): boolean {
	// Early length check prevents timing side-channel that leaks length info.
	// Without this, timingSafeEqual compares the full padded length, revealing
	// that the strings have different lengths via the zero-padding.
	if (a.length !== b.length) return false;
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	return timingSafeEqual(bufA, bufB);
}

/**
 * Release the lock we (this process) just acquired. Used in the `finally` blocks
 * of withRunLock and withRunLockSync, so the file was created earlier in the SAME
 * call and carries OUR token.
 *
 * LOCK-1 (Round 2): PID-guarded release. Previously this deleted
 * UNCONDITIONALLY — if our critical section exceeded staleMs, another process
 * could steal our lock (overwrite the file with its own pid); our finally would
 * then DELETE THE STEALER's lock, breaking mutual exclusion. We therefore verify
 * the lock file still records OUR pid before removing; if it records a different
 * pid the lock was stolen and the current holder owns it.
 *
 * RR-011 (F02): within one process, PID equality no longer identifies "our" lock
 * — two same-process async holders are distinguished ONLY by token. A finishing
 * context must not delete another acquisition's lock (verification probe 2: the
 * lock file was ENOENT while the second holder was still inside its critical
 * section). So after the pid check, the stored token must also match ours. A
 * token-less payload (legacy lock file from an older release) keeps the
 * PID-only behaviour so old files are still cleaned up.
 *
 * Symlink guard is preserved: if a symlink appeared since our writeLockFile, we
 * don't rm it (defense against attacker-planted symlinks).
 */
/**
 * US-002 (2026-09-22): structured, safe, idempotent sweep of stale run locks.
 *
 * Locks whose holder died without releasing (kill -9, crash) previously lingered
 * until some future acquirer hit the stale-steal path. This gives the
 * stale-reconciler an explicit pass.
 *
 * IMPORTANT — the sweep predicate is STRICTER than acquire-time `canSteal`:
 * acquire steals on `stale OR holder-dead` (deliberate: a stale lock must not
 * block a live run forever), but a SWEEP must only remove a lock whose holder is
 * provably DEAD. Removing a stale-but-live holder's lock would let two processes
 * enter the critical section. So: stale AND (no pid OR pid dead). A live pid is
 * never swept, no matter how old.
 *
 * Returns the lock files it removed. Idempotent: a second sweep finds nothing.
 *
 * @deprecated-after-window U21 (2026-10-13): async run-lock holders now also
 * own a kernel process socket (locks.ts `withRunLock`) which needs NO sweep —
 * it dies with its process. This file-lock sweep still covers the SYNC path
 * (`withRunLockSync`, file-only by design) and legacy/foreign holders during
 * the migration window; remove it after the file-lock migration window
 * closes.
 */
export function sweepStaleLocks(lockFiles: readonly string[], options: RunLockOptions = {}): { removed: string[] } {
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	const removed: string[] = [];
	for (const filePath of lockFiles) {
		try {
			if (!fs.existsSync(filePath)) continue;
			if (!isLockStale(filePath, staleMs)) continue; // fresh → leave alone
			// Stale. Remove ONLY when no live holder owns it.
			if (isLockHolderAlive(filePath)) continue;
			fs.rmSync(filePath, { force: true });
			removed.push(filePath);
		} catch (error) {
			logInternalError("locks.sweep-stale", error, `path=${filePath}`);
		}
	}
	return { removed };
}

/**
 * US-002: discover every `run.lock` under a runs root
 * (`<runsRoot>/<runId>/run.lock`), bounded, for sweepStaleLocks. Missing → empty.
 *
 * @deprecated-after-window U21: alongside `sweepStaleLocks` — socket-guarded
 * async holders need no sweep; remove after the file-lock migration window
 * closes (sync path + legacy holders keep needing it until then).
 */
export function discoverRunLockFiles(runsRoot: string, maxDirs = 500): string[] {
	try {
		if (!fs.existsSync(runsRoot)) return [];
		return fs
			.readdirSync(runsRoot, { withFileTypes: true })
			.filter((e) => e.isDirectory())
			.slice(0, maxDirs)
			.map((e) => path.join(runsRoot, e.name, "run.lock"))
			.filter((p) => fs.existsSync(p));
	} catch (error) {
		logInternalError("locks.discover-run-locks", error, `runsRoot=${runsRoot}`);
		return [];
	}
}

export function releaseOwnLock(filePath: string, token: string): void {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) return;
	} catch {
		/* ENOENT is fine */
	}
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
		const holderPid = parsed.pid;
		const storedToken = typeof parsed.token === "string" ? parsed.token : undefined;
		if (holderPid !== process.pid) {
			// holderPid !== process.pid → lock stolen by another process; do NOT touch.
			return;
		}
		if (storedToken !== undefined && storedToken !== token) {
			// RR-011 (F02): same process, different token → the lock now belongs to
			// another acquisition of THIS process (steal window / superseded holder).
			// Do not delete it — the current holder owns it.
			return;
		}
		fs.rmSync(filePath, { force: true });
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			logInternalError("lock-release-own", error, filePath, "warn");
		}
	}
}

function releaseLock(filePath: string, token: string): void {
	// FIX: Do not delete a symlink — it may have been planted by an attacker
	// after our lock was released. A legitimate lock file should never be a
	// symlink since writeLockFile uses O_CREAT|O_EXCL which fails on symlinks.
	let isSymlink = false;
	try {
		isSymlink = fs.lstatSync(filePath).isSymbolicLink();
	} catch {
		/* file doesn't exist — that's fine, we'll handle ENOENT below */
	}
	if (isSymlink) return;

	const stored = readLockToken(filePath);
	if (stored === undefined || timingSafeTokenMatch(stored, token)) {
		try {
			fs.rmSync(filePath, { force: true });
		} catch (error) {
			// FIX: Only ignore ENOENT (lock already gone). Other errors (EACCES,
			// EPERM, EBUSY) indicate a real problem and should be surfaced.
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT") throw error;
			// Lock already gone — that's fine, we wanted to release it anyway.
		}
	}
	// If the stored token does not match, our lock has been stolen
	// (probably stale and overtaken). Do not touch it — the new holder owns it.
}

/**
 * Error codes that mean "the lock file exists / is momentarily un-creatable
 * because another process holds it" rather than "something is broken".
 *
 * EEXIST is the POSIX O_CREAT|O_EXCL loser signal. On Windows (libuv),
 * CREATE_NEW against a file that another process has open mid-create can
 * surface as EPERM (ERROR_ACCESS_DENIED) or EBUSY instead of EEXIST —
 * observed on the windows-latest CI runner (ST-3 cross-process flock test).
 * Retrying these is correct: the holder always closes/releases within the
 * stale-deadline budget, and the deadline still bounds the wait.
 */
function isLockContention(code: string | undefined): boolean {
	return code === "EEXIST" || code === "EPERM" || code === "EBUSY";
}

// RR-011 (F02): tokens of run-lock acquisitions that are CURRENTLY HELD in this
// process. It answers exactly one question — "is this holder still alive
// in-process?" — and NOTHING else:
//   - Re-entrance (bypass) decisions stay in `lockCtx` (per async context). This
//     set must NEVER be consulted for bypass — that is the H-1 bug class.
//   - The async steal predicate consults it (via readLockSnapshot's
//     activeHolderTokens) so a SECOND independent async context can no longer
//     steal a lock whose holder is merely awaiting inside its critical section.
//
// INVARIANT: a token is added synchronously right after a successful acquire
// (no await between acquire returning and the add) and deleted in the
// acquisition's `finally` BEFORE releaseOwnLock runs — so a token in this set
// always corresponds to a live critical section, and a leftover lock file from
// a finished acquisition (token no longer in the set, or a legacy token-less
// payload) remains stealable, preserving the CI-flake fix that
// treatOwnPidAsStealable was added for. If a `finally` were ever skipped, the
// leaked entry is inert: future lock files always mint a fresh randomUUID.
const runLockHeldTokens = new Set<string>();

function acquireLockWithRetry(filePath: string, staleMs: number, kind: LockKind = "file"): string {
	let attempt = 0;
	const deadline = Date.now() + staleMs * 2;
	while (true) {
		const token = randomUUID();
		try {
			writeLockFile(filePath, token, kind);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!isLockContention(code)) throw error;
			if (Date.now() > deadline) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Round 26 (BUG 1): single-snapshot read closes the TOCTOU window between
			// separate stale + alive reads (which could race stale→fresh).
			// treatOwnPidAsStealable=false (this is the sync file-lock path used
			// by withFileLockSync — never steal a fresh lock even if it has our pid).
			const { canSteal, holderToken: corpseToken } = readLockSnapshot(filePath, staleMs, { treatOwnPidAsStealable: false });
			if (!canSteal) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Stale or dead holder — remove it. W6 (steal-rm-dual-holder): the
			// removal is INSTANCE-BOUND — re-read the current holder's token and
			// remove only if it still equals the snapshotted corpse token. Without
			// this binding, a contender that created a FRESH lock between our
			// snapshot and this removal would lose its lock to our rmSync, our
			// create would then succeed, and BOTH of us would enter the critical
			// section (dual holders, no post-create verification). On mismatch:
			// no removal — the retry loop re-snapshots cleanly.
			removeLockIfTokenMatches(filePath, corpseToken);
			sleepSync(Math.min(250, 25 * 2 ** attempt));
			attempt++;
			continue;
		}
		// W6 (steal-rm-dual-holder): post-claim verification, mirroring
		// workspace-lock.ts claimLock/tryCreateVerified. O_EXCL proved WE created
		// the file, but a concurrent stealer can remove our fresh file and claim
		// its own in the microseconds before we return the token. Re-read: the
		// on-disk token must be OURS before the acquire is considered successful.
		// On mismatch: release best-effort (token-guarded → no-op against the
		// foreign holder) and retry instead of returning a token we cannot prove.
		if (readLockToken(filePath) === token) return token;
		releaseLock(filePath, token);
		if (Date.now() > deadline) {
			throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
		}
		sleepSync(Math.min(250, 25 * 2 ** attempt));
		attempt++;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLockWithRetryAsync(filePath: string, staleMs: number, kind: LockKind = "file"): Promise<string> {
	let attempt = 0;
	const deadline = Date.now() + staleMs * 2;
	while (true) {
		const token = randomUUID();
		try {
			writeLockFile(filePath, token, kind);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!isLockContention(code)) throw error;
			if (Date.now() > deadline) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Round 26 (BUG 1): single-snapshot read (see sync variant).
			// FIX (CI flake): treatOwnPidAsStealable=true for the run-lock async path
			// (withRunLock). Between acquisitions in parallel-research scaffold mode,
			// the previous releaseOwnLock leaves a microsecond window where the
			// file still exists with our own pid. Stealing it avoids spurious 'locked'
			// errors. The sync file-lock path (withFileLockSync) above uses false to
			// preserve the multi-process safety guarantee.
			// RR-011 (F02): the steal now consults runLockHeldTokens — a lock whose
			// stored token belongs to a LIVE acquisition of this process is NOT a
			// leftover corpse and must not be stolen (that broke async↔async mutual
			// exclusion: two independent async contexts entered the critical section
			// together). Token-less legacy files are still stolen (CI-flake fix).
			const verdict = readLockSnapshot(filePath, staleMs, {
				treatOwnPidAsStealable: true,
				activeHolderTokens: runLockHeldTokens,
			});
			if (!verdict.canSteal && verdict.heldByLiveInProcess) {
				// RR-011 (F02): the holder is a LIVE acquisition in THIS process (another
				// async context awaiting inside its critical section). It releases in its
				// `finally` on this same event loop — WAIT via a timer (never sleepSync:
				// blocking the event loop would starve the very holder we are waiting
				// for, the v0.9.26 deadlock class) and retry the create. The loop deadline
				// above plus the staleMs check in readLockSnapshot bound the wait, so a
				// hung holder eventually becomes stale-stealable and this can never
				// block indefinitely.
				const delay = Math.min(250, 25 * 2 ** attempt);
				await sleep(delay);
				attempt++;
				continue;
			}
			if (!verdict.canSteal) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			if (verdict.heldByLiveInProcess) {
				// Review MAJOR 2: the staleMs backstop is stealing a lock whose holder
				// is STILL a live acquisition of this process (its critical section
				// legitimately exceeded staleMs — fsync stalls, loaded machine). The
				// steal is the documented design (ADR 2026-09-17-run-lock-async-
				// ownership) but mutual exclusion is about to be violated knowingly,
				// so it must be observable, never silent — production holders are
				// ms-scale; seeing this warn means the invariant "critical section <
				// staleMs" was broken and the budget should be revisited.
				logInternalError(
					"locks.steal-live-holder",
					new Error(`staleMs steal of a lock held by a LIVE in-process acquisition (staleMs=${staleMs})`),
					filePath,
					"warn",
				);
			}
			// Stale or dead holder — remove it. W6 (steal-rm-dual-holder): the
			// removal is INSTANCE-BOUND to the snapshotted corpse token (see the
			// sync twin above) — a contender's fresh lock created between our
			// snapshot and this removal never matches and is NOT deleted; the
			// retry loop re-snapshots instead of leaving two live holders.
			removeLockIfTokenMatches(filePath, verdict.holderToken);
			const delay = Math.min(250, 25 * 2 ** attempt);
			await sleep(delay);
			attempt++;
			continue;
		}
		// W6 (steal-rm-dual-holder): post-claim verification — same protocol as
		// the sync twin above (mirrors workspace-lock.ts tryCreateVerified): the
		// returned token is only trusted when the on-disk token is still OURS.
		if (readLockToken(filePath) === token) return token;
		releaseLock(filePath, token);
		if (Date.now() > deadline) {
			throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
		}
		const delay = Math.min(250, 25 * 2 ** attempt);
		await sleep(delay);
		attempt++;
	}
}

/**
 * U21 (2026-10-13): process-socket supplement toggle for the ASYNC run-lock
 * path. Default ON; `'0'`/`'false'`/`'no'` restores the pre-U21 file-lock-only
 * behaviour bit-for-bit (dual-holder migration window escape hatch). Read via
 * the crew env registry — this is a HOST-process read, never passed to children
 * (the lock name is derived from the run dir path; nothing is inherited).
 */
function runLockSocketSupplementEnabled(): boolean {
	return getCrewEnvBool("PI_CREW_RUN_LOCK_SOCKET") ?? true;
}

/**
 * U21: the kernel-socket lock name for a run-lock file path. Derived from the
 * ABSOLUTE run dir path so every process agrees on the name for the same run
 * regardless of cwd/relative-path spelling.
 *
 * F2 (2026-10-14): the name is prefixed with the process uid. The socket
 * namespace is SYSTEM-WIDE (abstract sockets / named pipes are not
 * per-user), so two different users working on the same run path would
 * otherwise collide — user A's live holder would lock user B out of B's own
 * run. The uid prefix removes that cross-user same-path collision. `"noid"`
 * covers runtimes without `process.getuid` (e.g. Windows).
 *
 * Deploy-window: a live holder started on the OLD (uid-less) name is NOT
 * visible to new code during the transition — SAFE, because the file lock
 * stays the PRIMARY guard and the socket is only the U21 dual-guard
 * supplement; once every process runs the new code, all holders use the
 * unified uid-prefixed name.
 */
export function runLockSocketName(filePath: string): string {
	const uid = typeof process.getuid === "function" ? process.getuid() : "noid";
	return `${uid}:run:${path.resolve(filePath)}`;
}

/**
 * U21 dual-guard acquire for the async run-lock: file lock FIRST (existing
 * WAIT/backoff admission of D1 / RR-011 completely unchanged), THEN the kernel
 * process socket (process-lock.ts, vendored from chord).
 *
 * If the socket is held (`reason: "locked"`) we treat it exactly like file
 * contention: drop OUR file token (token-guarded releaseOwnLock) and keep
 * WAITing — same `staleMs * 2` deadline budget the file-acquire loop uses —
 * then retry the whole file+socket acquisition. When BOTH are held the caller
 * owns the run. Non-contention socket failures propagate AFTER the file token
 * is dropped (we never keep the file without the guard that promised it).
 *
 * The socket exists to harden async holders against dual-process entry where
 * O_EXCL file locks are weak (NFS and similar); it intentionally does NOT
 * touch the six file-lock semantics (re-entrance, token release, live WAIT,
 * stale-steal + WARN, EPERM, ENOENT) — those all live in the file tier.
 */
async function acquireRunLockGuarded(filePath: string, staleMs: number): Promise<{ token: string; socket: ProcessLockHandle | undefined }> {
	if (!runLockSocketSupplementEnabled()) {
		// Supplement OFF (PI_CREW_RUN_LOCK_SOCKET=0): pre-U21 behaviour, bit-for-bit.
		return { token: await acquireLockWithRetryAsync(filePath, staleMs, "run"), socket: undefined };
	}
	const deadline = Date.now() + staleMs * 2; // same budget as the file-acquire loop
	let attempt = 0;
	for (;;) {
		const token = await acquireLockWithRetryAsync(filePath, staleMs, "run");
		// RR-011 (F02) extended to the dual-guard window: the token must be
		// visible as a LIVE in-process hold from the moment the file tier is
		// ours — the socket listen below is a macrotask and can be delayed by
		// event-loop pressure, which would otherwise make concurrent
		// same-process acquirers misread our fresh token as a stealable corpse.
		runLockHeldTokens.add(token);
		try {
			const socket = await acquireProcessLock(runLockSocketName(filePath));
			return { token, socket };
		} catch (error) {
			// Never keep the file token without the socket guard that follows it.
			runLockHeldTokens.delete(token);
			releaseOwnLock(filePath, token);
			if (!isProcessLockHeldError(error)) throw error;
			// Socket contention — WAIT (timer-based, never sleepSync: the live
			// socket holder may be another async context of THIS process, and
			// blocking the event loop would starve it — the v0.9.26 deadlock
			// class) and retry within the same staleMs*2 deadline.
			if (Date.now() > deadline) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			await sleep(Math.min(250, 25 * 2 ** attempt));
			attempt++;
		}
	}
}

/**
 * General-purpose file lock for arbitrary file paths.
 * Uses the same O_EXCL atomic create strategy as run locks.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: RunLockOptions = {}): T {
	// FIX: Use a separate .flock sidecar so the lock file doesn't collide with
	// the file being protected. Previously withFileLockSync used the file path
	// itself as the lock, which meant any operation on the same file (read,
	// append, or even the lock acquisition itself) would race with the lock.
	const lockFile = `${filePath}.flock`;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	// ST-14: re-entrance guard is scoped to the current async context, mirroring
	// the H-1 fix for withRunLockSync (lockCtx). Previously this used the
	// process-global fileLockHeldByUs map, so a re-entrance decision in one
	// async context could leak into another (same bug class as H-1).
	// fileLockSyncCtx (AsyncLocalStorage) scopes the held set to the current
	// async context: a call from a DIFFERENT async context sees no held set
	// and properly serializes against the on-disk lock. True nested calls in
	// the SAME async context still bypass via fileLockSyncCtx.getStore().
	if (fileLockSyncCtx.getStore()?.has(lockFile)) {
		return fn();
	}
	// Cross-tier bypass: if withFileLockAsync currently holds the .flock in
	// THIS process, bypass to avoid a sleepSync deadlock (the sync retry loop
	// blocks the event loop, starving the async holder). In production this
	// never fires: child-process mode uses sync-only mailbox operations;
	// live-session mode uses async-only. Mirrors the symmetric check in
	// withFileLockAsync. fileLockHeldByUs remains process-global by design —
	// it tracks actual on-disk holds, not re-entrance.
	if (fileLockHeldByUs.get(lockFile)) {
		return fn();
	}
	// PERF (2026-08-24): pre-loop check uses the 10s-TTL cached verdict (same
	// tradeoff atomic writes already make). The RETRY loop below keeps the
	// UNCACHED re-validation — TOCTOU rigor is preserved exactly where a race
	// is actually being retried.
	if (!isSymlinkSafeDirCached(path.dirname(lockFile))) throw new Error("Refusing: parent of lock directory is a symlink");
	ensureDirSync(path.dirname(lockFile));
	// Round 26 (BUG 2): REMOVED the pre-acquisition target-file-existence check.
	// It was racy — between statSync(target) and acquire, a concurrent process
	// could acquire the lock to CREATE the target, and we'd delete its active
	// lock. It was also actively wrong for callers that pass a path already
	// ending in `.flock` (config.ts: the checked "target" never exists, so the
	// cleanup ALWAYS fired, deleting a fresh concurrent holder's lock). Genuine
	// orphan locks (crashed holder) are reclaimed by acquireLockWithRetry's
	// staleMs-based steal logic after at most `staleMs`.
	// FIX (TOCTOU): Re-validate symlink safety before each lock acquisition
	// attempt. Between our initial check and the acquisition (and between
	// acquireLockWithRetry's internal retries), an attacker could plant a
	// symlink. We must re-check on each iteration to catch TOCTOU races.
	let token = "";
	let attempt = 0;
	const deadline = Date.now() + staleMs * 2;
	while (Date.now() <= deadline) {
		if (!isSymlinkSafePath(path.dirname(lockFile))) throw new Error("Refusing: parent of lock directory is a symlink");
		try {
			token = acquireLockWithRetry(lockFile, staleMs, "file");
			break;
		} catch {
			sleepSync(Math.min(250, 25 * 2 ** attempt));
			attempt++;
		}
	}
	if (token === "") throw new Error(`Run '${path.basename(lockFile)}' is locked by another operation.`);
	// ST-14: enter a new async context carrying the held set, mirroring
	// withRunLockSync's lockCtx.run pattern. Nested same-context calls see
	// the held set and bypass (re-entrant); cross-context callers do not.
	const prevHeld = fileLockSyncCtx.getStore() ?? new Set<string>();
	const newHeld = new Set(prevHeld);
	newHeld.add(lockFile);
	return fileLockSyncCtx.run(newHeld, () => {
		fileLockHeldByUs.set(lockFile, token);
		// ST-3-FIX: register the SYNC hold separately so withFileLockAsync's bypass
		// can detect it WITHOUT seeing async's own holds (which would break
		// async↔async mutual exclusion).
		fileSyncLockHeldByUs.add(lockFile);
		try {
			return fn();
		} finally {
			// Token-guarded release: don't rm the lock if it has been stolen.
			fileLockHeldByUs.delete(lockFile);
			fileSyncLockHeldByUs.delete(lockFile);
			releaseLock(lockFile, token);
		}
	});
}

// H-1: track re-entrant run-lock acquisitions PER ASYNC CONTEXT (not process-global).
// Previously a module-global Map caused a bug: when withRunLock (async) yielded at
// `await fn()`, a concurrent withRunLockSync for the same run — fired from a
// different async context (e.g. a child stdout event handler) — saw the holder's
// token and bypassed the file lock entirely, allowing two writers in the critical
// section simultaneously. AsyncLocalStorage scopes the "held" set to the current
// async context, so a call from a different async context no longer bypasses and
// properly serializes against the on-disk lock. True nested calls in the SAME
// async context (e.g. handleResume -> executeTeamRun -> executeTeamRunCore) still
// bypass via lockCtx.getStore(), avoiding the deadlock the bypass was designed for.
const lockCtx = new AsyncLocalStorage<Set<string>>();
// ST-14: track re-entrant withFileLockSync acquisitions PER ASYNC CONTEXT
// (not process-global), mirroring the H-1 fix (lockCtx) for withRunLockSync.
// Previously withFileLockSync used the process-global fileLockHeldByUs map for
// re-entrance detection, so a re-entrance hit/miss decision in one async context
// could leak into another (same bug class as H-1). fileLockSyncCtx scopes the
// held set to the current async context.
const fileLockSyncCtx = new AsyncLocalStorage<Set<string>>();
// Round 29: process-global map for cross-tier sync↔async coordination. Set by
// BOTH withFileLockSync and withFileLockAsync when they hold the on-disk .flock.
// Consumed by withFileLockSync's bypass (detects when ASYNC holds the .flock, so
// the sync retry loop doesn't sleepSync-block the event loop and starve the
// async holder). NOT a re-entrance guard — re-entrance is tracked per async
// context (fileLockSyncCtx for sync, fileAsyncLockCtx for async).
const fileLockHeldByUs = new Map<string, string>(); // lockFile -> token
// ST-3-FIX: process-global set populated ONLY by withFileLockSync when it holds
// the on-disk .flock. Consumed by withFileLockAsync's bypass to detect SYNC
// holds (so async skips sleepSync-wait when sync holds, preventing sync↔async
// deadlock). SEPARATE from fileLockHeldByUs so that a SECOND concurrent ASYNC
// caller does NOT see the FIRST async caller's hold and bypass — that broke
// async↔async mutual exclusion (the in-process promise chain + on-disk .flock
// were both skipped). fileLockHeldByUs is set by BOTH tiers; this set is
// SYNC-only.
const fileSyncLockHeldByUs = new Set<string>(); // lockFile (held by sync path)

// --- Async file lock (non-blocking alternative to withFileLockSync) ---
// Two-tier: in-process promise chain (serialize within this process) + on-disk
// .flock (serialize cross-process via O_EXCL + async retry). The on-disk tier
// was added in ST-3 to fix message loss when the sync append path
// (withFileLockSync, also .flock) and the async append path (previously
// in-process only) ran concurrently across processes on the same mailbox file.
const fileAsyncLocks = new Map<string, Promise<unknown>>();

// FIND-02 follow-up (P3): re-entrance guard for the async file lock, mirroring
// the lockCtx pattern used by withRunLock. A future caller doing same-path
// nested withFileLockAsync(path, ...) inside another withFileLockAsync(path,
// ...) in the SAME async context would otherwise deadlock (the nested call
// chains after the outer's still-pending promise). AsyncLocalStorage scopes
// the held set to the current async context so cross-context callers still
// serialize via the promise chain (Phase 1 mailbox path is unaffected).
const fileAsyncLockCtx = new AsyncLocalStorage<Set<string>>();

export async function withFileLockAsync<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const lockFile = `${filePath}.flock`;
	// Re-entrant within the same async context — run fn() directly (no chaining).
	// Same semantics as the sync guard in withFileLockSync (fileLockSyncCtx,
	// ST-14) and the async guard in withRunLock (lockCtx).
	if (fileAsyncLockCtx.getStore()?.has(lockFile)) {
		return await fn();
	}
	// Cross-tier bypass for SYNC holds: if withFileLockSync currently holds the
	// .flock in this process, bypass to avoid a sleepSync deadlock (the sync
	// retry loop blocks the event loop, starving our async holder). In production
	// this never fires: child-process mode uses sync-only mailbox operations;
	// live-session mode uses async-only. The bypass is safe for O_APPEND writes
	// on POSIX (the mailbox append path).
	// ST-3-FIX: consult fileSyncLockHeldByUs (SYNC-only) — NOT fileLockHeldByUs.
	// Previously this checked fileLockHeldByUs, which withFileLockAsync ALSO
	// populates (~line 536), so a SECOND concurrent ASYNC caller for the same
	// file saw the FIRST async caller's hold and bypassed BOTH the in-process
	// promise chain AND the on-disk .flock → broke async↔async mutual exclusion.
	// Checking the SYNC-only set restores async↔async serialization while
	// preserving sync↔async deadlock prevention.
	if (fileSyncLockHeldByUs.has(lockFile)) {
		return await fn();
	}
	// Merge with the parent context's held set so nested DIFFERENT-path locks
	// also bypass correctly (prevents cross-path deadlock, matching withRunLock).
	const prevHeld = fileAsyncLockCtx.getStore() ?? new Set<string>();
	const held = new Set(prevHeld);
	held.add(lockFile);
	const prev = fileAsyncLocks.get(lockFile) ?? Promise.resolve();
	// Chain fn after the previous holder. `next` may reject (propagating to the
	// caller), but `stored` never rejects so subsequent waiters aren't blocked.
	// fn() is wrapped in fileAsyncLockCtx.run so nested same-context calls see
	// `held` and bypass the promise chain (re-entrant), while cross-context
	// callers chain normally via `prev`.
	const next = prev.then(() =>
		fileAsyncLockCtx.run(held, async () => {
			// ST-3: cross-process tier — acquire the on-disk .flock so that a
			// concurrent process (sync append, reply-rewrite) cannot interleave.
			// acquireLockWithRetryAsync uses `await sleep` (timer), NOT sleepSync,
			// so the event loop is not blocked during contention.
			if (!isSymlinkSafePath(path.dirname(lockFile))) throw new Error("Refusing: parent of lock directory is a symlink");
			fs.mkdirSync(path.dirname(lockFile), { recursive: true });
			const token = await acquireLockWithRetryAsync(lockFile, DEFAULT_STALE_MS, "file");
			// Register in fileLockHeldByUs so a concurrent withFileLockSync in
			// THIS process detects our hold and bypasses (prevents sleepSync
			// deadlock). See the bypass check at the top of this function.
			fileLockHeldByUs.set(lockFile, token);
			try {
				return await fn();
			} finally {
				fileLockHeldByUs.delete(lockFile);
				releaseLock(lockFile, token);
			}
		}),
	);
	const stored = next.then(
		() => undefined,
		() => undefined,
	);
	fileAsyncLocks.set(lockFile, stored);
	try {
		return await next;
	} finally {
		// Compare-and-delete: only remove our entry if it still points at `stored`.
		// With 3+ overlapping callers, an earlier caller's finally would otherwise
		// delete a later caller's promise, breaking mutual exclusion.
		if (fileAsyncLocks.get(lockFile) === stored) {
			fileAsyncLocks.delete(lockFile);
		}
	}
}

/**
 * SYNC run-lock — FILE-LOCK-ONLY by design (U21): a socket listen cannot be
 * awaited from a synchronous path, so the process-socket supplement of
 * `withRunLock` does not apply here. Mutual exclusion between sync and async
 * holders is still guaranteed by the SHARED file lock (an async holder always
 * takes the file lock first, before its socket supplement).
 */
export function withRunLockSync<T>(manifest: TeamRunManifest, fn: () => T, options: RunLockOptions = {}): T {
	const filePath = lockPath(manifest);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	// H-1: re-entrance check is scoped to the current async context, not process-global.
	// A call from a DIFFERENT async context (e.g. a child-stdout event handler that
	// runs while an async holder is awaiting) sees no held set and properly serializes.
	if (lockCtx.getStore()?.has(filePath)) {
		// Re-entrant within the same async context — already hold this lock.
		return fn();
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const token = acquireLockWithRetry(filePath, staleMs, "run");
	// RR-011 (F02): register the hold so async contenders of this process see a
	// LIVE holder (wait) instead of a stealable corpse. Sync here too, keeping the
	// invariant uniform for every run-lock acquisition of this process.
	runLockHeldTokens.add(token);
	const prevHeld = lockCtx.getStore() ?? new Set<string>();
	const newHeld = new Set(prevHeld);
	newHeld.add(filePath);
	// Enter a new async context (or extend the current one) carrying the held set.
	// On exit (sync return OR async resume after an awaited child), the context is
	// restored — so the held set only contains locks acquired within fn()'s subtree.
	return lockCtx.run(newHeld, () => {
		try {
			return fn();
		} finally {
			// RR-011 (F02): unregister BEFORE releasing (see runLockHeldTokens
			// invariant) — the token must not linger as "live" once the hold ends.
			// releaseOwnLock is token-guarded: if our lock was superseded in the
			// meantime, the current holder's file is left untouched.
			runLockHeldTokens.delete(token);
			releaseOwnLock(filePath, token);
		}
	});
}

/**
 * ASYNC run-lock — U21 (2026-10-13) DUAL GUARD: the existing file lock
 * (acquired FIRST — WAIT/backoff admission of D1 / RR-011 unchanged) is
 * SUPPLEMENTED by a kernel process socket owned for the holder's process
 * lifetime (see `acquireRunLockGuarded`). The supplement guards against
 * dual-process entry where O_EXCL file locks are weak (NFS etc.); it is
 * toggled by PI_CREW_RUN_LOCK_SOCKET (default ON, `'0'` = pre-U21 behaviour
 * bit-for-bit). All six file-lock semantics (re-entrance, token release,
 * live-in-process WAIT, stale-steal + WARN, EPERM, ENOENT) are unchanged and
 * live in the file tier; the re-entrance bypass below returns BEFORE any
 * socket acquisition, so nested same-context calls never self-deadlock on
 * the kernel socket. Release order: socket FIRST, file token LAST.
 */
export async function withRunLock<T>(manifest: TeamRunManifest, fn: () => Promise<T>, options: RunLockOptions = {}): Promise<T> {
	const filePath = lockPath(manifest);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	if (lockCtx.getStore()?.has(filePath)) {
		// Re-entrant within the same async context.
		return await fn();
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const { token, socket } = await acquireRunLockGuarded(filePath, staleMs);
	// RR-011 (F02): register the hold IMMEDIATELY (no await between the acquire
	// returning and this add — otherwise a concurrent contender could observe the
	// fresh on-disk token as a stealable corpse). Deleted in the finally below.
	runLockHeldTokens.add(token);
	const prevHeld = lockCtx.getStore() ?? new Set<string>();
	const newHeld = new Set(prevHeld);
	newHeld.add(filePath);
	// AsyncLocalStorage propagates across await boundaries, so any code that
	// resumes after an await inside fn() (including microtasks, timers, and
	// awaited child Pi results) still sees newHeld.
	return await lockCtx.run(newHeld, async () => {
		try {
			return await fn();
		} finally {
			// RR-011 (F02): see withRunLockSync above — unregister the live token
			// BEFORE the token-guarded releaseOwnLock (runLockHeldTokens invariant).
			runLockHeldTokens.delete(token);
			// U21: release the socket BEFORE the file token — a contender whose
			// file-acquire already succeeded on the weak-file tier then sees the
			// socket free only after BOTH guards of the previous holder are gone;
			// the file stays held (by us) until the socket is fully released.
			// FIX (review round): if socket.release() rejects, releaseOwnLock must
			// still run — otherwise our own file token leaks on disk as a live lock.
			try {
				if (socket) await socket.release();
			} finally {
				releaseOwnLock(filePath, token);
			}
		}
	});
}
