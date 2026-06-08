import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";
import { sleepSync } from "../utils/sleep.ts";

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

/**
 * Symlink-safe file write guard (caveman-inspired).
 * Returns true if the path is safe to write, false if it's a symlink or
 * inside a symlinked directory owned by another user.
 *
 * This walks the full ancestor chain to detect any symlinks in the path,
 * preventing attacks where an intermediate ancestor is a symlink.
 *
 * Platform note: The ownership verification (via process.getuid) is only
 * available on Unix-like platforms (Linux, macOS). On Windows or other
 * platforms where getuid is unavailable, the ownership check is skipped
 * and only symlink detection is performed. This means symlink safety
 * verification is weaker on non-Unix platforms. Consider using
 * platform-specific ownership verification (e.g., icacls on Windows)
 * for stronger guarantees on those platforms.
 *
 * Design note: Ownership verification (getuid/getgid) is only performed
 * when a path component is itself a symlink. For paths where all
 * components are regular directories, no ownership verification occurs.
 * This is intentional: an attacker who can create directories within
 * baseDir could exploit this, but this is mitigated by the boundary
 * check (realDir.startsWith(baseDir + path.sep)). In the pi-crew
 * context, baseDir is always within the user's own pi-crew state
 * directory tree (userPiRoot), so this is a low-risk design choice.
 * Callers must ensure baseDir is always inside a protected user
 * directory and never in a shared or world-writable location.
 */
export function isSymlinkSafePath(filePath: string): boolean {
	try {
		// Issue 3 fix: track the original baseDir for boundary verification after symlink resolution
		const baseDir = path.dirname(filePath);
		// Walk the full ancestor chain to detect any symlinks
		let currentPath = filePath;
		while (currentPath !== path.dirname(currentPath)) {
			const dir = path.dirname(currentPath);
			try {
				const dirStat = fs.lstatSync(dir);
				if (dirStat.isSymbolicLink()) {
					// Resolve and verify ownership on Unix
					const realDir = fs.realpathSync(dir);
					// Issue 3 fix: verify resolved path stays within the original baseDir boundary
					if (!realDir.startsWith(baseDir + path.sep) && realDir !== baseDir) return false;
					const realStat = fs.statSync(realDir);
					if (!realStat.isDirectory()) return false;
					if (typeof process.getuid === "function" && realStat.uid !== process.getuid()) return false;
				}
			} catch (err) {
				// Directory doesn't exist yet — that's OK, mkdirSync will create it.
				// For permission errors (EACCES, EPERM), we cannot verify the path
				// is safe, so treat it as unsafe rather than returning true.
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					// OK - directory doesn't exist yet
				} else if (code === "EACCES" || code === "EPERM") {
					// Permission error - cannot verify path is safe
					logInternalError("isSymlinkSafePath.lstat.permission", err, `dir=${dir}`);
					return false;
				} else {
					// Other errors - log but continue (better to be conservative)
					logInternalError("isSymlinkSafePath.lstat", err, `dir=${dir}`);
				}
			}
			currentPath = dir;
		}

		// Check if target file itself is a symlink
		try {
			const fileStat = fs.lstatSync(filePath);
			if (fileStat.isSymbolicLink()) return false;
		} catch {
			// File doesn't exist yet — that's OK
		}

		return true;
	} catch {
		return false;
	}
}



function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRenameError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && RETRYABLE_RENAME_CODES.has(String((error as NodeJS.ErrnoException).code)));
}

export function renameWithRetry(tempPath: string, filePath: string, retries = 8, rename: (oldPath: string, newPath: string) => void = fs.renameSync): void {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			rename(tempPath, filePath);
			return;
		} catch (error) {
			lastError = error;
			if (!isRetryableRenameError(error) || attempt === retries) break;
			// 3.4: exponential backoff with ±20% jitter, capped at 500ms.
			// Without jitter, multiple processes contending on the same file
			// retry in lockstep and starve each other.
			const base = Math.min(500, 10 * 2 ** attempt);
			const jitter = base * 0.2 * (Math.random() * 2 - 1);
			sleepSync(Math.max(1, Math.round(base + jitter)));
		}
	}
	throw lastError;
}

/** Test alias for renameWithRetry. */
export const __test__renameWithRetry = renameWithRetry;

