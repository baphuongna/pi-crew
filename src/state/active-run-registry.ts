import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";
import type { TeamRunManifest } from "./types.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { userCrewRoot } from "../utils/paths.ts";
import { isSafePathId } from "../utils/safe-paths.ts";
import { sharedScanCache } from "../utils/scan-cache.ts";
import { sleepSync } from "../utils/sleep.ts";

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
	const deadline = Date.now() + staleMs * 2;
	while (true) {
		try {
			const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o644);
			try {
				fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
			} finally {
				fs.closeSync(fd);
			}
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (!removeStaleRegistryLock(filePath, staleMs) && Date.now() > deadline) throw new Error("Active-run registry is locked by another operation.");
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
	try {
		parsed = JSON.parse(fs.readFileSync(registryPath(), "utf-8"));
	} catch {
		return [];
	}
	const entries = Array.isArray(parsed) ? parsed.map(normalizeEntry).filter((entry): entry is ActiveRunRegistryEntry => entry !== undefined) : [];
	const byId = new Map<string, ActiveRunRegistryEntry>();
	for (const entry of entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
		if (!byId.has(entry.runId)) byId.set(entry.runId, entry);
	}
	return [...byId.values()].slice(0, Math.max(0, maxEntries));
}

function writeEntries(entries: ActiveRunRegistryEntry[]): void {
	fs.mkdirSync(path.dirname(registryPath()), { recursive: true });
	atomicWriteJson(registryPath(), entries.slice(0, DEFAULT_CACHE.manifestMaxEntries));
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "blocked"]);

/**
 * Filter out entries that are no longer active: terminal status or missing manifest.
 * This prevents unbounded growth of the active-run-index.json file.
 */
function filterAliveEntries(entries: ActiveRunRegistryEntry[]): ActiveRunRegistryEntry[] {
	return entries.filter((entry) => {
		// Quick checks first — skip heavy manifest read if CWD or state dir is gone
		try {
			if (!fs.existsSync(entry.cwd)) return false;
			if (!fs.existsSync(entry.manifestPath)) return false;
		} catch {
			return false;
		}
		// Only read manifest if quick checks pass
		try {
			const raw = JSON.parse(fs.readFileSync(entry.manifestPath, "utf-8")) as { status?: string };
			if (TERMINAL_STATUSES.has(raw.status ?? "")) return false;
		} catch {
			return false;
		}
		return true;
	});
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
		const alive = filterAliveEntries(existing);
		writeEntries([entry, ...alive]);
	});
}

export function unregisterActiveRun(runId: string): void {
	if (!isSafePathId(runId)) return;
	withRegistryLock(() => {
		writeEntries(readActiveRunRegistry().filter((entry) => entry.runId !== runId));
	});
}

export function activeRunEntries(): ActiveRunRegistryEntry[] {
	const entries: ActiveRunRegistryEntry[] = [];
	for (const entry of readActiveRunRegistry()) {
		try {
			// Skip entries whose CWD no longer exists (temp test dirs, deleted projects)
			if (!fs.existsSync(entry.cwd)) continue;
			if (!fs.existsSync(entry.stateRoot) || !fs.existsSync(entry.manifestPath)) continue;
			if (fs.lstatSync(entry.stateRoot).isSymbolicLink()) continue;
			const cached = sharedScanCache.readAndCache("active-manifests", entry.runId, entry.manifestPath);
			const manifest = (cached?.raw ?? JSON.parse(fs.readFileSync(entry.manifestPath, "utf-8"))) as { status?: unknown };
			if (manifest.status !== "queued" && manifest.status !== "planning" && manifest.status !== "running" && manifest.status !== "blocked") continue;
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
