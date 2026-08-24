import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";
import { activeRunEntries } from "../state/stores/active-run-registry.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { closeWatcher, watchWithErrorHandler } from "../utils/fs-watch.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { isSafePathId, resolveContainedRelativePath, resolveRealContainedPath } from "../utils/safe-paths.ts";

export interface ManifestCache {
	list(limit?: number): TeamRunManifest[];
	/**
	 * Return ONLY running manifests, capped only by `limit`.
	 *
	 * RT-F3: unlike `list(limit)`, this filters `status === "running"` BEFORE
	 * the limit is applied so stale orphaned runs that have been pushed past
	 * the top-N by recent activity are not silently hidden from crash-recovery
	 * and zombie-detection scans.
	 */
	listActive(limit: number): TeamRunManifest[];
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
	/**
	 * PERF (task-23a): timestamp of the last real statSync of this manifest.
	 * parseManifestIfChanged() skips the stat entirely while the entry is
	 * younger than the stat TTL (default 250ms), so back-to-back list() /
	 * listActive() scans do not re-stat every manifest on every 500ms list
	 * TTL expiry. Bounded staleness: a manifest change is picked up at most
	 * statTtlMs late on the scan path (watcher-driven refreshes bypass this
	 * with forceStat).
	 */
	statCheckedAtMs: number;
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
	/**
	 * PERF (task-23a): how long a cached manifest skips re-statting on scan
	 * (default 250ms). Exposed mainly so tests can pin the window
	 * deterministically.
	 */
	statTtlMs?: number;
}

const DEFAULT_TTL_MS = 500;
const DEFAULT_STAT_TTL_MS = 250;

interface ParsedEntry {
	runId: string;
	path: string;
	manifest?: TeamRunManifest;
}

function manifestPathForRun(root: string, runId: string): string | undefined {
	if (!isSafePathId(runId)) return undefined;
	try {
		return path.join(resolveRealContainedPath(root, runId), DEFAULT_PATHS.state.manifestFile);
	} catch {
		return undefined;
	}
}

function parseManifest(filePath: string): TeamRunManifest | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf-8")) as TeamRunManifest;
	} catch {
		return undefined;
	}
}

function sameFilesystemPath(left: string, right: string): boolean {
	if (path.resolve(left) === path.resolve(right)) return true;
	try {
		return fs.realpathSync.native(left) === fs.realpathSync.native(right);
	} catch {
		return false;
	}
}

function validateManifestForRoot(root: string, runId: string, manifest: TeamRunManifest): boolean {
	try {
		if (!isSafePathId(runId)) return false;
		const stateRoot = resolveContainedRelativePath(root, runId, "runId");
		const crewRoot = path.dirname(path.dirname(root));
		const artifactsRoot = resolveContainedRelativePath(path.join(crewRoot, DEFAULT_PATHS.state.artifactsSubdir), runId, "runId");
		if (
			manifest.runId !== runId ||
			!sameFilesystemPath(manifest.stateRoot, stateRoot) ||
			!sameFilesystemPath(manifest.tasksPath, path.join(stateRoot, DEFAULT_PATHS.state.tasksFile)) ||
			!sameFilesystemPath(manifest.eventsPath, path.join(stateRoot, DEFAULT_PATHS.state.eventsFile)) ||
			!sameFilesystemPath(manifest.artifactsRoot, artifactsRoot)
		)
			return false;
		if (fs.existsSync(artifactsRoot)) {
			if (fs.lstatSync(artifactsRoot).isSymbolicLink()) return false;
			resolveRealContainedPath(path.dirname(artifactsRoot), path.basename(artifactsRoot));
		}
		return true;
	} catch {
		return false;
	}
}