export async function renameWithRetryAsync(tempPath: string, filePath: string, retries = 8, rename: (oldPath: string, newPath: string) => Promise<void> = (source, destination) => fs.promises.rename(source, destination)): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			await rename(tempPath, filePath);
			return;
		} catch (error) {
			lastError = error;
			if (!isRetryableRenameError(error) || attempt === retries) break;
			// 3.4: same jitter as renameWithRetry.
			const base = Math.min(500, 10 * 2 ** attempt);
			const jitter = base * 0.2 * (Math.random() * 2 - 1);
			await sleep(Math.max(1, Math.round(base + jitter)));
		}
	}
	throw lastError;
}

/** Test alias for renameWithRetryAsync. */
export const __test__renameWithRetryAsync = renameWithRetryAsync;

export function atomicWriteFile(filePath: string, content: string, expectedHash?: string): void {
	if (!isSymlinkSafePath(filePath)) throw new Error(`Refusing to write: target is a symlink or inside untrusted directory: ${filePath}`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	// Write temp with restrictive permissions
	const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	try {
		const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
		// Post-open verification: on Windows O_NOFOLLOW is 0, so verify FD is a regular file
		const openedStat = fs.fstatSync(fd);
		if (!openedStat.isFile()) {
			fs.closeSync(fd);
			throw new Error(`Refusing to write: opened path is not a regular file: ${tempPath}`);
		}
		fs.writeSync(fd, content, undefined, "utf-8");
		fs.closeSync(fd);
		try {
			renameWithRetry(tempPath, filePath);
		} catch (renameError) {
			// H3 fix: re-check symlink safety before fallback.
			// Between isSymlinkSafePath at top and rename attempt, the file
			// could have been replaced with a symlink (TOCTOU). Refuse if so.
			try {
				const lstat = fs.lstatSync(filePath);
				if (lstat.isSymbolicLink()) {
					try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
					throw renameError;
				}
			} catch (checkError) {
				// Only ENOENT / ENOTDIR means the file genuinely doesn't exist — safe to proceed.
				// Re-throw everything else (EACCES, EPERM, EBUSY, etc.)
				const code = (checkError as NodeJS.ErrnoException).code;
				if (code !== "ENOENT" && code !== "ENOTDIR") {
					throw checkError;
				}
			}
			// Issue 2 fix: do NOT fall back to non-atomic writeFileSync.
			// The rename failed after retries — throw the error rather than
			// risking data corruption via a non-atomic write. Callers should
			// handle this error or use a different strategy for contended files.
			try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
			throw renameError;
		}
	} catch (error) {
		// Issue 2 fix: wrap content-match read in nested try-catch that always
		// cleans up the temp file before re-throwing, preventing orphaned temps.
		//
		// Content-match fallback: best-effort only — if a concurrent writer
		// modified the file between the fallback write and this read, the
		// comparison may not reflect what was actually written. Treat this as
		// a hint rather than a guarantee of atomicity.
		let matches = false;
		try {
			const existing = fs.readFileSync(filePath, "utf-8");
			matches = existing === content;
		} catch (readError) {
			// Clean up temp file before re-throwing, then re-throw the original error
			try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
			throw error;
		}
		if (matches) {
			try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
			return;
		}
		try {
			fs.rmSync(tempPath, { force: true });
		} catch (cleanupError) {
			logInternalError("atomic-write.cleanup", cleanupError, `tempPath=${tempPath}`);
		}
		throw error;
	}
}


export async function atomicWriteFileAsync(filePath: string, content: string): Promise<void> {
	if (!isSymlinkSafePath(filePath)) throw new Error(`Refusing to write: target is a symlink or inside untrusted directory: ${filePath}`);
	await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	try {
		const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
		const fd = await fs.promises.open(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
		// Post-open verification: on Windows O_NOFOLLOW is 0, so verify FD is a regular file
		const openedStat = await fd.stat();
		if (!openedStat.isFile()) {
			await fd.close();
			throw new Error(`Refusing to write: opened path is not a regular file: ${tempPath}`);
		}
		await fd.writeFile(content, "utf-8");
		await fd.close();
		try {
			await renameWithRetryAsync(tempPath, filePath);
		} catch (renameError) {
			let matches = false;
			try {
				const existing = await fs.promises.readFile(filePath, "utf-8");
				matches = existing === content;
			} catch {
				/* ignore */
			}
			if (matches) {
				try {
					await fs.promises.rm(tempPath, { force: true });
				} catch (cleanupError) {
					logInternalError("atomic-write.cleanupAsync", cleanupError, `tempPath=${tempPath}`);
				}
				return;
			}
			throw renameError;
		}
	} catch (error) {
		try {
			await fs.promises.rm(tempPath, { force: true });
		} catch (cleanupError) {
			logInternalError("atomic-write.cleanupAsync", cleanupError, `tempPath=${tempPath}`);
		}
		throw error;
	}
}


export function atomicWriteJson<T>(filePath: string, value: T): void {
	atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export async function atomicWriteJsonAsync<T>(filePath: string, value: T): Promise<void> {
	await atomicWriteFileAsync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// 2.1 — atomic-write coalescer. Buffer the latest payload per filePath and
// flush after `coalesceMs` ms (default 50). Multiple writes to the same
// path within the window collapse to one disk write (last value wins),
// which is exactly the semantic that team-runner.ts merge loops need for
// `saveRunTasks` and similar high-frequency state-store paths.
//
// Caveat: a `readJsonFile` call between buffer and flush sees the previous
// on-disk content. Callers that need read-after-write within the window
// must invoke `flushPendingAtomicWrites()` first (or pass through
// `atomicWriteJson` which flushes synchronously).
//
// Auto-flush hooks: process exit / SIGTERM / SIGINT, plus an exposed
// `flushPendingAtomicWrites()` for cleanupRuntime.
interface CoalescedAtomicWrite {
	content: string;
	timer: ReturnType<typeof setTimeout>;
}
const pendingAtomicWrites = new Map<string, CoalescedAtomicWrite>();
const DEFAULT_ATOMIC_COALESCE_MS = 50;

// Issue 1 fix: guard against concurrent AND re-entrant flushes using depth counter
let flushInProgress = 0;

export function atomicWriteJsonCoalesced<T>(filePath: string, value: T, coalesceMs = DEFAULT_ATOMIC_COALESCE_MS): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const previous = pendingAtomicWrites.get(filePath);
	if (previous) clearTimeout(previous.timer);
	const timer = setTimeout(() => flushOnePendingAtomicWrite(filePath), coalesceMs);
	timer.unref();
	pendingAtomicWrites.set(filePath, { content, timer });
}

function flushOnePendingAtomicWrite(filePath: string): void {
	const entry = pendingAtomicWrites.get(filePath);
	if (!entry) return;
	// Issue 2 fix: Remove entry ONLY after successful flush.
	// If flush fails, keep the entry so the next flush (or process exit)
	// can retry. This prevents silent data loss when writes fail.
	clearTimeout(entry.timer);
	try {
		atomicWriteFile(filePath, entry.content);
		// Issue 2 fix: Verify this entry is still the current one before deleting.
		// A concurrent write may have replaced entry with a newer one during the flush.
		// Only delete if pendingAtomicWrites.get(filePath) === entry (not a newer entry).
		// This prevents orphaning newer entries that arrived during the flush.
		if (pendingAtomicWrites.get(filePath) === entry) {
			pendingAtomicWrites.delete(filePath);
		}
	} catch (error) {
		logInternalError("atomic-write.coalesced-flush", error, filePath);
		// Failure: keep entry for retry. The timer was already cleared
		// so a new timer will be set on the next write to this path.
	}
}

/** Flush every queued coalesced write synchronously. Safe to call any time. */
export function flushPendingAtomicWrites(): void {
	if (flushInProgress > 0) return;
	flushInProgress++;
	try {
		for (const filePath of [...pendingAtomicWrites.keys()]) flushOnePendingAtomicWrite(filePath);
	} finally {
		flushInProgress--;
	}
}

// Defense-in-depth: signal handlers must return immediately.
// Use setImmediate so the handler exits before any sync I/O runs.
// This prevents the main thread from being blocked if a signal
// arrives while the user is idle in the terminal.
process.on("exit", () => flushPendingAtomicWrites());
process.on("SIGTERM", () => setImmediate(() => flushPendingAtomicWrites()));
process.on("SIGINT", () => setImmediate(() => flushPendingAtomicWrites()));

export function readJsonFile<T>(filePath: string): T | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			logInternalError("readJsonFile", err, `filePath=${filePath}`);
		}
		return undefined;
	}
}
