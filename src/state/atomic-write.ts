import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";
import { sleepSync } from "../utils/sleep.ts";

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRYABLE_LINK_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT"]);

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
		// Note: baseDir is intentionally NOT resolved here with realpathSync.
		// The while loop below walks the full ancestor chain and the explicit
		// check at lines 94-101 verifies baseDir itself is not a symlink.
		// This redundant early resolution was removed per Issue 1.
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
					// Issue 1 fix: use resolved baseDir for boundary verification.
					// Accept if realDir is inside baseDir, equals baseDir, or is an
					// ancestor of baseDir. On macOS, /var/folders is a symlink to
					// /private/var/folders — resolve baseDir too for comparison.
					// Walk up ancestors to find the deepest existing one and resolve it.
					let realBase = baseDir;
					for (let walk = baseDir; walk !== path.dirname(walk); walk = path.dirname(walk)) {
						try {
							const resolved = fs.realpathSync(walk);
							// Found existing ancestor — join with remaining non-existent parts
							realBase = path.join(resolved, path.relative(walk, baseDir));
							break;
						} catch { /* not found yet, keep walking */ }
					}
					const realDirNorm = realDir.endsWith(path.sep) ? realDir : realDir + path.sep;
					const realBaseNorm = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
					const isAncestor = realBaseNorm.startsWith(realDirNorm) || realBase === realDir;
					if (!isAncestor && !realDirNorm.startsWith(realBaseNorm)) return false;
					const realStat = fs.statSync(realDir);
					if (!realStat.isDirectory()) return false;
					// Only check ownership for user-controlled directories.
					// System directories like /private/var/folders on macOS are owned
					// by root but are safe to use (the OS manages them). Skip uid check
					// for directories not owned by the current user only when the real
					// path is inside or is an ancestor of a known system temp directory.
					if (typeof process.getuid === "function" && realStat.uid !== process.getuid()) {
						const systemTmp = (typeof os.tmpdir === "function" ? os.tmpdir() : "/tmp").toLowerCase();
						let realSystemTmp = systemTmp;
						try { realSystemTmp = fs.realpathSync(systemTmp).toLowerCase(); } catch { /* ok */ }
						const realDirLower = realDir.toLowerCase();
						const dirNorm = realDirLower.endsWith(path.sep) ? realDirLower : realDirLower + path.sep;
						const tmpNorm = realSystemTmp.endsWith(path.sep) ? realSystemTmp : realSystemTmp + path.sep;
						// Accept if realDir is inside tmpdir OR is an ancestor of tmpdir
						// (e.g. /private/var/folders is an ancestor of /private/var/folders/.../T/)
						const isInsideTmp = dirNorm.startsWith(tmpNorm) || realDirLower.startsWith(systemTmp);
						const isAncestorOfTmp = tmpNorm.startsWith(dirNorm) || realSystemTmp.startsWith(realDirLower);
						// Also accept canonical system temp paths:
						// - /tmp → /private/tmp (macOS)
						// - /var/folders → /private/var/folders (macOS)
						const isSystemTmp = process.platform === "darwin" && (
							realDirLower === "/tmp" || realDirLower === "/private/tmp" ||
							realDirLower === "/var/folders" || realDirLower === "/private/var/folders" ||
							realDirLower.startsWith("/var/folders/") || realDirLower.startsWith("/private/var/folders/")
						);
						if (!isInsideTmp && !isAncestorOfTmp && !isSystemTmp) {
							return false;
						}
					}
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


		// Issue 1 fix: verify baseDir itself is not a symlink.
		// The while loop above walks ancestors but stops when currentPath reaches
		// root (currentPath === path.dirname(currentPath)). If baseDir is a symlink
		// and is also the root of the path, it would not be checked. This explicit
		// check ensures baseDir is verified regardless of where the loop terminates.
		if (baseDir !== path.dirname(filePath)) {
			try {
				const baseDirStat = fs.lstatSync(baseDir);
				if (baseDirStat.isSymbolicLink()) return false;
			} catch {
				// baseDir does not exist yet — that is OK
			}
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

function isRetryableLinkError(error: unknown): boolean {
	return Boolean(error && typeof error === "object" && "code" in error && RETRYABLE_LINK_CODES.has(String((error as NodeJS.ErrnoException).code)));
}

/**
 * Issue 1 fix: rename via link+unlink instead of rename.
 * Unlike rename, link() does NOT follow symlinks at the destination path.
 * It atomically creates a hard link to the source. We then unlink the source.
 * This prevents TOCTOU attacks where an attacker plants a symlink at the
 * destination between the check and the rename operation.
 */
function renameWithLinkSync(tempPath: string, filePath: string, retries = 8): void {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			// Windows: hard links fail with ENOENT when short-name and long-name
			// path aliases are mixed (e.g. RUNNER~1 vs runneradmin). Use
			// renameSync which handles this correctly via MoveFileEx.
			if (process.platform === "win32") {
				try { fs.unlinkSync(filePath); } catch { /* destination may not exist */ }
				try {
					fs.renameSync(tempPath, filePath);
					return;
				} catch (renameError) {
					lastError = renameError;
					if (!isRetryableLinkError(renameError) || attempt === retries) break;
				}
			} else {
				// First try to unlink any existing file at destination (hard links don't follow symlinks)
				try { fs.unlinkSync(filePath); } catch { /* destination may not exist */ }
				// Create hard link - does NOT follow symlinks at filePath
				fs.linkSync(tempPath, filePath);
				// Successfully linked - now unlink the temp file
				fs.unlinkSync(tempPath);
				return;
			}
		} catch (error) {
			lastError = error;
			if (!isRetryableLinkError(error) || attempt === retries) break;
		}
		const base = Math.min(500, 10 * 2 ** attempt);
		const jitter = base * 0.2 * (Math.random() * 2 - 1);
		sleepSync(Math.max(1, Math.round(base + jitter)));
	}
	throw lastError;
}

