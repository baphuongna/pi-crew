import * as fs from "node:fs";
import * as path from "node:path";
import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";

export interface ManifestCache {
	list(limit?: number): TeamRunManifest[];
	get(runId: string): TeamRunManifest | undefined;
	clear(runId?: string): void;
	dispose(): void;
}

interface CachedManifest {
	path: string;
	manifest: TeamRunManifest;
	mtimeMs: number;
	size: number;
	loadedAtMs: number;
}

interface CachedList {
	runs: TeamRunManifest[];
	limit?: number;
	expireAtMs: number;
}

export interface ManifestCacheOptions {
	debounceMs?: number;
	watch?: boolean;
	maxEntries?: number;
}

const DEFAULT_TTL_MS = 500;

interface ParsedEntry {
	runId: string;
	path: string;
	manifest?: TeamRunManifest;
}

function manifestPathForRun(root: string, runId: string): string {
	return path.join(root, runId, DEFAULT_PATHS.state.manifestFile);
}

function parseManifest(filePath: string): TeamRunManifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TeamRunManifest;
	} catch {
		return undefined;
	}
}

function parseManifestIfChanged(filePath: string, previous?: CachedManifest): CachedManifest | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}
	if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
		return previous;
	}
	const manifest = parseManifest(filePath);
	if (!manifest) return undefined;
	return {
		path: filePath,
		manifest,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		loadedAtMs: Date.now(),
	};
}

function listRunRoots(cwd: string): string[] {
	const base = findRepoRoot(cwd) ? projectCrewRoot(cwd) : userCrewRoot();
	return [path.join(base, DEFAULT_PATHS.state.runsSubdir)];
}

function collectRoots(root: string): ParsedEntry[] {
	if (!fs.existsSync(root)) return [];
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.length > 0)
		.map((entry) => ({ runId: entry, path: manifestPathForRun(root, entry) }));
}

export function createManifestCache(cwd: string, options: ManifestCacheOptions = {}): ManifestCache {
	const ttlMs = options.debounceMs ?? DEFAULT_TTL_MS;
	const maxEntries = options.maxEntries ?? DEFAULT_CACHE.manifestMaxEntries;
	const roots = listRunRoots(cwd);
	const manifestIndex = new Map<string, CachedManifest>();
	const listCache = new Map<number, CachedList>();
	let listTimer: ReturnType<typeof setTimeout> | undefined;
	let watchers: fs.FSWatcher[] = [];

	function invalidate(runId?: string): void {
		if (runId) {
			manifestIndex.delete(runId);
		} else {
			manifestIndex.clear();
		}
		listCache.clear();
	}

	function scheduleListRefresh(): void {
		if (listTimer) {
			clearTimeout(listTimer);
		}
		listTimer = setTimeout(() => {
			listTimer = undefined;
			listCache.clear();
		}, ttlMs);
		listTimer.unref?.();
	}

	function loadManifest(runId: string, rootsToCheck: string[]): CachedManifest | undefined {
		let cached = manifestIndex.get(runId);
		for (const root of rootsToCheck) {
			const manifestPath = manifestPathForRun(root, runId);
			const parsed = parseManifestIfChanged(manifestPath, cached);
			if (parsed) {
				if (!cached || parsed.mtimeMs !== cached.mtimeMs || parsed.size !== cached.size) {
					manifestIndex.set(runId, parsed);
					if (manifestIndex.size > maxEntries) {
						const oldest = [...manifestIndex.values()].sort((a, b) => a.loadedAtMs - b.loadedAtMs)[0];
						if (oldest) manifestIndex.delete(oldest.manifest.runId);
					}
				}
				return manifestIndex.get(runId);
			}
		}
		return undefined;
	}

	function list(limit = DEFAULT_CACHE.manifestMaxEntries): TeamRunManifest[] {
		const now = Date.now();
		const cached = listCache.get(limit);
		if (cached && cached.expireAtMs > now) {
			return cached.runs;
		}
		const parsedEntries = roots.flatMap((root) => collectRoots(root));
		const unique = new Map<string, CachedManifest | undefined>();
		for (const entry of parsedEntries) {
			if (entry.runId.length === 0) continue;
			let cached = manifestIndex.get(entry.runId);
			const parsed = parseManifestIfChanged(entry.path, cached);
			if (parsed) {
				cached = parsed;
				manifestIndex.set(entry.runId, cached);
			}
			if (cached) unique.set(entry.runId, cached);
		}


		const runs = [...unique.values()].filter((value): value is CachedManifest => value !== undefined).map((value) => value.manifest);
		const sorted = runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		const limited = sorted.slice(0, Math.max(0, limit));
		if (manifestIndex.size > maxEntries) {
			const removeCount = manifestIndex.size - maxEntries;
			const oldest = [...manifestIndex.values()].sort((a, b) => a.loadedAtMs - b.loadedAtMs).slice(0, removeCount);
			for (const entry of oldest) manifestIndex.delete(entry.manifest.runId);
		}
		const result = limited;
		listCache.set(limit, { runs: result, limit, expireAtMs: now + ttlMs });
		return result;
	}

	function get(runId: string): TeamRunManifest | undefined {
		const cached = loadManifest(runId, roots);
		if (cached) return cached.manifest;
		return undefined;
	}

	if (options.watch ?? true) {
		for (const root of roots) {
			const watcher = watchWithErrorHandler(root, () => {
				scheduleListRefresh();
			}, () => {
				scheduleListRefresh();
			});
			if (watcher) {
				watcher.unref?.();
				watchers.push(watcher);
			}
		}
	}

	return {
		list,
		get,
		clear(runId) {
			invalidate(runId);
		},
		dispose() {
			if (listTimer) {
				clearTimeout(listTimer);
				listTimer = undefined;
			}
			for (const watcher of watchers) closeWatcher(watcher);
			watchers = [];
			manifestIndex.clear();
			listCache.clear();
		},
	};
}
