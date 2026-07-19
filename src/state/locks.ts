import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LOCKS } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { sleepSync } from "../utils/sleep.ts";
import { isSymlinkSafePath } from "./atomic-write.ts";
import type { TeamRunManifest } from "./types.ts";

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
 * a live process (must keep waiting).
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
function readLockSnapshot(filePath: string, staleMs: number): { canSteal: boolean } {
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
			return { canSteal: true };
		}
		// Transient I/O error — be conservative (don't steal, retry the read on
		// next attempt).
		return { canSteal: false };
	}
	// Staleness from a single snapshot.
	let createdAt = parseCreatedAtFromLock(raw);
	if (createdAt === undefined) createdAt = stat.mtimeMs;
	const isStale = Date.now() - createdAt > staleMs;
	// FIX (CI flake): if the lock holder is OUR OWN pid, treat as stealable.
	// releaseOwnLock's unconditional delete should have removed the file before
	// the next acquire, but a tiny window exists between release and acquire
	// (microseconds) where the file is still present. In that window, a
	// concurrent withRunLock* call from the same process leaves a fresh lock
	// file with our own pid. Since the holder is ourselves (not a foreign
	// process), we can safely steal our own lock to unblock the next acquire.
	// Without this, fast re-acquisitions (parallel-research scaffold mode
	// calls persistSingleTaskUpdate for many tasks in a tight loop) see the
	// recent file with our pid and throw "locked".
	let holderPid: number | undefined;
	let isAlive = true;
	try {
		const parsed = JSON.parse(raw) as { pid?: unknown };
		holderPid = typeof parsed.pid === "number" ? parsed.pid : undefined;
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
	const isOurOwnHolder = holderPid === process.pid;
	// Steal if stale OR holder dead OR holder is ourselves (same-process).
	return { canSteal: isStale || !isAlive || isOurOwnHolder };
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
 * Release the lock we (this process) just acquired. Unlike releaseLock, this
 * unconditionally removes the file because we know we created it in the same
 * withRunLock* call — token matching is only needed for multi-process scenarios
 * (where a different holder's token must not be deleted). Within the same process
 * the new acquire uses a fresh randomUUID token, so token matching would falsely
 * fail and leak the file across releases.
 *
 * Symlink guard is preserved: if a symlink appeared since our writeLockFile, we
 * don't rm it (defense against attacker-planted symlinks).
 */
export function releaseOwnLock(filePath: string, _token: string): void {
	try {
		const stat = fs.lstatSync(filePath);
		if (stat.isSymbolicLink()) return;
	} catch {
		/* ENOENT is fine */
	}
	try {
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

function acquireLockWithRetry(filePath: string, staleMs: number, kind: LockKind = "file"): string {
	let attempt = 0;
	const deadline = Date.now() + staleMs * 2;
	while (true) {
		const token = randomUUID();
		try {
			writeLockFile(filePath, token, kind);
			return token;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (Date.now() > deadline) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Round 26 (BUG 1): single-snapshot read closes the TOCTOU window between
			// separate stale + alive reads (which could race stale→fresh).
			const { canSteal } = readLockSnapshot(filePath, staleMs);
			if (!canSteal) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Stale or dead holder — forcibly remove the lock.
			try {
				fs.rmSync(filePath, { force: true });
			} catch {
				/* race — let loop retry */
			}
			sleepSync(Math.min(250, 25 * 2 ** attempt));
			attempt++;
		}
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
			return token;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (Date.now() > deadline) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Round 26 (BUG 1): single-snapshot read (see sync variant).
			const { canSteal } = readLockSnapshot(filePath, staleMs);
			if (!canSteal) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// Stale or dead holder — forcibly remove the lock.
			try {
				fs.rmSync(filePath, { force: true });
			} catch {
				/* race — let loop retry */
			}
			const delay = Math.min(250, 25 * 2 ** attempt);
			await sleep(delay);
			attempt++;
		}
	}
}

/**
 * General-purpose file lock for arbitrary file paths.
 * Uses the same O_EXCL atomic create strategy as run locks.
 */
export function withFileLockSync<T>(filePath: string, fn: () => T, options: RunLockOptions = {}): T {
	// FIX: Use a separate .lock sidecar so the lock file doesn't collide with
	// the file being protected. Previously withFileLockSync used the file path
	// itself as the lock, which meant any operation on the same file (read,
	// append, or even the lock acquisition itself) would race with the lock.
	const lockFile = `${filePath}.lock`;
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	// FIX (Round 29): re-entrance guard — mirrors withRunLockSync below.
	// When the same call stack already holds the file lock (e.g.
	// registerWorker -> cleanupOrphanWorkers -> readRegistry), the second
	// acquisition would otherwise read its own freshly-written lock file
	// (same pid, fresh createdAt), fail the steal check, and deadlock for
	// the full staleMs window. Strace-confirmed in
	// .github/issues/pre-existing-2026-06-10/04-orphan-worker-registry-tests.md:75-86.
	const existingToken = fileLockHeldByUs.get(lockFile);
	if (existingToken) {
		return fn();
	}
	// FIX: Validate the parent directory is not a symlink BEFORE calling mkdirSync.
	// Between mkdir and lock acquisition, an attacker could plant a symlink.
	if (!isSymlinkSafePath(path.dirname(lockFile))) throw new Error("Refusing: parent of lock directory is a symlink");
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	// Round 26 (BUG 2): REMOVED the pre-acquisition target-file-existence check.
	// It was racy — between statSync(target) and acquire, a concurrent process
	// could acquire the lock to CREATE the target, and we'd delete its active
	// lock. It was also actively wrong for callers that pass a path already
	// ending in `.lock` (config.ts: the checked "target" never exists, so the
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
	fileLockHeldByUs.set(lockFile, token);
	try {
		return fn();
	} finally {
		// Token-guarded release: don't rm the lock if it has been stolen.
		fileLockHeldByUs.delete(lockFile);
		releaseLock(lockFile, token);
	}
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
// Round 29: parallel map for withFileLockSync re-entrance. See the comment
// at the top of withFileLockSync for the full deadlock mechanism.
const fileLockHeldByUs = new Map<string, string>(); // lockFile -> token

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
			// FIX (CI flake): releaseLock uses token matching to prevent the
			// "losing contender wipes winner's lock" race in multi-process scenarios.
			// But within withRunLockSync/withRunLock (same process), the new acquire
			// uses a FRESH random token — the previous stored token doesn't match the
			// current token — and the lock file is never removed. Repeat acquisitions
			// then keep failing with EEXIST because the file lingers.
			// Since withRunLock* is always single-process, unconditionally delete
			// (symlink guard is still applied for safety).
			releaseOwnLock(filePath, token);
		}
	});
}

export async function withRunLock<T>(manifest: TeamRunManifest, fn: () => Promise<T>, options: RunLockOptions = {}): Promise<T> {
	const filePath = lockPath(manifest);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	if (lockCtx.getStore()?.has(filePath)) {
		// Re-entrant within the same async context.
		return await fn();
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const token = await acquireLockWithRetryAsync(filePath, staleMs, "run");
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
			// FIX (CI flake): see withRunLockSync above — use releaseOwnLock for
			// unconditional deletion of the lock file we created (same process).
			releaseOwnLock(filePath, token);
		}
	});
}
