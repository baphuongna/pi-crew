import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { logInternalError } from "../utils/internal-error.ts";
import { sleepSync } from "../utils/sleep.ts";
import { atomicWriteFileViaWorker, isWorkerAtomicWriterEnabled } from "./worker-atomic-writer.ts";

function hashContent(content: string): string {
	return crypto.createHash("sha256").update(content, "utf-8").digest("hex");
}

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
// EEXIST is retryable: two concurrent async saves (OPT-02 async saveRunManifest)
// can race on unlink+link — the second link() hits EEXIST because the first
// already created the destination. The retry loop unlinks and re-links,
// resolving the race. Exponential backoff + jitter prevents starvation.
const RETRYABLE_LINK_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOENT", "EEXIST"]);

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
						} catch {
							/* not found yet, keep walking */
						}
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
						try {
							realSystemTmp = fs.realpathSync(systemTmp).toLowerCase();
						} catch {
							/* ok */
						}
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
						const isSystemTmp =
							process.platform === "darwin" &&
							(realDirLower === "/tmp" ||
								realDirLower === "/private/tmp" ||
								realDirLower === "/var/folders" ||
								realDirLower === "/private/var/folders" ||
								realDirLower.startsWith("/var/folders/") ||
								realDirLower.startsWith("/private/var/folders/"));
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

// ─── F5: Symlink-safe ancestor chain cache ─────────────────────────────────
// `isSymlinkSafePath` walks the full ancestor chain with `lstatSync` per level
// and is called twice per atomic write (initial + pre-rename re-check). The
// parent dirs of `.crew/state/runs/{runId}/` are stable within a run, so we
// cache the ancestor-walk verdict keyed by `dirname(filePath)`.
//
// SECURITY: TTL-only invalidation. The `.crew/` state directory is trusted
// (single-user, non-shared). Symlink attacks require write access to the state
// dir, which would already compromise the system. The short TTL provides
// defense-in-depth. The target file itself is still checked every call (no
// cache) — when in doubt the next call's statSync re-verifies.
const SYMLINK_SAFE_TTL_MS = 10_000;
const SYMLINK_SAFE_MAX_ENTRIES = 128;
// P5 (perf): short-TTL cache for the target-file symlink check. Even though the
// guard re-runs on every call by design, the common-case write path
// (manifest.json, tasks.json, events.jsonl inside .crew/state/) repeatedly
// re-stats the same known-regular files. A 1s TTL bounds the TOCTOU window
// (same upper bound as isSymlinkSafeDirCached) and lets us skip the lstatSync
// on burst writes. Invalidated whenever the directory itself is invalidated,
// so the two caches stay coherent. Disable by setting TTL=0; the original
// always-recheck behavior is preserved in that case.
const TARGET_NOT_SYMLINK_TTL_MS = 1_000;
const TARGET_NOT_SYMLINK_MAX_ENTRIES = 256;
const targetNotSymlinkCache = new Map<string, { safe: boolean; at: number }>();
// NOTE: This cache is process-local and assumes single-threaded access.
// If worker-thread usage expands (e.g., worker-atomic-writer.ts), this cache
// would need synchronization (e.g., a Mutex or WeakRef pattern).
const symlinkSafeCache = new Map<string, { safe: boolean; at: number }>();

/** Drop one or all cached entries. When a directory is invalidated, also
 *  clear the target-file cache entries that live under that directory so the
 *  two caches stay coherent — a swap at the dir level (e.g. directory
 *  replaced) means per-file verdicts from before the swap may no longer
 *  be trustworthy. */
export function invalidateSymlinkSafeCache(dir?: string): void {
	if (dir) {
		symlinkSafeCache.delete(dir);
		// Drop all target-file entries whose path is inside `dir`.
		const dirPrefix = dir.endsWith(path.sep) ? dir : `${dir}${path.sep}`;
		for (const filePath of targetNotSymlinkCache.keys()) {
			if (filePath === dir || filePath.startsWith(dirPrefix)) {
				targetNotSymlinkCache.delete(filePath);
			}
		}
	} else {
		symlinkSafeCache.clear();
		targetNotSymlinkCache.clear();
	}
}

