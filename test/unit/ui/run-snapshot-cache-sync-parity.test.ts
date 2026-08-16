/**
 * R10-4 — sync build() / async buildAsync() tasks parity
 * (docs/refactor-plan.review.md §ROUND 10, row R10-4).
 *
 * Decision trail: git blame + comment audit found NO freshness / RT-series /
 * H-series rationale for the sync re-read — `readTasks()` at the old build() site was
 * original v0.1.34 code (commit 39b12dc7), and `loadRunManifestById` already
 * validates tasks against the current tasks.json (mtime+size+generation in
 * state-store) before returning them. Therefore the fix is simple parity
 * (`tasks = loaded.tasks`, same as buildAsync()), NOT a generation gate.
 *
 * These tests pin BOTH paths to disk truth: snapshot.tasks must be deep-equal
 * to a direct JSON.parse of tasks.json for a fixture run, sync and async
 * snapshots must agree with each other, and a tasks.json write between
 * refreshes must still surface through loaded.tasks (freshness preserved).
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
		goal: "snapshot-parity",
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

/** Mirror of the old module-private readTasks() read semantics (no throw). */
function readTasksFromDisk(tasksPath: string): TeamTaskState[] {
	const parsed = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as unknown;
	return Array.isArray(parsed) ? (parsed as TeamTaskState[]) : [];
}

/**
 * Content equality under tasks.json serialization semantics. JSON.stringify
 * drops undefined-valued own properties, and `loaded.tasks` is served from
 * the state-store's in-memory manifest cache on the hit path — so in-memory
 * task objects carry keys like `parentId: undefined` (set explicitly by
 * createRunManifest) that never round-trip through tasks.json. Compare both
 * sides after a JSON roundtrip: that is exactly the shape readTasks() saw.
 */
function jsonRoundTrip<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function completedTasks(tasks: TeamTaskState[]): TeamTaskState[] {
	return tasks.map((task) => ({
		...task,
		status: "completed",
		usage: { input: 10, output: 20 },
	}));
}

test("R10-4: sync build() tasks are identical to a direct tasks.json read", () => {
	const cwd = tempCwd("pi-crew-snapshot-parity-sync-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd);
		saveRunTasks(manifest, completedTasks(tasks));
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const snapshot = cache.refresh(manifest.runId);
		assert.deepEqual(jsonRoundTrip(snapshot.tasks), readTasksFromDisk(manifest.tasksPath));
		assert.equal(snapshot.progress.total, 1);
		assert.equal(snapshot.progress.completed, 1);
		assert.equal(snapshot.usage.tokensIn, 10);
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R10-4: async buildAsync() tasks are identical to a direct tasks.json read", async () => {
	const cwd = tempCwd("pi-crew-snapshot-parity-async-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd);
		saveRunTasks(manifest, completedTasks(tasks));
		// Fresh cache → preloadStale has no previous entry → full buildAsync().
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const snapshot = await cache.preloadStale(manifest.runId);
		assert.ok(snapshot, "preloadStale should build a snapshot");
		assert.deepEqual(jsonRoundTrip(snapshot.tasks), readTasksFromDisk(manifest.tasksPath));
		assert.equal(snapshot.progress.total, 1);
		assert.equal(snapshot.progress.completed, 1);
		assert.equal(snapshot.usage.tokensIn, 10);
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R10-4: sync build() and async buildAsync() produce identical tasks/progress/usage", async () => {
	const cwd = tempCwd("pi-crew-snapshot-parity-both-");
	let syncCache: ReturnType<typeof createRunSnapshotCache> | undefined;
	let asyncCache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd);
		saveRunTasks(manifest, completedTasks(tasks));
		syncCache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const syncSnapshot = syncCache.refresh(manifest.runId);
		asyncCache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const asyncSnapshot = await asyncCache.preloadStale(manifest.runId);
		assert.ok(asyncSnapshot);
		assert.deepEqual(syncSnapshot.tasks, asyncSnapshot.tasks);
		assert.deepEqual(syncSnapshot.progress, asyncSnapshot.progress);
		assert.deepEqual(syncSnapshot.usage, asyncSnapshot.usage);
	} finally {
		syncCache?.dispose?.();
		asyncCache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R10-4: sync refreshIfStale still surfaces NEW tasks.json content via loaded.tasks", () => {
	const cwd = tempCwd("pi-crew-snapshot-parity-fresh-sync-");
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd);
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const first = cache.refreshIfStale(manifest.runId);
		// Task completed on disk AFTER the first snapshot — the loaded.tasks
		// path must be exactly as fresh as the old direct readTasks() re-read.
		saveRunTasks(manifest, completedTasks(tasks));
		const second = cache.refreshIfStale(manifest.runId);
		assert.notEqual(second, first);
		assert.deepEqual(jsonRoundTrip(second.tasks), readTasksFromDisk(manifest.tasksPath));
		assert.equal(second.progress.completed, 1);
		assert.equal(second.usage.tokensIn, 10);
	} finally {
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R10-4: async preloadStale still surfaces NEW tasks.json content via loaded.tasks", async () => {
	const cwd = tempCwd("pi-crew-snapshot-parity-fresh-async-");
	let primingCache: ReturnType<typeof createRunSnapshotCache> | undefined;
	let cache: ReturnType<typeof createRunSnapshotCache> | undefined;
	try {
		const { manifest, tasks } = fixtures(cwd);
		// Prime the module-level manifest cache with the initial state so the
		// freshness check below is meaningful (stale cache entry must be
		// bypassed, not served).
		primingCache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		await primingCache.preloadStale(manifest.runId);
		saveRunTasks(manifest, completedTasks(tasks));
		cache = createRunSnapshotCache(cwd, { ttlMs: 0 });
		const snapshot = await cache.preloadStale(manifest.runId);
		assert.ok(snapshot);
		assert.deepEqual(jsonRoundTrip(snapshot.tasks), readTasksFromDisk(manifest.tasksPath));
		assert.equal(snapshot.progress.completed, 1);
		assert.equal(snapshot.usage.tokensIn, 10);
	} finally {
		primingCache?.dispose?.();
		cache?.dispose?.();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
