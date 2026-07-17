import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";
import { userCrewRoot } from "../utils/paths.ts";
import { isSafePathId } from "../utils/safe-paths.ts";
import { sharedScanCache } from "../utils/scan-cache.ts";
import { sleepSync } from "../utils/sleep.ts";
import { atomicWriteJson, isSymlinkSafePath, renameWithRetry } from "./atomic-write.ts";
import type { TeamRunManifest } from "./types.ts";

/** Magic bytes prefix for binary registry to prevent deserialization of hostile files. */
const BINARY_MAGIC = Buffer.from("PICREW2BIN", "utf-8");

/** Binary format version for forward compatibility. */
const BINARY_VERSION = 1;

export interface ActiveRunRegistryEntry {
	runId: string;
	cwd: string;
	stateRoot: string;
	manifestPath: string;
	updatedAt: string;
}

function registryPath(): string {
	return path.join(userCrewRoot(), DEFAULT_PATHS.state.runsSubdir, "active-run-index.json");
}

/** 2.4 — binary mirror of the JSON registry, written alongside for fast reads. */
function registryBinaryPath(): string {
	return path.join(userCrewRoot(), DEFAULT_PATHS.state.runsSubdir, "active-run-index.bin");
}

function registryLockPath(): string {
	return `${registryPath()}.lock`;
}

function lockCreatedAt(raw: string): number | undefined {
	try {
		const parsed = JSON.parse(raw) as { createdAt?: unknown };
		if (typeof parsed.createdAt !== "string") return undefined;
		const time = Date.parse(parsed.createdAt);
		return Number.isNaN(time) ? undefined : time;
	} catch {
		return undefined;
	}
}

function removeStaleRegistryLock(lockPath: string, staleMs: number): boolean {
	try {
		const stat = fs.statSync(lockPath);
		const createdAt = lockCreatedAt(fs.readFileSync(lockPath, "utf-8")) ?? stat.mtimeMs;
		if (Date.now() - createdAt <= staleMs) return false;
		fs.rmSync(lockPath, { force: true });
		return true;
	} catch {
		return false;
	}
}

function withRegistryLock<T>(fn: () => T): T {
	const filePath = registryLockPath();
	const staleMs = 30_000;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	let attempt = 0;
	// FIX Issue 3: Reduced timeout from staleMs*2 (60s) to 10s max for responsive shutdown.
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
			try {
				fs.writeSync(
					fd,
					JSON.stringify({
						pid: process.pid,
						createdAt: new Date().toISOString(),
					}),
				);
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (!removeStaleRegistryLock(filePath, staleMs) && Date.now() > deadline)
				throw new Error("Active-run registry is locked by another operation.");
			sleepSync(Math.min(250, 25 * 2 ** attempt));
			attempt += 1;
		}
	}
	try {
		return fn();
	} finally {
		try {
			fs.rmSync(filePath, { force: true });
		} catch {
			// Best-effort cleanup.
		}
	}
}

function normalizeEntry(value: unknown): ActiveRunRegistryEntry | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const runId = typeof record.runId === "string" ? record.runId : undefined;
	const cwd = typeof record.cwd === "string" ? record.cwd : undefined;
	const stateRoot = typeof record.stateRoot === "string" ? record.stateRoot : undefined;
	const manifestPath = typeof record.manifestPath === "string" ? record.manifestPath : undefined;
	const updatedAt = typeof record.updatedAt === "string" ? record.updatedAt : undefined;
	if (!runId || !isSafePathId(runId) || !cwd || !stateRoot || !manifestPath || !updatedAt) return undefined;
	if (path.basename(stateRoot) !== runId) return undefined;
	if (path.resolve(manifestPath) !== path.resolve(path.join(stateRoot, DEFAULT_PATHS.state.manifestFile))) return undefined;
	return { runId, cwd, stateRoot, manifestPath, updatedAt };
}