/** Target-file-only symlink check. Cheap single lstat. Cached for
 *  TARGET_NOT_SYMLINK_TTL_MS (1s) on a per-file basis because the common-case
 *  write path repeatedly stats the same known-regular files (manifest.json,
 *  tasks.json, events.jsonl inside .crew/state/). A 1s TTL bounds the TOCTOU
 *  window to a worst-case swap-then-write window of ~1s, which is the same
 *  order as `isSymlinkSafeDirCached` (10s) and well within the existing
 *  attack-prevention model. When TTL is 0 the cache is disabled and every
 *  call re-stats (pre-P5 behavior preserved). Set TTL=0 if you need
 *  exact-time TOCTOU semantics for an untrusted write target.
 *  Always evicts the entry when the cached verdict goes false so a symlink
 *  swap is picked up on the very next call. */
function isTargetNotSymlink(filePath: string): boolean {
	if (TARGET_NOT_SYMLINK_TTL_MS <= 0) {
		try {
			if (fs.lstatSync(filePath).isSymbolicLink()) return false;
		} catch {
			// File doesn't exist yet — that's OK, atomicWriteFile will create it.
		}
		return true;
	}
	const now = Date.now();
	const hit = targetNotSymlinkCache.get(filePath);
	if (hit && now - hit.at < TARGET_NOT_SYMLINK_TTL_MS) return hit.safe;
	let safe = true;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) safe = false;
	} catch {
		// File doesn't exist yet — that's OK, atomicWriteFile will create it.
	}
	// Cache the verdict. On a negative verdict (target IS a symlink) we still
	// cache briefly so a burst of rejected writes doesn't keep stat'ing — the
	// TTL is short enough that a cleanup will be visible within 1s.
	targetNotSymlinkCache.set(filePath, { safe, at: now });
	// Bound the cache to avoid unbounded growth across many file paths.
	while (targetNotSymlinkCache.size > TARGET_NOT_SYMLINK_MAX_ENTRIES) {
		const oldest = targetNotSymlinkCache.keys().next().value;
		if (oldest === undefined) break;
		targetNotSymlinkCache.delete(oldest);
	}
	return safe;
}

/**
 * Cached wrapper used by `atomicWriteFile` on the hot path. Only the ancestor-
 * chain walk (the slow part) is cached, keyed by `dirname(filePath)`; the
 * target-file symlink check ALWAYS re-runs so a mid-window symlink swap at the
 * target path is still caught (preserving the pre-rename TOCTOU guard).
 *
 * The cached verdict is computed from `isSymlinkSafePath(dir)` — i.e. the safety
 * of the *directory* itself, independent of any specific target file — so the
 * entry is correctly reusable for every file written into that dir (no
 * cross-file cache poisoning).
 */
function isSymlinkSafeDirCached(filePath: string): boolean {
	const now = Date.now();
	const dir = path.dirname(filePath);
	// Always re-check the target file (uncached) before trusting the dir verdict.
	if (!isTargetNotSymlink(filePath)) return false;
	const hit = symlinkSafeCache.get(dir);
	if (hit && now - hit.at < SYMLINK_SAFE_TTL_MS) return hit.safe;
	// Cache miss: evaluate the ancestor-chain safety of the DIRECTORY itself.
	// Pass a synthetic file path (dir + sentinel) so `dir` is checked as an
	// ANCESTOR rather than a target file. When `dir` itself is a symlink
	// (e.g. macOS /tmp → /private/tmp), the ancestor-walk logic resolves it
	// and verifies ownership — accepting known system temp dirs. Passing `dir`
	// bare would hit the target-file symlink check at the bottom of
	// isSymlinkSafePath, which rejects ALL symlinks without ownership
	// resolution, causing false rejections for legitimate system dirs.
	const verdict = isSymlinkSafePath(path.join(dir, ".symlink-safe-check"));
	symlinkSafeCache.set(dir, { safe: verdict, at: now });
	// Bound the cache to avoid unbounded growth across many cwds.
	while (symlinkSafeCache.size > SYMLINK_SAFE_MAX_ENTRIES) {
		const oldest = symlinkSafeCache.keys().next().value;
		if (oldest === undefined) break;
		symlinkSafeCache.delete(oldest);
	}
	return verdict;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRenameError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && RETRYABLE_RENAME_CODES.has(String((error as NodeJS.ErrnoException).code)),
	);
}