function parseManifestIfChanged(
	root: string,
	runId: string,
	filePath: string,
	previous?: CachedManifest,
	forceStat = false,
	statTtlMs = DEFAULT_STAT_TTL_MS,
): CachedManifest | undefined {
	if (!forceStat && previous && Date.now() - previous.statCheckedAtMs < statTtlMs) {
		// PERF (task-23a): stat'ed very recently and not forcibly invalidated —
		// the stat (and any parse behind it) cannot have changed the verdict.
		// This bounds per-scan stat cost to ~1/statTtlMs per manifest instead
		// of one per list() TTL expiry.
		return previous;
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(filePath);
	} catch {
		return undefined;
	}
	if (previous) {
		previous.statCheckedAtMs = Date.now();
	}
	if (previous && previous.mtimeMs === stat.mtimeMs && previous.size === stat.size) {
		// P1-9: the manifest file is unchanged, so its recorded paths and their
		// containment verdict are unchanged too — skip the ~10-syscall
		// validateManifestForRoot re-check on cache hit. list() and listActive()
		// both scan within the same TTL window, so the second scan is now free.
		return previous;
	}
	const manifest = parseManifest(filePath);
	if (!manifest || !validateManifestForRoot(root, runId, manifest)) return undefined;
	return {
		path: filePath,
		manifest,
		mtimeMs: stat.mtimeMs,
		size: stat.size,
		loadedAtMs: Date.now(),
		statCheckedAtMs: Date.now(),
	};
}

function listRunRoots(cwd: string): string[] {
	const roots = new Set<string>();
	// Always include user-level runs (fast-fix, direct-agent, etc. write here)
	roots.add(path.join(userCrewRoot(), DEFAULT_PATHS.state.runsSubdir));
	const projectRoot = findRepoRoot(cwd);
	if (projectRoot) roots.add(path.join(projectCrewRoot(cwd), DEFAULT_PATHS.state.runsSubdir));
	return [...roots];
}

// PERF (2026-08-24, task-23b): list()/listActive() re-readdir'd every run
// root on each 500ms TTL expiry. A runs root's own mtimeMs only changes when
// direct entries (run dirs) are added/removed/renamed — exactly and only when
// the listing must refresh — so the fully-mapped ParsedEntry[] is cached
// against it. Manifest rewrites happen one level down (inside a run dir) and
// never touch the root's mtime; they are picked up by the per-run stat in
// parseManifestIfChanged. Caching the MAPPED entries (not just the raw names)
// also skips the manifestPathForRun resolution (realpath + O_NOFOLLOW
// ancestor walk, ~10 syscalls per run) for unchanged listings: an unchanged
// root now costs a single statSync instead of existsSync + readdir + N walks.
const DIR_LIST_CACHE_MAX_ROOTS = 64;
const dirListCache = new Map<string, { mtimeMs: number; entries: ParsedEntry[] }>();