export function readActiveRunRegistry(maxEntries = DEFAULT_CACHE.manifestMaxEntries): ActiveRunRegistryEntry[] {
	let parsed: unknown;
	// 2.4 — prefer the binary mirror (JSON after header for schema-safe deserialization).
	// Fall back to JSON when the binary is missing or corrupt; this lets a 2-release
	// migration co-exist with old readers.
	try {
		const buf = fs.readFileSync(registryBinaryPath());
		// Security: verify magic bytes before parsing to prevent hostile files
		if (buf.length < BINARY_MAGIC.length || !buf.slice(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
			throw new Error("Invalid binary registry: missing magic bytes");
		}
		// FIX Issue 1: Verify version field for forward compatibility.
		const versionOffset = BINARY_MAGIC.length;
		const version = buf.readUInt32BE(versionOffset);
		if (version !== BINARY_VERSION) {
			throw new Error(`Unsupported binary registry version: ${version}`);
		}
		// FIX Issue 1: Use JSON.parse instead of v8 deserialize for schema-safe parsing.
		// The magic+version header provides integrity at the file level.
		const jsonSlice = buf.slice(versionOffset + 4);
		parsed = JSON.parse(jsonSlice.toString("utf-8"));
	} catch {
		try {
			parsed = JSON.parse(fs.readFileSync(registryPath(), "utf-8"));
		} catch {
			return [];
		}
	}
	const entries = Array.isArray(parsed)
		? parsed.map(normalizeEntry).filter((entry): entry is ActiveRunRegistryEntry => entry !== undefined)
		: [];
	const byId = new Map<string, ActiveRunRegistryEntry>();
	for (const entry of entries.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
		if (!byId.has(entry.runId)) byId.set(entry.runId, entry);
	}
	return [...byId.values()].slice(0, Math.max(0, maxEntries));
}

/**
 * FIX Issues 1 & 2: Atomic binary write using O_CREAT|O_EXCL|O_NOFOLLOW pattern.
 * Writes to temp file first, then renames. Includes version field for forward compatibility.
 */
function atomicWriteBinary(filePath: string, entries: ActiveRunRegistryEntry[]): void {
	if (!isSymlinkSafePath(filePath))
		throw new Error(`Refusing to write binary registry: target is a symlink or inside untrusted directory: ${filePath}`);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
	const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
	const fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW, 0o600);
	try {
		// Post-open verification: on Windows O_NOFOLLOW is 0, so verify FD is a regular file
		const openedStat = fs.fstatSync(fd);
		if (!openedStat.isFile()) {
			fs.closeSync(fd);
			throw new Error(`Refusing to write binary registry: opened path is not a regular file: ${tempPath}`);
		}
		// Write: magic (10 bytes) + version (4 bytes) + JSON data
		const header = Buffer.allocUnsafe(14);
		BINARY_MAGIC.copy(header, 0);
		header.writeUInt32BE(BINARY_VERSION, BINARY_MAGIC.length);
		// FIX Issue 1: Use JSON.stringify instead of v8 serialize for schema-safe output.
		const jsonStr = JSON.stringify(entries);
		const jsonBuf = Buffer.from(jsonStr, "utf-8");
		fs.writeSync(fd, Buffer.concat([header, jsonBuf]));
		fs.closeSync(fd);
		renameWithRetry(tempPath, filePath);
	} catch (error) {
		try {
			fs.rmSync(tempPath, { force: true });
		} catch {
			/* best-effort */
		}
		throw error;
	}
}