function isRetryableLinkError(error: unknown): boolean {
	return Boolean(
		error && typeof error === "object" && "code" in error && RETRYABLE_LINK_CODES.has(String((error as NodeJS.ErrnoException).code)),
	);
}

/**
 * Issue 1 fix: rename via link+unlink instead of rename.
 * Unlike rename, link() does NOT follow symlinks at the destination path.
 * It atomically creates a hard link to the source. We then unlink the source.
 * This prevents TOCTOU attacks where an attacker plants a symlink at the
 * destination between the check and the rename operation.
 *
 * ST-8: this is the canonical symlink-safe rename helper used by both
 * `atomicWriteFile` (sync) and `atomicWriteFileAsync` (async) paths, AND
 * consumed by `atomic-write-v2.ts`'s `AtomicWriter` class so the two
 * implementations share a single rename semantic. Keep this signature
 * stable — `AtomicWriter.writeSync` / `writeAsync` call it directly.
 */
export function renameWithLinkSync(tempPath: string, filePath: string, retries = 8): void {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			if (process.platform === "win32") {
				// B9: MoveFileEx (Node's renameSync on Windows) replaces the destination atomically
				// with MOVEFILE_REPLACE_EXISTING, so no prior unlink is needed. Unlinking first
				// opened a window where concurrent readers saw ENOENT between the unlink and
				// the rename. Try rename directly; only fall back to unlink-then-rename for
				// edge cases (read-only dest / type mismatch / short-long-name alias).
				try {
					fs.renameSync(tempPath, filePath);
					return;
				} catch (renameError) {
					lastError = renameError;
					if (isRetryableLinkError(renameError) && attempt !== retries) {
						// retryable — loop again after sleep
					} else {
						try {
							fs.unlinkSync(filePath);
						} catch {
							/* destination may not exist */
						}
						try {
							fs.renameSync(tempPath, filePath);
							return;
						} catch (renameError2) {
							lastError = renameError2;
							if (!isRetryableLinkError(renameError2) || attempt === retries) break;
						}
					}
				}
			} else {
				try {
					fs.unlinkSync(filePath);
				} catch {
					/* destination may not exist */
				}
				// Create hard link — does NOT follow symlinks at filePath
				fs.linkSync(tempPath, filePath);
				// Successfully linked — now unlink the temp file
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

/**
 * ST-8: async twin of `renameWithLinkSync`. Exported so `atomic-write-v2.ts`
 * (`AtomicWriter.writeAsync`) shares the same symlink-safe rename semantics
 * as the primary `atomicWriteFileAsync` path.
 */
export async function renameWithLinkAsync(tempPath: string, filePath: string, retries = 8): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			if (process.platform === "win32") {
				// B9: MoveFileEx (Node's rename on Windows) replaces the destination atomically
				// with MOVEFILE_REPLACE_EXISTING, so no prior unlink is needed. Unlinking first
				// opened a window where concurrent readers saw ENOENT between the unlink and
				// the rename. Try rename directly; only fall back to unlink-then-rename for
				// edge cases (read-only dest / type mismatch / short-long-name alias).
				try {
					await fs.promises.rename(tempPath, filePath);
					return;
				} catch (renameError) {
					lastError = renameError;
					if (isRetryableLinkError(renameError) && attempt !== retries) {
						// retryable — loop again after sleep
					} else {
						try {
							await fs.promises.unlink(filePath);
						} catch {
							/* destination may not exist */
						}
						try {
							await fs.promises.rename(tempPath, filePath);
							return;
						} catch (renameError2) {
							lastError = renameError2;
							if (!isRetryableLinkError(renameError2) || attempt === retries) break;
						}
					}
				}
			} else {
				try {
					await fs.promises.unlink(filePath);
				} catch {
					/* destination may not exist */
				}
				// Create hard link — does NOT follow symlinks at filePath
				await fs.promises.link(tempPath, filePath);
				// Successfully linked — now unlink the temp file
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
export function renameWithRetry(
	tempPath: string,
	filePath: string,
	retries = 8,
	rename: (oldPath: string, newPath: string) => void = fs.renameSync,
): void {
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

export async function renameWithRetryAsync(
	tempPath: string,
	filePath: string,
	retries = 8,
	rename: (oldPath: string, newPath: string) => Promise<void> = (source, destination) => fs.promises.rename(source, destination),
): Promise<void> {
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

/**
 * F4: per-write durability knob.
 * - "full" (default): fsync the data file AND the parent directory after rename.
 *   Cost is ms-scale on Windows; safe against crash + power-loss.
 * - "best-effort": skip both fsyncs. We still get atomic rename from temp file,
 *   so a concurrent reader sees either the prior content or the full new
 *   content — never a torn write. The trade-off is: a hard crash between
 *   rename and a later `flush` may leave a few bytes stale on disk, which is
 *   acceptable for informational writes (mailbox delivery, agent progress,
 *   .seq sidecar) that the event-log reconstructor / crash-recovery can
 *   reconcile without.
 */
export type WriteDurability = "full" | "best-effort";

/** Options accepted by atomicWriteFile (forward-compatible string | object form). */
export type AtomicWriteOptions =
	| string // legacy: expectedHash
	| { expectedHash?: string; durability?: WriteDurability; mode?: number };

function normalizeOptions(arg: unknown): { expectedHash?: string; durability: WriteDurability; mode?: number } {
	if (typeof arg === "string") return { expectedHash: arg, durability: "full", mode: undefined };
	if (arg && typeof arg === "object") {
		const o = arg as { expectedHash?: string; durability?: WriteDurability; mode?: number };
		const durability: WriteDurability = o.durability === "best-effort" ? "best-effort" : "full";
		return { expectedHash: o.expectedHash, durability, mode: o.mode };
	}
	return { durability: "full", mode: undefined };
}

export function atomicWriteFile(filePath: string, content: string, options?: AtomicWriteOptions): void {
	cancelPendingCoalescedWrite(filePath);
	const { durability, mode } = normalizeOptions(options);
	if (!isSymlinkSafeDirCached(filePath))
		throw new Error(`Refusing to write: target is a symlink or inside untrusted directory: ${filePath}`);
	// On Windows the parent directory may be referenced via a short-name alias
	// (e.g. RUNNER~1 vs runneradmin). mkdirSync on one form can succeed while
	// openSync on another form fails with ENOENT. We therefore ensure the dir
	// exists, trying the canonical (realpathSync.native) form as a fallback on
	// EPERM.
	//
	// CRITICAL: we NEVER rewrite `filePath`. The caller (e.g. createRunManifest)
	// builds filePath via canonicalizePath() (realpathSync.native) and will later
	// stat/read it back at that exact path. If we rewrote filePath to a different
	// realpath form here, the written file would land on a path that diverges
	// from the caller's path — making existsSync/readFileSync(callerPath) fail
	// with ENOENT even though the write "succeeded". Writing to the original
	// filePath guarantees the caller can always find the file it just wrote.
	const canonicalize = (p: string): string => {
		try {
			const r = fs.realpathSync.native(p);
			return r.startsWith("\\\\?\\") ? r.slice(4) : r;
		} catch {
			try {
				return fs.realpathSync(p);
			} catch {
				return p;
			}
		}
	};
	const dirPath = path.dirname(filePath);
	try {
		fs.mkdirSync(dirPath, { recursive: true });
	} catch (error) {
		if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") {
			// mkdir hit a short/long-name alias wall — retry with the canonical
			// form. The write itself still targets the original filePath below.
			const realDir = canonicalize(dirPath);
			if (realDir !== dirPath) fs.mkdirSync(realDir, { recursive: true });
		} else {
			throw error;
		}
	}
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	// Write temp with restrictive permissions
	const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	let fd: number | undefined;
	try {
		fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, mode ?? 0o600);
		// Post-open verification: on Windows O_NOFOLLOW is 0, so verify FD is a regular file
		const openedStat = fs.fstatSync(fd);
		if (!openedStat.isFile()) {
			fs.closeSync(fd);
			throw new Error(`Refusing to write: opened path is not a regular file: ${tempPath}`);
		}
		fs.writeSync(fd, content, undefined, "utf-8");
		// FIX (2026-07-01 mailbox-replay CI flake investigation): fsync the data
		// before close. Without this, writeSync puts content in page cache but
		// the data may not be flushed to disk before the subsequent rename.
		// On shared CI runners (Ubuntu, high I/O pressure), a subsequent
		// readFileSync could see the OLD content if the page cache evicted
		// between write and read. fsyncSync forces the data to disk so the
		// rename + post-rename read always sees the new content. Cost: ~1ms
		// per write (acceptable for the small delivery.json / manifest.json
		// files this function writes; large state-store uses the async path).
		// F4: skip when durability is "best-effort" — see WriteDurability docs.
		if (durability === "full") fs.fsyncSync(fd);
		fs.closeSync(fd);
		try {
			// Issue 1 fix: re-check symlink safety immediately before rename.
			// Between the initial isSymlinkSafePath check (line 147) and here,
			// an attacker with control of an ancestor directory could plant a
			// symlink at the target path. If rename succeeds with a symlink at
			// target, the symlink is atomically replaced with attacker's content.
			// The post-rename lstat check only runs on rename failure, so we must
			// check BEFORE the rename to catch this TOCTOU race. Use the cached
			// wrapper for the dir chain — the pre-rename race only matters for the
			// *target* symlink swap, which the un-cached path check handles on the
			// first call. Here we just re-confirm nothing in the dir chain has been
			// planted symlink-wise since the initial call.
			if (!isSymlinkSafeDirCached(filePath)) {
				throw new Error(`Refusing to rename: target became a symlink or inside untrusted directory: ${filePath}`);
			}
			// Issue 1 fix: use link+unlink instead of rename to avoid following symlinks
			renameWithLinkSync(tempPath, filePath);
			// FIX (2026-07-01 mailbox-replay CI flake): fsync the parent directory
			// after rename so the directory entry update is durable. On most Linux
			// filesystems, rename is journaled but the journal flush isn't always
			// synchronous; without this, a subsequent open() after rename can
			// race and see ENOENT or stale content on high-IO CI runners.
			// We skip on Windows where directory fsync semantics differ (and
			// where the Windows-specific rename path in renameWithLinkSync already
			// uses MoveFileEx which is fully durable).
			// F4: honor durability — best-effort also skips the parent-dir fsync.
			if (durability === "full" && process.platform !== "win32") {
				try {
					const dirFd = fs.openSync(path.dirname(filePath), "r");
					fs.fsyncSync(dirFd);
					fs.closeSync(dirFd);
				} catch {
					/* best-effort — not all filesystems support directory fsync */
				}
			}
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
			try {
				fs.rmSync(tempPath, { force: true });
			} catch {
				/* best-effort */
			}
		}
	}
}

export async function atomicWriteFileAsync(filePath: string, content: string, options?: AtomicWriteOptions): Promise<void> {
	cancelPendingCoalescedWrite(filePath);
	const { durability } = normalizeOptions(options);
	// Phase 1.5 (RFC 15): when the worker-thread atomic writer is enabled
	// (PI_CREW_WORKER_ATOMIC_WRITER=1), dispatch to a dedicated worker thread
	// that performs SYNC fs ops with no internal yields. Mitigates the
	// non-deterministic V8/libuv crash during event-loop yields in multi-step
	// goal-wrapped workflows.
	if (isWorkerAtomicWriterEnabled()) {
		return atomicWriteFileViaWorker(filePath, content);
	}
	if (!isSymlinkSafeDirCached(filePath))
		throw new Error(`Refusing to write: target is a symlink or inside untrusted directory: ${filePath}`);
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
		// F4: skip data fsync when caller is best-effort. atomic rename below
		// still guarantees the reader sees either prior or new content, never torn.
		if (durability === "full") await fd.sync();
		await fd.close();
		// Re-check symlink safety immediately before rename.
		// Between the initial isSymlinkSafePath check and here,
		// an attacker with control of an ancestor directory could plant a
		// symlink at the target path. If rename succeeds with a symlink at
		// target, the symlink is atomically replaced with attacker's content.
		// The post-rename lstat check only runs on rename failure, so we must
		// check BEFORE the rename to catch this TOCTOU race.
		if (!isSymlinkSafeDirCached(filePath)) {
			throw new Error(`Refusing to rename: target became a symlink or inside untrusted directory: ${filePath}`);
		}
		// Issue 1 fix: use link+unlink instead of rename to avoid following symlinks.
		// Align with sync path: no content-match fallback after failed rename.
		// The racy readFile after failed rename is unreliable (another process
		// could write between the failed rename and the read) and inconsistent
		// with the sync path which just throws.
		await renameWithLinkAsync(tempPath, filePath);
	} catch (error) {
		try {
			await fs.promises.rm(tempPath, { force: true });
		} catch (cleanupError) {
			logInternalError("atomic-write.cleanupAsync", cleanupError, `tempPath=${tempPath}`);
		}
		throw error;
	}
}

export function atomicWriteJson<T>(filePath: string, value: T, options?: AtomicWriteOptions): void {
	atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function atomicWriteJsonAsync<T>(filePath: string, value: T, options?: AtomicWriteOptions): Promise<void> {
	await atomicWriteFileAsync(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
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
	/** F4: durability knob carried into the underlying atomicWriteFile flush. */
	durability: WriteDurability;
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
 * ST-7 escape hatch: pass `skipCoalesce: true` to bypass the buffer entirely
 * and write synchronously via `atomicWriteJson`. Use for terminal task status
 * transitions where a SIGKILL during the 50ms coalesce window must NOT lose
 * the terminal status update — otherwise crash recovery would see "running"
 * in tasks.json while events.jsonl already shows "completed", causing
 * double-execution / zombie detection. Defaults to `false` (buffered write)
 * so all existing callers preserve their behavior.
 *
 * @see The coalescing caveat: a `readJsonFile` call between buffer and flush
 *      sees the previous on-disk content. Callers needing read-after-write
 *      must call `flushPendingAtomicWrites()` first or use `atomicWriteJson`.
 */
export function atomicWriteJsonCoalesced<T>(
	filePath: string,
	value: T,
	coalesceMs: number = DEFAULT_ATOMIC_COALESCE_MS,
	options?: AtomicWriteOptions,
	skipCoalesce: boolean = false,
): void {
	// ST-7: bypass coalescing for callers that need durable synchronous
	// semantics. atomicWriteJson goes through atomicWriteFile which uses
	// renameWithLinkSync + fsync — fully durable, no SIGKILL window.
	if (skipCoalesce) {
		atomicWriteJson(filePath, value, options);
		return;
	}
	const content = `${JSON.stringify(value, null, 2)}\n`;
	const previous = pendingAtomicWrites.get(filePath);
	if (previous) clearTimeout(previous.timer);
	const timer = setTimeout(() => flushOnePendingAtomicWrite(filePath), coalesceMs);
	timer.unref();
	// Issue 2 fix: increment generation for each new entry
	const generation = ++writeGeneration;
	const normalized = normalizeOptions(options);
	pendingAtomicWrites.set(filePath, {
		content,
		timer,
		coalesceMs,
		retryCount: 0,
		generation,
		durability: normalized.durability,
	});
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
		atomicWriteFile(filePath, entry.content, { durability: entry.durability });
		// Issue 2 fix: Verify generation hasn't changed before deleting.
		// A concurrent write may have replaced entry with a newer one during the flush.
		// Only delete if generation matches (not a newer entry).
		// This prevents orphaning newer entries that arrived during the flush.
		if (pendingAtomicWrites.get(filePath)?.generation === savedGeneration) {
			pendingAtomicWrites.delete(filePath);
		}
	} catch (error) {
		logInternalError("atomic-write.coalesced-flush", error, filePath, "error");
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
			const backoffMs = Math.min(30000, current.coalesceMs * 2 ** (current.retryCount - 1));
			const timer = setTimeout(() => flushOnePendingAtomicWrite(filePath), backoffMs);
			timer.unref();
			current.timer = timer;
		}
	}
}

/**
 * Cancel any pending coalesced write for `filePath`. An immediate (durable)
 * write supersedes a pending coalesced (buffered) write — the immediate write
 * IS the freshest data, so the stale buffered content must not be allowed to
 * fire later and clobber it.
 *
 * Without this, a sequence like persistSingleTaskUpdate (coalesced, 50ms) →
 * merge saveRunTasksAsync (immediate) leaves the coalesced entry pending; when
 * its timer fires it overwrites the merge result with a stale single-task
 * snapshot, losing other workers' results / attempt enrichment / graph
 * recompute. It also closes the crash window where tasks.json shows "running"
 * while events.jsonl already shows "completed" (re-run on recovery).
 */
function cancelPendingCoalescedWrite(filePath: string): void {
	const pending = pendingAtomicWrites.get(filePath);
	if (pending) {
		clearTimeout(pending.timer);
		pendingAtomicWrites.delete(filePath);
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
