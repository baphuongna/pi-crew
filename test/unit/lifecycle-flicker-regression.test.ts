/**
 * Regression coverage for the UI flicker fix (2026-07-20).
 *
 * Root cause: three hot-path call sites in lifecycle-handlers.ts hard-deleted
 * snapshot-cache entries. The worst — `onInvalidate` — received a no-runId
 * payload from EVERY RenderScheduler fallback tick (~160ms while a run is
 * active) and ran `cache.invalidate(undefined)`, which clears ALL entries.
 * `activeWidgetRuns` then dropped every run to "(loading…)" until the async
 * preload rebuilt the cache → continuous flicker.
 *
 * Fix: never hard-delete from the render path. A no-runId tick is a no-op;
 * a specific runId calls `refreshIfStale` (stale-while-revalidate); the
 * fs.watch change handlers call `refresh` (rebuild-in-place). All three keep
 * the entry populated so `get(runId)` never returns undefined.
 *
 * These tests pin the contract the fixed handlers rely on, plus characterize
 * the destructive `invalidate(undefined)` so the trap cannot silently return.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";
import { RenderScheduler } from "../../src/ui/render-scheduler.ts";
import { createRunSnapshotCache } from "../../src/ui/run-snapshot-cache.ts";
import { activeWidgetRuns } from "../../src/ui/widget/widget-model.ts";

function tempCwd(prefix: string): string {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function fixtures(cwd: string): { manifest: TeamRunManifest } {
	const team = {
		name: "default",
		description: "",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "builtin",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "default",
		description: "",
		steps: [{ id: "explore", role: "explorer" }],
		source: "builtin",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "flicker" });
	const manifest: TeamRunManifest = { ...created.manifest, status: "running" };
	saveRunManifest(manifest);
	saveRunTasks(manifest, created.tasks);
	saveCrewAgents(manifest, [
		{
			id: `${manifest.runId}:01`,
			runId: manifest.runId,
			taskId: created.tasks[0]?.id ?? "explore",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "running",
			startedAt: manifest.createdAt,
			progress: { recentTools: [], recentOutput: ["hi"], toolCount: 1, currentTool: "read", tokens: 1 },
		},
	]);
	return { manifest };
}

/** Replicates the FIXED `onInvalidate` contract from lifecycle-handlers.ts. */
function makeOnInvalidate(
	cache: ReturnType<typeof createRunSnapshotCache>,
): (payload: unknown) => void {
	return (payload: unknown) => {
		const runId =
			payload !== null &&
			typeof payload === "object" &&
			"runId" in payload &&
			typeof (payload as { runId: unknown }).runId === "string"
				? (payload as { runId: string }).runId
				: undefined;
		// FLICKER FIX: a no-runId tick must do nothing (previously
		// `invalidate(undefined)` → `entries.clear()`).
		if (!runId) return;
		try {
			cache.refreshIfStale(runId);
		} catch {
			/* best-effort */
		}
	};
}

/** Replicates the FIXED `onRunChange`/`crewRunWatcherOnChange` contract. */
function makeOnChange(
	cache: ReturnType<typeof createRunSnapshotCache>,
): (runId: string) => void {
	return (runId: string) => {
		try {
			cache.refresh(runId);
		} catch {
			/* best-effort */
		}
	};
}

class FakeEvents {
	private handlers = new Map<string, Set<(payload: unknown) => void>>();
	on(event: string, handler: (payload: unknown) => void): () => void {
		const set = this.handlers.get(event) ?? new Set();
		set.add(handler);
		this.handlers.set(event, set);
		return () => set.delete(handler);
	}
}