function collectRoots(root: string): ParsedEntry[] {
	let mtimeMs: number;
	try {
		mtimeMs = fs.statSync(root).mtimeMs;
	} catch {
		return [];
	}
	const cached = dirListCache.get(root);
	if (cached && cached.mtimeMs === mtimeMs) {
		return cached.entries;
	}
	let entries: string[];
	try {
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	const mapped = entries
		.filter((entry) => entry.length > 0 && isSafePathId(entry))
		.map((entry) => ({
			runId: entry,
			path: manifestPathForRun(root, entry),
		}))
		.filter((entry): entry is ParsedEntry => entry.path !== undefined);
	// Bounded growth: the map is module-scoped and shared across cache
	// instances (tests, multi-project sessions); roots are few, but stale
	// tempdir roots from finished tests would otherwise linger forever.
	if (dirListCache.size >= DIR_LIST_CACHE_MAX_ROOTS) dirListCache.clear();
	dirListCache.set(root, { mtimeMs, entries: mapped });
	return mapped;
}

export function createManifestCache(cwd: string, options: ManifestCacheOptions = {}): ManifestCache {
	const ttlMs = options.debounceMs ?? DEFAULT_TTL_MS;
	const statTtlMs = options.statTtlMs ?? DEFAULT_STAT_TTL_MS;
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
		invalidateListActive();
	}

	function scheduleListRefresh(): void {
		if (listTimer) {
			clearTimeout(listTimer);
		}
		listTimer = setTimeout(() => {
			const timer = listTimer;
			listTimer = undefined;
			listCache.clear();
			invalidateListActive();
			timer?.unref();
		}, ttlMs);
		// Unref immediately so the timer never blocks process exit (defense in
		// depth: the in-callback unref above may not run if shutdown happens
		// before the timer fires).
		listTimer.unref();
		// FIND-03: invalidate the listActive() cache eagerly on every watcher
		// tick. The TTL is the fallback for missed events; the watcher-driven
		// path gives the tightest possible invalidation.
		invalidateListActive();
	}

	function loadManifest(runId: string, rootsToCheck: string[]): CachedManifest | undefined {
		const cached = manifestIndex.get(runId);
		if (!isSafePathId(runId)) return undefined;
		const activeEntry = activeRunEntries().find((entry) => entry.runId === runId);
		if (activeEntry) {
			const activeRoot = path.dirname(activeEntry.stateRoot);
			const parsed = parseManifestIfChanged(activeRoot, runId, activeEntry.manifestPath, cached, false, statTtlMs);
			if (parsed) {
				manifestIndex.set(runId, parsed);
				return parsed;
			}
		}
		for (const root of rootsToCheck) {
			const manifestPath = manifestPathForRun(root, runId);
			if (!manifestPath) continue;
			const parsed = parseManifestIfChanged(root, runId, manifestPath, cached, false, statTtlMs);
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

	/**
	 * NOTE (RT-F10, updated 2026-08-24): the original "full FS scan +
	 * JSON.parse on every TTL expiry" cost is now layered:
	 *   1. collectRoots() reuses a cached dir listing keyed by the runs root's
	 *      own mtimeMs — one statSync per root replaces existsSync + readdir +
	 *      the per-run manifestPathForRun resolution when no run dir was
	 *      added/removed/renamed.
	 *   2. parseManifestIfChanged() skips the per-manifest stat for statTtlMs
	 *      (default 250ms) after the last check, so scans re-stat each run at
	 *      most ~4x/sec regardless of how often the list TTL lapses.
	 *   3. JSON.parse only happens when mtime+size actually changed.
	 * What remains per 500ms expiry: one stat per runs root, one stat per run
	 * whose stat TTL lapsed, and the in-memory merge + sort. fs.watch events
	 * that carry a filename refresh just that run (forceStat) and expire the
	 * list caches immediately instead of triggering a wholesale refresh (see
	 * handleWatchEvent below).
	 */
	function list(limit = DEFAULT_CACHE.manifestMaxEntries): TeamRunManifest[] {
		const now = Date.now();
		const cached = listCache.get(limit);
		if (cached && cached.expireAtMs > now) {
			return cached.runs;
		}
		const parsedEntries = [
			...roots.flatMap((root) => collectRoots(root)),
			...activeRunEntries().map((entry) => ({
				runId: entry.runId,
				path: entry.manifestPath,
			})),
		];
		const unique = new Map<string, CachedManifest | undefined>();
		for (const entry of parsedEntries) {
			if (entry.runId.length === 0) continue;
			let cached = manifestIndex.get(entry.runId);
			const root = path.dirname(path.dirname(entry.path));
			const parsed = parseManifestIfChanged(root, entry.runId, entry.path, cached, false, statTtlMs);
			if (parsed) {
				cached = parsed;
				manifestIndex.set(entry.runId, cached);
			}
			if (cached) unique.set(entry.runId, cached);
		}

		const runs = [...unique.values()].filter((value): value is CachedManifest => value !== undefined).map((value) => value.manifest);
		// PERF (task-23d): ISO-8601 createdAt strings are fixed-width and sort
		// correctly with plain comparison — no locale machinery per compare.
		const sorted = runs.sort((a, b) => ((b.createdAt ?? "") < (a.createdAt ?? "") ? -1 : (b.createdAt ?? "") > (a.createdAt ?? "") ? 1 : 0));
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

	// FIND-03: short-TTL cache for listActive(). Mirrors the listCache pattern
	// used by list(): we cache the un-capped running set and apply the caller's
	// `limit` post-hoc on every return. Storing the full set (not a
	// limit-sliced array) is what preserves the RT-F3 contract — callers with
	// different `limit` values all see the same underlying "every running run"
	// result, never a top-N createdAt-filtered view.
	let listActiveCache: { result: TeamRunManifest[] | null; expiresAt: number } = { result: null, expiresAt: 0 };

	function invalidateListActive(): void {
		listActiveCache = { result: null, expiresAt: 0 };
	}

	/**
	 * RT-F3: filter to `status === "running"` BEFORE applying the limit so an
	 * orphaned run that has been pushed past the top-N by recent successful
	 * runs is still surfaced to crash-recovery. The cap is the LIMIT, not the
	 * "top-N most recent"; callers (e.g. zombie detection) explicitly want
	 * EVERY currently-running run, in any order.
	 *
	 * Internally performs a full scan (NOT via list()) so the cap doesn't
	 * silently drop "running" runs that fell past the top-N createdAt cutoff.
	 * Still goes through parseManifestIfChanged for stat+size memoization, so
	 * the per-run I/O cost is the same as list().
	 *
	 * FIND-03 perf: the full scan is memoized behind a 500ms TTL (same TTL as
	 * list()). fs.watch-driven scheduleListRefresh() invalidates the cache
	 * immediately so the next call re-scans. The cap is applied AFTER the
	 * cache lookup so a cached scan result can be sliced to ANY limit without
	 * re-scanning.
	 */
	function listActive(limit: number): TeamRunManifest[] {
		const cap = Math.max(0, limit);
		const now = Date.now();
		if (listActiveCache.result !== null && listActiveCache.expiresAt > now) {
			return listActiveCache.result.slice(0, cap);
		}
		const parsedEntries = [
			...roots.flatMap((root) => collectRoots(root)),
			...activeRunEntries().map((entry) => ({
				runId: entry.runId,
				path: entry.manifestPath,
			})),
		];
		const unique = new Map<string, CachedManifest | undefined>();
		for (const entry of parsedEntries) {
			if (entry.runId.length === 0) continue;
			let cached = manifestIndex.get(entry.runId);
			const root = path.dirname(path.dirname(entry.path));
			const parsed = parseManifestIfChanged(root, entry.runId, entry.path, cached, false, statTtlMs);
			if (parsed) {
				cached = parsed;
				manifestIndex.set(entry.runId, cached);
			}
			if (cached) unique.set(entry.runId, cached);
		}
		const running = [...unique.values()]
			.filter((value): value is CachedManifest => value !== undefined)
			.map((value) => value.manifest)
			.filter((manifest) => manifest.status === "running");
		listActiveCache = { result: running, expiresAt: now + ttlMs };
		return running.slice(0, cap);
	}

	// PERF (task-23c): the runs-root watcher reports the direct child that
	// changed in `filename` (a run dir added/removed/renamed — the watcher is
	// non-recursive, so manifest rewrites one level down never reach it).
	// Refresh ONLY that run — forceStat bypasses the statTtlMs skip so a
	// just-checked run still re-stats — and expire the list caches so the
	// next list()/listActive() re-collects roots and re-sorts. Events without
	// a usable filename (null, Buffer, non-run-id names like ".DS_Store")
	// fall back to the wholesale debounced refresh.
	function handleWatchEvent(root: string, filename: string | Buffer | null): void {
		if (typeof filename !== "string" || !isSafePathId(filename)) {
			scheduleListRefresh();
			return;
		}
		const manifestPath = manifestPathForRun(root, filename);
		if (manifestPath) {
			const parsed = parseManifestIfChanged(root, filename, manifestPath, manifestIndex.get(filename), /* forceStat */ true, statTtlMs);
			if (parsed) {
				manifestIndex.set(filename, parsed);
			} else {
				// Run dir (or its manifest) is gone — drop the cached entry so
				// the next scan does not serve a stale manifest.
				manifestIndex.delete(filename);
			}
		}
		listCache.clear();
		invalidateListActive();
	}

	if (options.watch ?? true) {
		for (const root of roots) {
			const watcher = watchWithErrorHandler(
				root,
				(_eventType, filename) => {
					handleWatchEvent(root, filename);
				},
				() => {
					scheduleListRefresh();
				},
			);
			if (watcher) {
				watcher.unref();
				watchers.push(watcher);
			}
		}
	}

	return {
		list,
		listActive,
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
			invalidateListActive();
		},
	};
}
