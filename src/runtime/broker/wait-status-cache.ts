/**
 * wait-status-cache.ts — R10-3: mtime+size-gated load cache for task.waitStatus.
 *
 * Problem (docs/refactor-plan.review.md §Round 10, R10-3): the broker's
 * task.waitStatus poll loop ticks every 200ms per waiter and each tick calls
 * loadRunManifestById() — stat manifest + stat tasks + (on the state-store
 * manifest-cache miss, which every write invalidates via generation bump) a
 * full parse of BOTH manifest.json and tasks.json. With N concurrent waiters
 * on a busy run that is ~5-10 syscalls × 5 ticks/sec × N.
 *
 * Fix: each BROKER INSTANCE holds one WaitStatusCache (Map keyed by runId —
 * the broker serves a single cwd). Per tick it stats only manifest.json and
 * tasks.json (via the exact same path derivation loadRunManifestById uses
 * internally: createRunPaths → scopeBaseRoot(cwd)); the expensive
 * loadRunManifestById() is invoked only when mtimeMs or size changed. All
 * waiters on the broker share the entry, so a never-changing run costs ONE
 * parse total (initial) instead of N×polls.
 *
 * Semantics vs the uncached path:
 *  - Observable behavior is identical: waiters still poll on the same 200ms
 *    schedule; they just avoid the parse when nothing changed. A status
 *    change on disk always lands via an atomic rename (new mtime), so the
 *    next tick re-parses and wakes the waiter within one poll (mtimeMs on
 *    Linux/macOS has sub-millisecond precision; on FAT-derived filesystems
 *    with coarse 1-2s mtime granularity staleness is bounded by that
 *    granularity — the same tradeoff the state-store manifestCache makes).
 *  - The actual parse is delegated to loadRunManifestById itself, so all of
 *    its correctness semantics (Windows stat retry, sentinel retry loop,
 *    STATE-3 quarantine, validateRunManifestPaths containment/symlink
 *    checks) still run at every reload boundary. Between reloads we serve
 *    the cached parse, exactly like the in-store manifestCache does.
 *  - A run whose files are missing gets a 0/0 stamp; while they stay
 *    missing, ticks return the cached undefined ("no-manifest" error),
 *    matching the uncached behavior of re-resolving to undefined.
 *
 * Memory: entries are evicted when a run's last broker connection closes
 * (see crew-broker.ts cleanup) and by a hard FIFO cap, so long-lived
 * brokers cannot grow the Map without bound across runs.
 */

import * as fs from "node:fs";
import { createRunPaths, loadRunManifestById } from "../../state/stores/state-store.ts";

/** Shape returned by loadRunManifestById (derived — no duplicate type imports). */
type LoadedRun = ReturnType<typeof loadRunManifestById>;

/** Loader seam: defaults to the real loadRunManifestById; tests inject a spy. */
export type WaitStatusLoader = (cwd: string, runId: string) => LoadedRun;

interface WaitStatusCacheEntry {
	manifestMtimeMs: number;
	manifestSize: number;
	tasksMtimeMs: number;
	tasksSize: number;
	loaded: LoadedRun;
}

/** Hard cap so a pathological broker (many runs, no close events) stays bounded. */
const WAIT_STATUS_CACHE_MAX = 128;

interface StatStamp {
	manifestMtimeMs: number;
	manifestSize: number;
	tasksMtimeMs: number;
	tasksSize: number;
}

/** Stat manifest+tasks; a missing/unstattable file is represented as 0/0. */
function statStamp(manifestPath: string, tasksPath: string): StatStamp {
	let manifestMtimeMs = 0;
	let manifestSize = 0;
	let tasksMtimeMs = 0;
	let tasksSize = 0;
	try {
		const st = fs.statSync(manifestPath);
		manifestMtimeMs = st.mtimeMs;
		manifestSize = st.size;
	} catch {
		/* missing or transient — treat as 0/0 */
	}
	try {
		const st = fs.statSync(tasksPath);
		tasksMtimeMs = st.mtimeMs;
		tasksSize = st.size;
	} catch {
		/* missing or transient — treat as 0/0 */
	}
	return { manifestMtimeMs, manifestSize, tasksMtimeMs, tasksSize };
}

function sameStamp(a: StatStamp, b: StatStamp): boolean {
	return (
		a.manifestMtimeMs === b.manifestMtimeMs &&
		a.manifestSize === b.manifestSize &&
		a.tasksMtimeMs === b.tasksMtimeMs &&
		a.tasksSize === b.tasksSize
	);
}

export class WaitStatusCache {
	private readonly entries = new Map<string, WaitStatusCacheEntry>();
	private readonly loader: WaitStatusLoader;
	private reloadsValue = 0;

	constructor(options: { loader?: WaitStatusLoader } = {}) {
		this.loader = options.loader ?? loadRunManifestById;
	}

	/** Diagnostic: number of times the (expensive) loader has been invoked. */
	get reloads(): number {
		return this.reloadsValue;
	}

	/** Diagnostic: number of cached runs. */
	get size(): number {
		return this.entries.size;
	}

	/**
	 * Stat-gated load. Fast path (stamp unchanged): 2 statSync calls, zero
	 * parses. Slow path (first sight or changed mtime/size): delegate to the
	 * loader, then record the POST-load stamp so a concurrent writer that
	 * landed between our pre-load stat and the parse forces the next tick to
	 * reload instead of serving a stale entry.
	 */
	load(cwd: string, runId: string): LoadedRun {
		// Same path derivation as resolveRunStateRoot inside
		// loadRunManifestById (scopeBaseRoot(cwd) + runs subdir + contained
		// runId) — createRunPaths exposes exactly that derivation publicly.
		const paths = createRunPaths(cwd, runId);
		const before = statStamp(paths.manifestPath, paths.tasksPath);
		const cached = this.entries.get(runId);
		if (cached && sameStamp(cached, before)) {
			return cached.loaded;
		}
		const loaded = this.loader(cwd, runId);
		this.reloadsValue += 1;
		const after = statStamp(paths.manifestPath, paths.tasksPath);
		if (this.entries.size >= WAIT_STATUS_CACHE_MAX && !this.entries.has(runId)) {
			// Map preserves insertion order — evict the oldest entry.
			const oldest = this.entries.keys().next().value;
			if (oldest !== undefined) this.entries.delete(oldest);
		}
		this.entries.set(runId, { ...after, loaded });
		return loaded;
	}

	/** Evict one run's entry (called when its last broker connection closes). */
	delete(runId: string): void {
		this.entries.delete(runId);
	}

	/** Drop everything (tests / broker stop). */
	clear(): void {
		this.entries.clear();
	}
}