function writeEntries(entries: ActiveRunRegistryEntry[], skipTerminalRunIds?: Set<string>): void {
	const max = DEFAULT_CACHE.manifestMaxEntries;
	// FIX Issue 3: Gracefully prune oldest entries instead of throwing when cap is exceeded.
	if (entries.length > max) {
		const sorted = [...entries].sort((a, b) => (a.updatedAt ?? "").localeCompare(b.updatedAt ?? ""));
		entries = sorted.slice(entries.length - max);
	}
	// FIX Issue 1: Skip entries that transitioned to terminal since filterAliveEntries was called.
	// This closes the TOCTOU race between status check in filterAliveEntries and write.
	if (skipTerminalRunIds?.size) {
		entries = entries.filter((e) => !skipTerminalRunIds.has(e.runId));
	}
	fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
	// FIX Issues 1 & 2: Write both to temp files first, then rename both atomically.
	// If either rename fails, neither file is updated — registry stays consistent.
	const tempJson = `${registryPath()}.${crypto.randomUUID()}.tmp`;
	const tempBin = `${registryBinaryPath()}.${crypto.randomUUID()}.tmp`;
	let jsonRenamed = false;
	let binRenamed = false;
	try {
		// Write JSON to temp first
		atomicWriteJson(tempJson, entries);
		// Write binary to temp (atomic pattern)
		atomicWriteBinary(tempBin, entries);
		// Both written successfully — rename both atomically
		renameWithRetry(tempJson, registryPath());
		jsonRenamed = true;
		renameWithRetry(tempBin, registryBinaryPath());
		binRenamed = true;
	} catch (error) {
		// FIX Issue 5: Recovery when one rename succeeded — try to rename the other from its temp file
		// instead of deleting both. This preserves whichever registry was successfully written.
		if (jsonRenamed && !binRenamed) {
			// JSON succeeded, binary failed — try to recover binary from temp
			try {
				renameWithRetry(tempBin, registryBinaryPath());
				binRenamed = true;
			} catch {
				/* recovery failed */
			}
		} else if (binRenamed && !jsonRenamed) {
			// Binary succeeded, JSON failed — try to recover JSON from temp
			try {
				renameWithRetry(tempJson, registryPath());
				jsonRenamed = true;
			} catch {
				/* recovery failed */
			}
		}
		// FIX Issue 2: If recovery failed, do NOT delete the final files — they may contain valid
		// data from a prior write cycle. Leave temp files for manual recovery and throw error.
		if (!binRenamed || !jsonRenamed) {
			// Attempt to clean up temp files only (not final files)
			try {
				fs.rmSync(tempJson, { force: true });
			} catch {
				/* best-effort */
			}
			try {
				fs.rmSync(tempBin, { force: true });
			} catch {
				/* best-effort */
			}
			throw error;
		}
		// FIX Issue 1: Ensure temp file cleanup executes even when recovery rename fails.
		// If recovery throws, the error propagates before reaching the cleanup below.
		// Wrapping in nested try-catch guarantees cleanup runs regardless of recovery outcome.
		try {
			fs.rmSync(tempJson, { force: true });
		} catch {
			/* best-effort */
		}
		try {
			fs.rmSync(tempBin, { force: true });
		} catch {
			/* best-effort */
		}
		throw error;
	}
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

/**
 * FIX Issue 1: Filter out entries that are no longer active: terminal status, missing manifest,
 * or symlink-unsafe paths. This prevents unbounded growth and guards against symlink attacks.
 *
 * WARNING: This function reads manifest files WITHOUT holding the registry lock (TOCTOU race).
 * Status filtering is best-effort at read time. The terminal runIds set is returned so callers
 * can pass them to writeEntries to skip entries that transitioned to terminal since filtering.
 */
function filterAliveEntries(entries: ActiveRunRegistryEntry[]): {
	alive: ActiveRunRegistryEntry[];
	terminalRunIds: Set<string>;
} {
	const terminalRunIds = new Set<string>();
	const alive = entries.filter((entry) => {
		try {
			if (!fs.existsSync(entry.cwd)) return false;
			if (!fs.existsSync(entry.manifestPath)) return false;
			// FIX Issue 2: Guard against symlink attacks on stateRoot and manifestPath
			if (!isSymlinkSafePath(entry.stateRoot)) return false;
			if (!isSymlinkSafePath(entry.manifestPath)) return false;
		} catch {
			return false;
		}
		try {
			const raw = JSON.parse(fs.readFileSync(entry.manifestPath, "utf-8")) as {
				status?: string;
				async?: { pid?: number };
				updatedAt?: string;
			};
			if (TERMINAL_STATUSES.has(raw.status ?? "")) {
				terminalRunIds.add(entry.runId);
				return false;
			}
			// FIX Issue 2: Robust PID liveness check - only ESRCH means process is dead.
			// EPERM means process exists but we can't signal it (different security context).
			// Also check manifest age to guard against PID reuse.
			if (raw.async?.pid) {
				try {
					process.kill(raw.async.pid, 0);
				} catch (err) {
					// Only treat "process does not exist" as dead (ESRCH/ENOENT).
					// EPERM means process is alive but protected; treat as alive.
					const code = (err as NodeJS.ErrnoException).code;
					if (code !== "ESRCH" && code !== "ENOENT") return false;
					return false;
				}
				// FIX Issue 2: Async runs older than 30 min are stale even if PID is alive.
				// This guards against PID reuse after the original process exits.
				const updatedAt = typeof raw.updatedAt === "string" ? Date.parse(raw.updatedAt) : NaN;
				if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 30 * 60 * 1000) return false;
			}
			// 2.19 — Stale non-async run: live-session/scaffold runs older than 30 min
			// Without this, test runs that crash/leak would stay in the registry forever.
			if (!raw.async) {
				const updatedAt = typeof raw.updatedAt === "string" ? Date.parse(raw.updatedAt) : NaN;
				if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 30 * 60 * 1000) return false;
			}
		} catch {
			return false;
		}
		return true;
	});
	return { alive, terminalRunIds };
}