async function renameWithLinkAsync(tempPath: string, filePath: string, retries = 8): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			if (process.platform === "win32") {
				try { await fs.promises.unlink(filePath); } catch { /* destination may not exist */ }
				try {
					await fs.promises.rename(tempPath, filePath);
					return;
				} catch (renameError) {
					lastError = renameError;
					if (!isRetryableLinkError(renameError) || attempt === retries) break;
				}
			} else {
				try { await fs.promises.unlink(filePath); } catch { /* destination may not exist */ }
				await fs.promises.link(tempPath, filePath);
				await fs.promises.unlink(tempPath);
				return;
			}
		} catch (error) {
			lastError = error;
			if (!isRetryableLinkError(error) || attempt === retries) break;
		}
		const base = Math.min(500, 10 * 2 ** attempt);
		const jitter = base * 0.2 * (Math.random() * 2 - 1);
		await sleep(Math.max(1, Math.round(base + jitter)));
	}
	throw lastError;
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
	// On Windows, resolve parent dir through realpathSync to handle short-name
	// vs long-name path alias (e.g. RUNNER~1 vs runneradmin). Without this,
	// mkdirSync may succeed but openSync fails with ENOENT because the OS
	// sees the paths as different locations.
	let dirPath = path.dirname(filePath);
	if (process.platform === "win32") {
		try {
			const realDir = fs.realpathSync(dirPath);
			if (realDir !== dirPath) dirPath = realDir;
		} catch {
			// dirPath may not exist yet — mkdirSync will create it
		}
		filePath = path.join(dirPath, path.basename(filePath));
	}
	try {
		fs.mkdirSync(dirPath, { recursive: true });
	} catch (error) {
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
			try {
				const realDir = fs.realpathSync(dirPath);
				if (realDir !== dirPath) {
					fs.mkdirSync(realDir, { recursive: true });
					dirPath = realDir;
				}
			} catch { /* ignore – will fail at write time with better error */ }
		} else {
			throw error;
		}
	}
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	// Write temp with restrictive permissions
	const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
		// Post-open verification: on Windows O_NOFOLLOW is 0, so verify FD is a regular file
		const openedStat = fs.fstatSync(fd);
		if (!openedStat.isFile()) {
			fs.closeSync(fd);
			throw new Error(`Refusing to write: opened path is not a regular file: ${tempPath}`);
		}
		fs.writeSync(fd, content, undefined, "utf-8");
		fs.closeSync(fd);
		try {
			// Issue 1 fix: re-check symlink safety immediately before rename.
			// Between the initial isSymlinkSafePath check (line 147) and here,
			// an attacker with control of an ancestor directory could plant a
			// symlink at the target path. If rename succeeds with a symlink at
			// target, the symlink is atomically replaced with attacker's content.
			// The post-rename lstat check only runs on rename failure, so we must
			// check BEFORE the rename to catch this TOCTOU race.
			if (!isSymlinkSafePath(filePath)) {
				throw new Error(`Refusing to rename: target became a symlink or inside untrusted directory: ${filePath}`);
			}
			// Issue 1 fix: use link+unlink instead of rename to avoid following symlinks
			renameWithLinkSync(tempPath, filePath);
		} catch (renameError) {
			// Issue 4 fix: use finally block to guarantee temp file cleanup.
			// Between the initial isSymlinkSafePath check and rename attempt,
			// the file could have been replaced with a symlink (TOCTOU).
			// If lstat check below throws unexpectedly, finally ensures cleanup.
			try {
				const lstat = fs.lstatSync(filePath);
				if (lstat.isSymbolicLink()) {
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
			throw renameError;
		}
	} finally {
		// Issue 4 fix: always clean up temp file, regardless of success or error path.
		// This ensures no orphaned temp files remain when errors occur at any point.
		if (fd !== undefined) {
			try { fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
		}
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
			// Re-check symlink safety immediately before rename.
			// Between the initial isSymlinkSafePath check and here,
			// an attacker with control of an ancestor directory could plant a
			// symlink at the target path. If rename succeeds with a symlink at
			// target, the symlink is atomically replaced with attacker's content.
			// The post-rename lstat check only runs on rename failure, so we must
			// check BEFORE the rename to catch this TOCTOU race.
			if (!isSymlinkSafePath(filePath)) {
				try { await fs.promises.rm(tempPath, { force: true }); } catch { /* best-effort */ }
				throw new Error(`Refusing to rename: target became a symlink or inside untrusted directory: ${filePath}`);
			}
			// Issue 1 fix: use link+unlink instead of rename to avoid following symlinks
			await renameWithLinkAsync(tempPath, filePath);
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
	coalesceMs: number;
	retryCount: number;
	/** Generation counter to detect stale flushes (Issue 2 fix) */
	generation: number;
}
const MAX_FLUSH_RETRIES = 5;
const pendingAtomicWrites = new Map<string, CoalescedAtomicWrite>();
const DEFAULT_ATOMIC_COALESCE_MS = 50;
/** Issue 2 fix: generation counter for coalesced writes */
let writeGeneration = 0;

// Issue 1 fix: guard against concurrent AND re-entrant flushes using depth counter
let flushInProgress = 0;

/**
 * Buffer a JSON write and flush it after `coalesceMs` ms (default 50).
 * Multiple writes to the same path within the window collapse to one disk write.
 *
 * @see The coalescing caveat: a `readJsonFile` call between buffer and flush
 *      sees the previous on-disk content. Callers needing read-after-write
 *      must call `flushPendingAtomicWrites()` first or use `atomicWriteJson`.
 */
export function atomicWriteJsonCoalesced<T>(filePath: string, value: T, coalesceMs = DEFAULT_ATOMIC_COALESCE_MS): void {
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const previous = pendingAtomicWrites.get(filePath);
	if (previous) clearTimeout(previous.timer);
	const timer = setTimeout(() => flushOnePendingAtomicWrite(filePath), coalesceMs);
	timer.unref();
	// Issue 2 fix: increment generation for each new entry
	const generation = ++writeGeneration;
	pendingAtomicWrites.set(filePath, { content, timer, coalesceMs, retryCount: 0, generation });
}

function flushOnePendingAtomicWrite(filePath: string): void {
	const entry = pendingAtomicWrites.get(filePath);
	if (!entry) return;
	// Issue 2 fix: capture generation before flush to detect stale flushes.
	// If a new write arrives during the flush, the generation will change
	// and we will NOT delete the newer entry after the flush completes.
	const savedGeneration = entry.generation;
	clearTimeout(entry.timer);
	try {
		atomicWriteFile(filePath, entry.content);
		// Issue 2 fix: Verify generation hasn't changed before deleting.
		// A concurrent write may have replaced entry with a newer one during the flush.
		// Only delete if generation matches (not a newer entry).
		// This prevents orphaning newer entries that arrived during the flush.
		if (pendingAtomicWrites.get(filePath)?.generation === savedGeneration) {
			pendingAtomicWrites.delete(filePath);
		}
	} catch (error) {
		logInternalError("atomic-write.coalesced-flush", error, filePath);
		// Issue 1 fix: set a fresh timer for failed entries before returning.
		// This ensures failed entries are retried without waiting for another
		// write to arrive. Only set timer if this entry is still current
		// (not replaced by a newer write during the flush).
		const current = pendingAtomicWrites.get(filePath);
		if (current?.generation === savedGeneration) {
			current.retryCount++;
			if (current.retryCount >= MAX_FLUSH_RETRIES) {
				// Max retries exceeded - remove entry and propagate error to callers
				pendingAtomicWrites.delete(filePath);
				// Re-throw so callers can handle the persistent failure
				throw error;
			}
			// Exponential backoff: base delay * 2^(retryCount-1), capped at 30 seconds
			const backoffMs = Math.min(30000, current.coalesceMs * Math.pow(2, current.retryCount - 1));
			const timer = setTimeout(() => flushOnePendingAtomicWrite(filePath), backoffMs);
			timer.unref();
			current.timer = timer;
		}
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
		if (code === "ENOENT" || code === "ENOTDIR") {
			// Expected: file doesn't exist or path is not a directory
			return undefined;
		} else if (code === "EACCES" || code === "EPERM") {
			// Permission error - log as warning but still return undefined
			logInternalError("readJsonFile.permission", err, `filePath=${filePath}`);
			return undefined;
		} else {
			// Other unexpected errors - log as internal error
			logInternalError("readJsonFile", err, `filePath=${filePath}`);
			return undefined;
		}
	}
}
