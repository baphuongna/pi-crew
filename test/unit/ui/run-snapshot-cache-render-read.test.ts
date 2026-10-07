/**
 * L5 (real-test 2026-10-07, report §L5): the paint path must not pay for a
 * sync full-rebuild. `RunSnapshotCache.readForRender(runId)` is the additive
 * read-only accessor for render call sites (live-run-sidebar, run-dashboard,
 * render-loop): it returns the CACHED snapshot, never sync-rebuilds, returns
 * undefined for a missing entry, and schedules the EXISTING coalesced async
 * refresh (scheduleRefresh pipeline) when the entry's TTL has lapsed.
 *
 * Tier 11a (read-your-writes): refresh()/refreshIfStale() keep their sync
 * build paths — pinned separately by run-snapshot-cache-sync-parity.test.ts,
 * which must stay green UNMODIFIED (this file adds pins only; it changes
 * nothing about the sync path).
 *
 * INSTRUMENTATION NOTE: same constraint as
 * test/unit/ui/run-snapshot-coalesced-refresh.test.ts — Node builtin/module
 * ESM namespaces are non-configurable on this toolchain, so fs spying is not
 * available. "No sync rebuild" is pinned via snapshot IDENTITY: every real
 * rebuild (build/buildAsync) mints a fresh snapshot object with a new
 * fetchedAt, while readForRender must hand back the SAME reference it was
 * primed with even when tasks.json on disk has already changed.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { createRunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";

function tempCwd(prefix: string): string {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// Resolve to long-name form (e.g. C:\Users\runneradmin\...) to match
	// what projectCrewRoot returns via canonicalizePath. This ensures
	// the worktree path and state root are in the same form.
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		try {
			cwd = fs.realpathSync(cwd);
		} catch {
			/* keep as-is */
		}
	}
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function fixtures(
	cwd: string,
	goal: string,
): {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
} {
	const team = {
		name: "fast-fix",
		description: "",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "fast-fix",
		description: "",
		steps: [{ id: "explore", role: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal,
	});
	saveRunManifest({ ...created.manifest, status: "running" }, { allowTerminalExit: true });
	saveCrewAgents(created.manifest, [
		{
			id: `${created.manifest.runId}:01`,
			runId: created.manifest.runId,
			taskId: created.tasks[0]?.id ?? "explore",
			agent: "explorer",
			role: "explorer",
			startedAt: created.manifest.createdAt,
			runtime: "child-process",
			status: "running",
			progress: {
				recentTools: [],
				recentOutput: ["first"],
				toolCount: 1,
				currentTool: "read",
				tokens: 10,
			},
		},
	]);
	return { manifest: created.manifest, tasks: created.tasks };
}

function completedTasks(tasks: TeamTaskState[]): TeamTaskState[] {
	return tasks.map((task) => ({
		...task,
		status: "completed",
		usage: { input: 10, output: 20 },
	}));
}

test("readForRender returns the cached snapshot without a sync rebuild (pin a)", () => {
	const cwd = tempCwd("pi-crew-render-read-cached-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd, "render-read-cached");
		// ttlMs: 0 — every read sees a lapsed TTL, so the TTL shortcut cannot
		// mask a sync rebuild: a refreshIfStale-shaped implementation would
		// stat, see changed stamps, and rebuild ON THIS READ. readForRender
		// must still hand back the cached reference.
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const primed = cache.refresh(manifest.runId);
		assert.equal(primed.progress.completed, 0);

		// Disk changes BEFORE the paint read — the sync-rebuild smell is
		// exactly "read reflects a change that was only validated by doing
		// disk work during the read".
		saveRunTasks(manifest, completedTasks(tasks));

		// A burst of paint reads in one synchronous block: no timer or async
		// task can interleave, so every read must be the SAME cached object.
		for (let i = 0; i < 5; i += 1) {
			const seen: RunUiSnapshot | undefined = cache.readForRender(manifest.runId);
			assert.ok(seen, "cached entry must be served, not dropped");
			assert.equal(seen, primed, "readForRender must return the cached reference, never a rebuilt one");
			assert.equal(seen.progress.completed, 0, "a sync rebuild would have surfaced the on-disk completion");
			assert.equal(seen.fetchedAt, primed.fetchedAt, "no rebuild mints a new fetchedAt");
		}
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readForRender schedules a coalesced async refresh when stamps go stale (pin b)", async () => {
	const cwd = tempCwd("pi-crew-render-read-stale-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd, "render-read-stale");
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const primed = cache.refresh(manifest.runId);
		assert.equal(primed.progress.completed, 0);

		saveRunTasks(manifest, completedTasks(tasks));

		// 5 paint reads in a tight loop — one 80ms coalesced timer must absorb
		// them (same contract as scheduleRefresh's watcher burst).
		for (let i = 0; i < 5; i += 1) cache.readForRender(manifest.runId);

		// FLICKER FIX contract: the entry never goes missing while the async
		// rebuild is pending — buildAsync re-sets the entry in place. Poll
		// snapshot identity for ~300ms (past the 80ms coalesce + async build):
		// distinct references beyond `primed` are the landed rebuilds.
		const seen = new Set<RunUiSnapshot>([primed]);
		let missing = 0;
		for (let i = 0; i < 60; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const snap = cache.get(manifest.runId);
			if (!snap) missing += 1;
			else seen.add(snap);
		}
		const rebuilds = seen.size - 1;
		assert.equal(missing, 0, "cache entry must stay populated across the whole window");
		assert.ok(rebuilds >= 1, "the scheduled coalesced refresh must land the stale-stamp rebuild");
		assert.ok(rebuilds <= 2, `5 tight-loop reads must coalesce to at most 2 rebuilds (saw ${rebuilds})`);
		const final = cache.get(manifest.runId);
		assert.ok(final, "cache entry must remain populated after the coalesced refresh");
		assert.equal(final.progress.completed, 1, "the async rebuild must reflect the changed tasks.json");
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readForRender returns undefined for an unknown runId without building (pin c)", async () => {
	const cwd = tempCwd("pi-crew-render-read-unknown-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		// A real run exists — proving the cache works — but the read targets a
		// different, unknown id.
		fixtures(cwd, "render-read-unknown");
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const cacheRef = cache;
		// Contrast with refreshIfStale(), which THROWS for an unknown run.
		let seen: RunUiSnapshot | undefined;
		let threw = false;
		try {
			seen = cacheRef.readForRender("no-such-run");
		} catch {
			threw = true;
		}
		assert.equal(threw, false, "readForRender must not throw for an unknown runId");
		assert.equal(seen, undefined, "unknown runId must return undefined, not a built snapshot");
		assert.equal(cache.snapshotsByKey().size, 0, "no entry may be created for the unknown runId");
		// Past the 80ms coalesce window: the accessor must not have scheduled
		// a build for the unknown id either (nothing may land asynchronously).
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(cache.get("no-such-run"), undefined, "nothing may land in the cache for the unknown runId");
		assert.equal(cache.snapshotsByKey().size, 0);
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readForRender touches LRU/access so a paint read protects the entry from eviction", () => {
	const cwd = tempCwd("pi-crew-render-read-lru-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const a = fixtures(cwd, "render-read-lru-a");
		const b = fixtures(cwd, "render-read-lru-b");
		const c = fixtures(cwd, "render-read-lru-c");
		cache = createRunSnapshotCache(cwd, { ttlMs: 0, maxEntries: 2 });
		const primedA = cache.refresh(a.manifest.runId);
		cache.refresh(b.manifest.runId);

		// Paint-read A: must move it to the LRU tail so the NEXT insert evicts
		// the least-recently-used entry (B), not A.
		const readA = cache.readForRender(a.manifest.runId);
		assert.equal(readA, primedA, "readForRender must serve the cached reference");

		cache.refresh(c.manifest.runId);
		assert.ok(cache.get(a.manifest.runId), "recently readForRender'd entry must survive eviction");
		assert.equal(cache.get(b.manifest.runId), undefined, "the least-recently-used entry is the one evicted");
		assert.ok(cache.get(c.manifest.runId), "the freshly inserted entry must survive eviction");
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("readForRender with a fresh TTL does zero work beyond the cache hit", async () => {
	const cwd = tempCwd("pi-crew-render-read-fresh-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd, "render-read-fresh");
		// Default-like TTL: the entry is freshly loaded, so the read is a pure
		// cache hit — no refresh scheduled, identical reference served.
		cache = createRunSnapshotCache(cwd, { ttlMs: 60_000 });
		const primed = cache.refresh(manifest.runId);
		// Change disk anyway: even if a (buggy) implementation stat'ed and
		// scheduled, the synchronous contract is still the cached reference;
		// with a fresh TTL nothing should even be scheduled.
		saveRunTasks(manifest, completedTasks(tasks));
		for (let i = 0; i < 3; i += 1) {
			const seen = cache.readForRender(manifest.runId);
			assert.equal(seen, primed);
		}
		// Wait past the 80ms coalesce window: with a fresh TTL no refresh was
		// scheduled, so no async rebuild may land (an always-schedule
		// implementation would rebuild and swap the reference here).
		await new Promise((resolve) => setTimeout(resolve, 150));
		const snap = cache.get(manifest.runId);
		assert.equal(snap, primed, "fresh-TTL reads must not schedule a rebuild that lands early");
		assert.equal(snap?.progress.completed, 0);
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