export function registerActiveRun(manifest: TeamRunManifest): void {
	const entry: ActiveRunRegistryEntry = {
		runId: manifest.runId,
		cwd: manifest.cwd,
		stateRoot: manifest.stateRoot,
		manifestPath: path.join(manifest.stateRoot, DEFAULT_PATHS.state.manifestFile),
		updatedAt: manifest.updatedAt,
	};
	withRegistryLock(() => {
		const existing = readActiveRunRegistry().filter((item) => item.runId !== manifest.runId);
		// Inline cleanup: remove terminal-status and stale entries before writing.
		// This prevents unbounded growth between sessions.
		const { alive, terminalRunIds } = filterAliveEntries(existing);
		// FIX Issue 4: Also filter the new entry being registered through filterAliveEntries
		// to exclude it if it is terminal (e.g. completed between call and write).
		const { alive: filteredAlive } = filterAliveEntries([entry]);
		const filteredEntry = filteredAlive.length > 0 ? entry : null;
		if (filteredEntry === null) {
			throw new Error(`Cannot register run ${manifest.runId}: entry is terminal or paths are not symlink-safe`);
		}
		// FIX Issue 1: Pass terminal runIds from filterAliveEntries to writeEntries.
		// writeEntries will skip these entries, closing the TOCTOU race between status check
		// and write without re-reading manifest inside the lock.
		const allTerminalRunIds = new Set(terminalRunIds);
		if (filteredAlive.length === 0) allTerminalRunIds.add(entry.runId);
		writeEntries([filteredEntry, ...alive], allTerminalRunIds);
	});
}

export function unregisterActiveRun(runId: string): void {
	if (!isSafePathId(runId)) {
		console.warn(`unregisterActiveRun: invalid runId ignored: ${runId}`);
		return;
	}
	withRegistryLock(() => {
		// FIX Issue 1: Filter alive entries and pass terminal runIds to writeEntries,
		// closing the TOCTOU race between status check and write (same pattern as registerActiveRun).
		const { alive, terminalRunIds } = filterAliveEntries(readActiveRunRegistry().filter((entry) => entry.runId !== runId));
		writeEntries(alive, terminalRunIds);
	});
}

/**
 * Status filtering is best-effort at read time — entries returned by this function may have
 * transitioned to terminal status between the manifest read and the filter check.
 * Callers must re-check status when opening individual run manifests.
 */
export function activeRunEntries(): ActiveRunRegistryEntry[] {
	const entries: ActiveRunRegistryEntry[] = [];
	for (const entry of readActiveRunRegistry()) {
		try {
			// Skip entries whose CWD no longer exists (temp test dirs, deleted projects)
			if (!fs.existsSync(entry.cwd)) continue;
			// FIX Issue 4: sharedScanCache.readAndCache does stat checks internally.
			// Only check stateRoot/manifestPath existence here if cache miss (cached.raw is undefined).
			const cached = sharedScanCache.readAndCache("active-manifests", entry.runId, entry.manifestPath);
			if (cached?.raw === undefined && (!fs.existsSync(entry.stateRoot) || !fs.existsSync(entry.manifestPath))) continue;
			// FIX Issue 4: Check full ancestor chain for symlinks, not just immediate stateRoot.
			if (!isSymlinkSafePath(entry.stateRoot)) continue;
			// FIX Issue 4: Use cached manifest content directly when available.
			// sharedScanCache.readAndCache already read the file; avoid redundant re-read.
			const manifest = (cached?.raw !== undefined ? cached.raw : JSON.parse(fs.readFileSync(entry.manifestPath, "utf-8"))) as {
				status?: unknown;
				updatedAt?: string;
				async?: { pid?: number };
			};
			if (
				manifest.status !== "queued" &&
				manifest.status !== "planning" &&
				manifest.status !== "running" &&
				manifest.status !== "blocked"
			)
				continue;
			// PID liveness check: async runs with dead PID are stale — don't surface them
			if (manifest.async?.pid) {
				try {
					process.kill(manifest.async.pid, 0);
				} catch {
					continue;
				}
			}
			// Stale non-async run: live-session/scaffold runs older than 30 min
			if (!manifest.async) {
				const updatedAt = typeof manifest.updatedAt === "string" ? Date.parse(manifest.updatedAt) : NaN;
				if (Number.isFinite(updatedAt) && Date.now() - updatedAt > 30 * 60 * 1000) continue;
			}
			entries.push(entry);
		} catch {
			// Ignore stale entries; callers filter active status from manifests.
		}
	}
	return entries;
}

export function activeRunRoots(): string[] {
	return [...new Set(activeRunEntries().map((entry) => path.dirname(entry.stateRoot)))];
}
