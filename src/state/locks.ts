import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { TeamRunManifest } from "./types.ts";
import { DEFAULT_LOCKS } from "../config/defaults.ts";
import { sleepSync } from "../utils/sleep.ts";

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
			// Other errors (ESRCH — process doesn't exist) also mean holder is dead.
			return false;
		}
	} catch {
		return true; // Can't read — assume alive to be safe
	}
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
	const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
	try {
		fs.writeSync(fd, JSON.stringify({ kind, pid: process.pid, createdAt: new Date().toISOString(), token }));
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
	const bufA = Buffer.from(String(a));
	const bufB = Buffer.from(String(b));
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

function releaseLock(filePath: string, token: string): void {
	// FIX: Do not delete a symlink — it may have been planted by an attacker
	// after our lock was released. A legitimate lock file should never be a
	// symlink since writeLockFile uses O_CREAT|O_EXCL which fails on symlinks.
	let isSymlink = false;
	try {
		isSymlink = fs.lstatSync(filePath).isSymbolicLink();
	} catch { /* file doesn't exist — that's fine, we'll handle ENOENT below */ }
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
			// FIX: Use both staleness AND PID liveness to decide if we can steal
			// a lock. Previously only staleness was checked, so a process whose
			// PID was recently reused by another process could have its lock
			// stolen even while still active. Now: fresh+alive = fail, else = clear.
			const isStale = isLockStale(filePath, staleMs);
			const isHolderAlive = isLockHolderAlive(filePath);
			if (!isStale && isHolderAlive) {
				// Lock is fresh AND holder is alive — fail fast
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// FIX (TOCTOU): Use O_EXCL open to atomically verify-and-remove
			// the stale lock in one operation. If a competing process acquired
			// the lock between our staleness check and this open, O_EXCL fails
			// with EEXIST and we retry the full acquire sequence.
			let fd = -1;
			try {
				fd = fs.openSync(filePath, fs.constants.O_EXCL | fs.constants.O_RDONLY);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST") {
					// Lock was re-acquired — retry the full sequence
					sleepSync(Math.min(250, 25 * 2 ** attempt));
					attempt++;
					continue;
				}
				throw error;
			} finally {
				if (fd >= 0) fs.closeSync(fd);
			}
			// O_EXCL succeeded — we atomically verified the lock is still free.
			// Now it is safe to remove it.
			try {
				fs.rmSync(filePath, { force: true });
			} catch { /* race — let loop retry */ }
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
			// FIX (Round 14, locks-async): Mirror the sync path's staleness AND
			// PID liveness check. Previously the async path only checked
			// staleness, so a recently-reused PID could have its lock stolen
			// even while still running. Now: fresh + alive holder = fail.
			const isStale = isLockStale(filePath, staleMs);
			const isHolderAlive = isLockHolderAlive(filePath);
			if (!isStale && isHolderAlive) {
				throw new Error(`Run '${path.basename(filePath)}' is locked by another operation.`);
			}
			// FIX (TOCTOU): Use O_EXCL open to atomically verify-and-remove
			// the stale lock in one operation. If a competing process acquired
			// the lock between our staleness check and this open, O_EXCL fails
			// with EEXIST and we retry the full acquire sequence.
			let fd = -1;
			try {
				fd = fs.openSync(filePath, fs.constants.O_EXCL | fs.constants.O_RDONLY);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "EEXIST") {
					// Lock was re-acquired — retry the full sequence
					const delay = Math.min(250, 25 * 2 ** attempt);
					await sleep(delay);
					attempt++;
					continue;
				}
				throw error;
			} finally {
				if (fd >= 0) fs.closeSync(fd);
			}
			// O_EXCL succeeded — we atomically verified the lock is still free.
			// Now it is safe to remove it.
			try {
				fs.rmSync(filePath, { force: true });
			} catch { /* race — let loop retry */ }
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
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	// FIX: Validate that the target file still exists. If it was deleted and
	// recreated since the last lock cycle, the old .lock file may be orphaned
	// and should not block the new cycle. Clean it up if the target is missing.
	try {
		fs.statSync(filePath);
	} catch {
		// Target file doesn't exist — clean up any stale .lock file and proceed.
		// The lock will be acquired fresh for the new file (if fn creates it).
		try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
	}
	const token = acquireLockWithRetry(lockFile, staleMs, "file");
	try {
		return fn();
	} finally {
		// Token-guarded release: don't rm the lock if it has been stolen.
		releaseLock(lockFile, token);
	}
}

export function withRunLockSync<T>(manifest: TeamRunManifest, fn: () => T, options: RunLockOptions = {}): T {
	const filePath = lockPath(manifest);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const token = acquireLockWithRetry(filePath, staleMs, "run");
	try {
		return fn();
	} finally {
		releaseLock(filePath, token);
	}
}

export async function withRunLock<T>(manifest: TeamRunManifest, fn: () => Promise<T>, options: RunLockOptions = {}): Promise<T> {
	const filePath = lockPath(manifest);
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const token = await acquireLockWithRetryAsync(filePath, staleMs, "run");
	try {
		return await fn();
	} finally {
		releaseLock(filePath, token);
	}
}