test("characterization: invalidate(undefined) clears ALL entries — the trap the fix avoids", () => {
	const cwd = tempCwd("pi-flicker-char-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		cache.refresh(manifest.runId);
		assert.equal(cache.get(manifest.runId) !== undefined, true, "precondition: entry populated");
		// The destructive primitive the OLD onInvalidate invoked on every tick.
		cache.invalidate(undefined);
		assert.equal(cache.get(manifest.runId), undefined, "invalidate(undefined) wipes the whole cache");
		assert.equal(cache.snapshotsByKey().size, 0, "snapshotsByKey is empty after invalidate(undefined)");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("characterization: refresh() and refreshIfStale() never empty the entry", () => {
	const cwd = tempCwd("pi-flicker-safe-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		cache.refresh(manifest.runId);
		// refresh() rebuilds in-place: read previous, build, set — no undefined window.
		cache.refresh(manifest.runId);
		assert.equal(cache.get(manifest.runId) !== undefined, true, "refresh keeps entry populated");
		// refreshIfStale() serves the last snapshot when fresh — entry untouched.
		const before = cache.get(manifest.runId);
		cache.refreshIfStale(manifest.runId);
		assert.equal(cache.get(manifest.runId) !== undefined, true, "refreshIfStale keeps entry populated");
		assert.equal(cache.get(manifest.runId), before, "refreshIfStale reuses the fresh snapshot");
		assert.equal(cache.snapshotsByKey().size > 0, true, "cache non-empty throughout");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("flicker regression: a no-runId RenderScheduler fallback tick must NOT clear the cache", () => {
	const cwd = tempCwd("pi-flicker-tick-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		cache.refresh(manifest.runId);
		let invalidateCalls = 0;
		const scheduler = new RenderScheduler(new FakeEvents(), () => {}, {
			debounceMs: 50,
			fallbackMs: 1_000_000, // do not auto-tick during the test
			events: [],
			invalidateCoalesceMs: 0,
			onInvalidate: (payload) => {
				invalidateCalls += 1;
				makeOnInvalidate(cache)(payload);
			},
		});
		try {
			// Precondition: widget sees the run (not dropped to "(loading…)").
			assert.equal(
				activeWidgetRuns(cwd, undefined, cache, [manifest]).length,
				1,
				"precondition: widget renders the run",
			);
			// Simulate a fallback tick: schedule() with NO payload.
			scheduler.schedule();
			assert.equal(invalidateCalls, 1, "no-runId payload forwarded to onInvalidate synchronously");
			// The cache must be intact — this is the exact condition the fix
			// restores. The OLD code cleared it here.
			assert.equal(
				cache.get(manifest.runId) !== undefined,
				true,
				"no-runId tick must NOT clear the entry",
			);
			assert.equal(cache.snapshotsByKey().size, 1, "cache still has exactly one entry");
			// Repeated ticks (the endless-flicker scenario) must stay stable.
			scheduler.schedule();
			scheduler.schedule();
			scheduler.schedule();
			assert.equal(cache.get(manifest.runId) !== undefined, true, "stable across repeated ticks");
			assert.equal(
				activeWidgetRuns(cwd, undefined, cache, [manifest]).length,
				1,
				"widget still renders the run after ticks (no '(loading…)')",
			);
		} finally {
			scheduler.dispose();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("flicker regression: runId refreshIfStale and fs.watch refresh keep the widget populated", () => {
	const cwd = tempCwd("pi-flicker-id-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const onInvalidate = makeOnInvalidate(cache);
		const onChange = makeOnChange(cache);
		cache.refresh(manifest.runId);
		// Specific-runId invalidate path (was: invalidate(runId) → delete one
		// entry → one-frame empty window). Now: refreshIfStale → stays populated.
		onInvalidate({ runId: manifest.runId });
		assert.equal(cache.get(manifest.runId) !== undefined, true, "runId invalidate keeps entry populated");
		assert.equal(
			activeWidgetRuns(cwd, undefined, cache, [manifest]).length,
			1,
			"widget renders run after runId invalidate",
		);
		// fs.watch change path (onRunChange / crewRunWatcherOnChange).
		onChange(manifest.runId);
		assert.equal(cache.get(manifest.runId) !== undefined, true, "refresh keeps entry populated");
		assert.equal(
			activeWidgetRuns(cwd, undefined, cache, [manifest]).length,
			1,
			"widget renders run after fs.watch refresh",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
