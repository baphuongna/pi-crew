/**
 * Task 17 (perf/review-2026-08-24): fs.watch signals route through the
 * coalesced async refresh.
 *
 * The fs.watch path (`lifecycle-handlers.ts` onRunChange /
 * crewRunWatcherOnChange) used to call the SYNC `refresh()` on every file
 * event — a full snapshot rebuild (manifest+tasks parse, agents.json,
 * mailbox readdir, per-agent tail reads, 2x stringify+sha256) many times
 * per second, blocking the UI event loop. The public
 * `RunSnapshotCache.scheduleRefresh(runId)` routes through the same 80ms
 * coalesced → async (preloadStale) pipeline the run event bus uses.
 *
 * INSTRUMENTATION NOTE: the task brief suggested counting rebuilds via
 * `t.mock.method` on the state-store module, but Node's builtin/module ESM
 * namespaces are non-configurable on this toolchain (see
 * test/unit/state/mailbox-stat-gate.test.ts for the verification). We count
 * rebuilds via snapshot identity instead — the equivalent, stronger signal:
 * every real rebuild (buildAsync) mints a fresh snapshot object with a new
 * fetchedAt, while TTL and stamp-equal hits return the SAME reference, so
 * polling `get()` and collecting distinct references counts rebuilds exactly.
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

function fixtures(cwd: string): {
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
		goal: "coalesced-refresh",
	});
	saveRunManifest({ ...created.manifest, status: "running" });
	saveCrewAgents(created.manifest, [
		{
			id: `${created.manifest.runId}:01`,
			runId: created.manifest.runId,
			taskId: created.tasks[0]?.id ?? "explore",
			agent: "explorer",
			role: "explorer",
			runtime: "child-process",
			status: "running",
			startedAt: created.manifest.createdAt,
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

test("scheduleRefresh coalesces a watcher burst into one async rebuild", async () => {
	const cwd = tempCwd("pi-crew-coalesced-refresh-");
	try {
		const { manifest, tasks } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const initial = cache.refresh(manifest.runId);
		assert.equal(initial.progress.completed, 0);

		// Change tasks.json so the coalesced refresh MUST do a real rebuild —
		// with identical stamps preloadStale would just re-stamp the entry
		// (same snapshot reference) and no rebuild would be observable.
		saveRunTasks(
			manifest,
			tasks.map((task) => ({
				...task,
				status: "completed",
				usage: { input: 10, output: 20 },
			})),
		);

		// 5 watcher signals in a tight loop — one 80ms coalesced timer.
		for (let i = 0; i < 5; i += 1) cache.scheduleRefresh(manifest.runId);

		// FLICKER FIX contract: the entry never goes missing while the async
		// rebuild is pending — buildAsync re-sets the entry in place, nothing
		// is deleted. Poll snapshot identity for ~250ms (well past the 80ms
		// coalesce window + async build): each distinct reference beyond the
		// initial one is one rebuild.
		const seen = new Set<RunUiSnapshot>([initial]);
		let missing = 0;
		for (let i = 0; i < 50; i += 1) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			const snap = cache.get(manifest.runId);
			if (!snap) missing += 1;
			else seen.add(snap);
		}
		const rebuilds = seen.size - 1;
		assert.equal(missing, 0, "cache entry must stay populated across the whole window");
		assert.ok(rebuilds >= 1, "the coalesced timer must land one async rebuild of the changed run");
		assert.ok(rebuilds <= 2, `5 tight-loop signals must coalesce to at most 2 rebuilds (saw ${rebuilds})`);
		const final = cache.get(manifest.runId);
		assert.ok(final, "cache entry must remain populated after the coalesced refresh");
		assert.equal(final.progress.completed, 1, "the rebuilt snapshot must reflect the changed tasks.json");
		cache.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("scheduleRefresh is exposed on the cache API (watcher-facing contract)", () => {
	const cwd = tempCwd("pi-crew-coalesced-refresh-api-");
	try {
		const { manifest } = fixtures(cwd);
		const cache = createRunSnapshotCache(cwd);
		assert.equal(typeof cache.scheduleRefresh, "function");
		// Scheduling for an unknown runId must not throw — the async path
		// simply builds (or leaves the cache untouched on error), and the
		// watcher call sites do not pre-check entries.has(runId).
		cache.scheduleRefresh("no-such-run");
		cache.dispose?.();
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
