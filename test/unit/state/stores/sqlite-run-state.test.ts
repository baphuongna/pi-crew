/**
 * U8 (upgrade-spec 2026-10-09) — unit tests for the opt-in sqlite run-state
 * backend store (src/state/stores/sqlite-run-state.ts).
 *
 * Covers: schema + WAL pragmas, manifest/tasks round-trip, full-replace task
 * semantics, all-or-nothing batch (error mid-batch → rollback), worker-status
 * CRUD, monotonic seq, reopen persistence, and the process-wide handle cache.
 *
 * The kill -9 crash durability test lives in
 * test/integration/state-store-sqlite-crash.test.ts (pattern live-proven in
 * /tmp/pi-crew-verify10-crash/).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	closeSqliteRunStateStore,
	getSqliteRunStateStore,
	isSqliteStateBackend,
	SqliteRunStateStore,
	__test__closeAllSqliteStores,
	__test__sqliteStoreCacheSize,
	sqliteDbPath,
} from "../../../../src/state/stores/sqlite-run-state.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../../src/state/types.ts";

function makeStateRoot(): string {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "u8-sqlite-"));
	return dir;
}

function makeManifest(overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: CURRENT_SCHEMA_VERSION,
		runId: "run-u8-test",
		sessionId: "run-u8-test",
		team: "u8test",
		goal: "sqlite backend",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "2026-10-10T00:00:00.000Z",
		cwd: "/tmp",
		stateRoot: "/tmp/run-u8-test",
		artifactsRoot: "/tmp/artifacts-u8-test",
		tasksPath: "/tmp/run-u8-test/tasks.json",
		eventsPath: "/tmp/run-u8-test/events.jsonl",
		artifacts: [],
		runKind: "team-run",
		...overrides,
	};
}

function makeTask(id: string, overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		runId: "run-u8-test",
		stepId: id,
		role: "executor",
		agent: "executor",
		title: `task ${id}`,
		status: "queued",
		dependsOn: [],
		cwd: "/tmp",
		graph: { taskId: id, children: [], dependencies: [], queue: "ready" },
		...overrides,
	};
}

test("U8 sqlite store: opens with WAL journal + creates the spec schema", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		assert.equal(store.journalMode(), "wal", "journal_mode must be wal (live-proven durability combo)");
		assert.ok(fs.existsSync(sqliteDbPath(stateRoot)), "state.sqlite must exist at <stateRoot>/state.sqlite");
		// Fresh db: no manifest, no tasks, no worker-status.
		assert.equal(store.loadManifest(), undefined);
		assert.deepEqual(store.loadTasks(), []);
		assert.deepEqual(store.loadWorkerStatuses(), []);
		store.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: manifest + tasks round-trip (deep equal)", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		const manifest = makeManifest({ summary: "round trip" });
		const tasks = [makeTask("t1", { status: "running" }), makeTask("t2", { status: "completed" })];
		store.saveManifestAndTasks(manifest, tasks);
		const loaded = store.loadManifestAndTasks();
		assert.ok(loaded, "loadManifestAndTasks must return the saved pair");
		assert.deepEqual(loaded.manifest, manifest, "manifest must round-trip byte-identical (JSON)");
		assert.deepEqual(loaded.tasks, tasks, "tasks must round-trip deep-equal, insertion order preserved");
		store.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: saveTasks is a full-set replace (tasks.json semantics)", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		store.saveTasks([makeTask("a"), makeTask("b")]);
		store.saveTasks([makeTask("b", { status: "completed" }), makeTask("c")]);
		const tasks = store.loadTasks();
		assert.deepEqual(
			tasks.map((t) => t.id),
			["b", "c"],
			"replaced set must contain exactly the new rows (a gone, b updated, c added)",
		);
		assert.equal(tasks[0].status, "completed", "upsert-by-id keeps the updated record");
		store.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: batch is all-or-nothing — serialization error mid-batch rolls the WHOLE batch back", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		const good = makeManifest({ summary: "batch 1" });
		const goodTasks = [makeTask("k1"), makeTask("k2")];
		store.saveManifestAndTasks(good, goodTasks);

		// Batch 2: a task whose JSON.stringify throws (BigInt) mid-array. The
		// stringify happens inside the batch, so the tx must roll back and the
		// previous FULL batch stays visible — never a mix of batch 1 + batch 2.
		const poisoned = makeTask("k3");
		(poisoned as unknown as Record<string, unknown>).boom = 1n;
		assert.throws(() => store.saveManifestAndTasks(makeManifest({ summary: "batch 2" }), [makeTask("k4"), poisoned]));

		const loaded = store.loadManifestAndTasks();
		assert.ok(loaded);
		assert.equal(loaded.manifest.summary, "batch 1", "manifest must be the batch-1 record (rollback)");
		assert.deepEqual(
			loaded.tasks.map((t) => t.id),
			["k1", "k2"],
			"tasks must be the batch-1 set — no half batch (k4 absent)",
		);
		store.close();
		// Reopen from disk: rollback must be durable, not just in-memory.
		const reopened = new SqliteRunStateStore(stateRoot);
		const reloaded = reopened.loadManifestAndTasks();
		assert.equal(reloaded?.manifest.summary, "batch 1");
		assert.deepEqual(
			reloaded?.tasks.map((t) => t.id),
			["k1", "k2"],
		);
		reopened.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: worker-status CRUD (upsert batch / single / delete / load)", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		store.saveWorkerStatuses([
			{ taskId: "w1", record: { status: "running", pid: 111 } },
			{ taskId: "w2", record: { status: "queued" } },
		]);
		store.upsertWorkerStatus("w1", { status: "completed", exitCode: 0 });
		store.deleteWorkerStatus("w2");
		const rows = store.loadWorkerStatuses();
		assert.deepEqual(
			rows.map((r) => r.taskId),
			["w1"],
		);
		assert.deepEqual(rows[0].record, { status: "completed", exitCode: 0 }, "upsert-by-task-id replaces the record");

		// Worker-status batch is also all-or-nothing: a poisoned record rolls
		// the whole saveWorkerStatuses batch back.
		assert.throws(() =>
			store.saveWorkerStatuses([
				{ taskId: "w3", record: { status: "running" } },
				{ taskId: "w4", record: { boom: 1n } },
			]),
		);
		assert.deepEqual(
			store.loadWorkerStatuses().map((r) => r.taskId),
			["w1"],
			"no half batch — w3 must not have landed",
		);
		store.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: nextSeq is monotonic from 1 and survives reopen", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		assert.equal(store.nextSeq("batch"), 1);
		assert.equal(store.nextSeq("batch"), 2);
		assert.equal(store.nextSeq("other"), 1, "sequences are independent per name");
		store.close();
		const reopened = new SqliteRunStateStore(stateRoot);
		assert.equal(reopened.nextSeq("batch"), 3, "seq persists across close/reopen");
		reopened.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: data persists across close/reopen (fresh handle)", () => {
	const stateRoot = makeStateRoot();
	try {
		const store = new SqliteRunStateStore(stateRoot);
		store.saveManifestAndTasks(makeManifest(), [makeTask("p1")]);
		store.close();
		const reopened = new SqliteRunStateStore(stateRoot);
		assert.ok(reopened.loadManifestAndTasks(), "committed batch must be visible to a fresh handle");
		reopened.close();
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
});

test("U8 sqlite store: process-wide handle cache reuses, releases, and is bounded", () => {
	__test__closeAllSqliteStores();
	const rootA = makeStateRoot();
	const rootB = makeStateRoot();
	try {
		const a1 = getSqliteRunStateStore(rootA);
		const a2 = getSqliteRunStateStore(rootA);
		assert.equal(a1, a2, "same stateRoot must reuse the cached handle");
		assert.equal(__test__sqliteStoreCacheSize(), 1);
		getSqliteRunStateStore(rootB);
		assert.equal(__test__sqliteStoreCacheSize(), 2);
		closeSqliteRunStateStore(rootA);
		assert.equal(__test__sqliteStoreCacheSize(), 1, "explicit close evicts the cache entry");
		const a3 = getSqliteRunStateStore(rootA);
		assert.notEqual(a3, a1, "after close, a NEW handle is opened");
		a3.saveManifest(makeManifest({ summary: "cached write" }));
		assert.equal(a3.loadManifest()?.summary, "cached write");
		__test__closeAllSqliteStores();
		assert.equal(__test__sqliteStoreCacheSize(), 0);
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(rootA, { recursive: true, force: true });
		fs.rmSync(rootB, { recursive: true, force: true });
	}
});

test("U8 backend select: PI_CREW_STATE_BACKEND=sqlite opts in; unset/json/garbage fail safe to the JSON default", () => {
	const prev = process.env.PI_CREW_STATE_BACKEND;
	try {
		delete process.env.PI_CREW_STATE_BACKEND;
		assert.equal(isSqliteStateBackend(), false, "unset must keep the JSON default");
		process.env.PI_CREW_STATE_BACKEND = "sqlite";
		assert.equal(isSqliteStateBackend(), true);
		process.env.PI_CREW_STATE_BACKEND = "SQLITE";
		assert.equal(isSqliteStateBackend(), true, "case-insensitive opt-in");
		process.env.PI_CREW_STATE_BACKEND = "json";
		assert.equal(isSqliteStateBackend(), false);
		process.env.PI_CREW_STATE_BACKEND = "garbage";
		assert.equal(isSqliteStateBackend(), false, "invalid values fail safe to the default backend");
	} finally {
		if (prev === undefined) delete process.env.PI_CREW_STATE_BACKEND;
		else process.env.PI_CREW_STATE_BACKEND = prev;
	}
});
