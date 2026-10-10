/**
 * U8 (upgrade-spec 2026-10-09) — parity tests: the opt-in sqlite run-state
 * backend must be observationally equivalent to the default JSON backend
 * through the SAME state-store interface (createRunManifest /
 * updateRunStatus / saveRunTasks / loadRunManifestById), while making
 * <runId>/state.sqlite the authoritative store (manifest.json / tasks.json
 * stay as read-side mirrors; events.jsonl stays the audit spine in both
 * modes). Also pins the sqlite-specific behaviors: authoritative read-through
 * when mirrors are gone (crash-gap), terminal-preserve, ST-4 empty-refuse,
 * legacy JSON-run fallback, and the async load twin.
 *
 * The kill -9 crash durability test lives in
 * test/integration/state-store-sqlite-crash.test.ts.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test__closeAllSqliteStores, getSqliteRunStateStore, sqliteDbPath } from "../../../../src/state/stores/sqlite-run-state.ts";
import {
	__test__clearManifestCache,
	createRunManifest,
	loadRunManifestById,
	loadRunManifestByIdAsync,
	saveRunManifest,
	saveRunTasks,
	updateRunStatus,
} from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "u8parity",
	description: "U8 sqlite/json parity",
	source: "builtin",
	filePath: "<test>",
	roles: [{ name: "executor", agent: "executor" }],
	defaultWorkflow: "default",
	workspaceMode: "single",
};

const workflow: WorkflowConfig = {
	name: "u8parity-wf",
	description: "U8 parity wf",
	source: "builtin",
	filePath: "<test>",
	steps: [
		{ id: "s1", role: "executor", task: "# Step one for {goal}" },
		{ id: "s2", role: "executor", task: "# Step two for {goal}", dependsOn: ["s1"] },
	],
};

/** Resolve temp dir through realpath + .git marker (see state-store.test.ts). */
function makeResolvedTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
	try {
		fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	} catch {
		/* best-effort */
	}
	return fs.realpathSync(dir);
}

/** Run a block with PI_CREW_STATE_BACKEND pinned, restoring the previous value. */
function withBackend(backend: "json" | "sqlite", fn: () => void): void {
	const prev = process.env.PI_CREW_STATE_BACKEND;
	process.env.PI_CREW_STATE_BACKEND = backend;
	try {
		fn();
	} finally {
		if (prev === undefined) delete process.env.PI_CREW_STATE_BACKEND;
		else process.env.PI_CREW_STATE_BACKEND = prev;
	}
}

interface ScenarioOutcome {
	status: TeamRunManifest["status"];
	summary: string | undefined;
	taskIds: string[];
	taskStatuses: string[];
	team: string;
	goal: string;
	schemaVersion: number;
	eventTypes: string[];
	hasSqliteDb: boolean;
	hasManifestJson: boolean;
	hasTasksJson: boolean;
}

/** The parity scenario: identical operations through the state-store interface. */
function runScenario(backend: "json" | "sqlite"): { outcome: ScenarioOutcome; stateRoot: string; runId: string } {
	const cwd = makeResolvedTempDir(`u8-parity-${backend}-`);
	let outcome: ScenarioOutcome;
	let stateRoot = "";
	let runId = "";
	withBackend(backend, () => {
		__test__clearManifestCache();
		const { manifest, tasks, paths } = createRunManifest({ cwd, team, workflow, goal: "ship U8" });
		stateRoot = paths.stateRoot;
		runId = paths.runId;
		const running = updateRunStatus(manifest, "running");
		const updatedTasks = tasks.map((task, index) => (index === 0 ? { ...task, status: "running" as const } : task));
		saveRunTasks(running, updatedTasks);
		updateRunStatus(running, "completed", "all green");
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded, "loadRunManifestById must find the run after the scenario");
		const events = fs
			.readFileSync(paths.eventsPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => (JSON.parse(line) as { type: string }).type);
		outcome = {
			status: loaded.manifest.status,
			summary: loaded.manifest.summary,
			taskIds: loaded.tasks.map((t) => t.id),
			taskStatuses: loaded.tasks.map((t) => t.status),
			team: loaded.manifest.team,
			goal: loaded.manifest.goal,
			schemaVersion: loaded.manifest.schemaVersion,
			eventTypes: events,
			hasSqliteDb: fs.existsSync(sqliteDbPath(stateRoot)),
			hasManifestJson: fs.existsSync(path.join(stateRoot, "manifest.json")),
			hasTasksJson: fs.existsSync(path.join(stateRoot, "tasks.json")),
		};
	});
	fs.rmSync(cwd, { recursive: true, force: true });
	return { outcome: outcome!, stateRoot, runId };
}

test("U8 parity: identical scenario through the state-store interface yields identical observable outcomes (json vs sqlite)", () => {
	const json = runScenario("json");
	const sqlite = runScenario("sqlite");
	// Everything the interface exposes must match — status, summary, task
	// identity/order/status, manifest identity fields, and the events.jsonl
	// audit spine (unchanged by U8 in both modes).
	assert.equal(sqlite.outcome.status, json.outcome.status, "run status");
	assert.equal(sqlite.outcome.summary, json.outcome.summary, "run summary");
	assert.deepEqual(sqlite.outcome.taskIds, json.outcome.taskIds, "task ids");
	assert.deepEqual(sqlite.outcome.taskStatuses, json.outcome.taskStatuses, "task statuses");
	assert.equal(sqlite.outcome.team, json.outcome.team, "team");
	assert.equal(sqlite.outcome.goal, json.outcome.goal, "goal");
	assert.equal(sqlite.outcome.schemaVersion, json.outcome.schemaVersion, "schemaVersion");
	assert.deepEqual(
		sqlite.outcome.eventTypes,
		json.outcome.eventTypes,
		"events.jsonl audit spine must be identical (run.created → run.running → task ops → run.completed)",
	);
	assert.deepEqual(json.outcome.eventTypes, ["run.created", "run.running", "run.completed"], "expected event sequence");
	// Backend difference is exactly the durable file set:
	// json default never creates state.sqlite; sqlite keeps BOTH the db and
	// the read-side json mirrors (for consumers that still read the files).
	assert.equal(json.outcome.hasSqliteDb, false, "default JSON backend must not create state.sqlite");
	assert.equal(json.outcome.hasManifestJson, true);
	assert.equal(json.outcome.hasTasksJson, true);
	assert.equal(sqlite.outcome.hasSqliteDb, true, "sqlite backend must create <runId>/state.sqlite");
	assert.equal(sqlite.outcome.hasManifestJson, true, "manifest.json mirror must still exist (legacy readers)");
	assert.equal(sqlite.outcome.hasTasksJson, true, "tasks.json mirror must still exist (legacy readers)");
	// Terminal state of the scenario.
	assert.equal(sqlite.outcome.status, "completed");
	assert.deepEqual(sqlite.outcome.taskStatuses, ["running", "queued"]);
});

test("U8 sqlite: createRunManifest commits manifest+tasks to the db in one batch and mirrors them to json", () => {
	const cwd = makeResolvedTempDir("u8-sqlite-create-");
	try {
		let stateRoot = "";
		let runId = "";
		withBackend("sqlite", () => {
			__test__clearManifestCache();
			const { manifest, tasks, paths } = createRunManifest({ cwd, team, workflow, goal: "db authoritative" });
			stateRoot = paths.stateRoot;
			runId = paths.runId;
			const fromDb = getSqliteRunStateStore(stateRoot).loadManifestAndTasks();
			assert.ok(fromDb, "db must hold the manifest+tasks birth batch");
			assert.equal(fromDb.manifest.runId, manifest.runId);
			assert.deepEqual(
				fromDb.tasks.map((t) => t.id),
				tasks.map((t) => t.id),
			);
			// Mirrors parse to the same content the db holds.
			const mirrorManifest = JSON.parse(fs.readFileSync(path.join(stateRoot, "manifest.json"), "utf-8")) as TeamRunManifest;
			assert.equal(mirrorManifest.runId, fromDb.manifest.runId);
			const mirrorTasks = JSON.parse(fs.readFileSync(path.join(stateRoot, "tasks.json"), "utf-8")) as TeamTaskState[];
			assert.deepEqual(
				mirrorTasks.map((t) => t.id),
				fromDb.tasks.map((t) => t.id),
			);
		});
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("U8 sqlite: db is authoritative — load survives missing/stale json mirrors (crash-gap between tx and mirror write)", () => {
	const cwd = makeResolvedTempDir("u8-sqlite-gap-");
	try {
		let runId = "";
		withBackend("sqlite", () => {
			__test__clearManifestCache();
			const { manifest, paths } = createRunManifest({ cwd, team, workflow, goal: "gap" });
			runId = paths.runId;
			updateRunStatus(manifest, "running");
			const completed = updateRunStatus(loadRunManifestById(cwd, runId)!.manifest, "completed", "done");
			// Simulate the crash-gap: the mirrors are one write behind (or gone).
			fs.rmSync(path.join(paths.stateRoot, "manifest.json"), { force: true });
			fs.rmSync(path.join(paths.stateRoot, "tasks.json"), { force: true });
			__test__clearManifestCache();
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded, "run must stay resolvable via the state.sqlite birth marker");
			assert.equal(loaded.manifest.status, "completed", "authoritative db state must be served");
			assert.equal(loaded.tasks.length, 2, "tasks come from the db, not the deleted mirror");
			// Stale-mirror variant: json says queued, db says completed → db wins.
			fs.writeFileSync(path.join(paths.stateRoot, "manifest.json"), JSON.stringify({ ...completed, status: "queued" }), "utf-8");
			__test__clearManifestCache();
			const loaded2 = loadRunManifestById(cwd, runId);
			assert.equal(loaded2?.manifest.status, "completed", "stale mirror must never shadow the db");
		});
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("U8 sqlite: terminal-preserve guard reads the authoritative db (stale running save cannot erase completed)", () => {
	const cwd = makeResolvedTempDir("u8-sqlite-terminal-");
	try {
		withBackend("sqlite", () => {
			__test__clearManifestCache();
			const { manifest, paths } = createRunManifest({ cwd, team, workflow, goal: "terminal" });
			const running = updateRunStatus(manifest, "running");
			updateRunStatus(running, "cancelled", "aborted");
			// A mid-flight saver with a stale in-memory "running" manifest.
			// 1) The updateRunStatus erase class (running → blocked, non-terminal
			//    target over a terminal disk/db status) must be refused + recorded.
			const refused = updateRunStatus(running, "blocked");
			assert.equal(refused.status, "cancelled", "updateRunStatus must preserve the terminal status");
			// 2) The raw write-layer guard (stale running save) must also preserve.
			const stale = { ...running, updatedAt: new Date().toISOString() };
			const saved = saveRunManifest(stale);
			assert.equal(saved.status, "cancelled", "disk/db terminal status must be preserved");
			const loaded = loadRunManifestById(cwd, paths.runId);
			assert.equal(loaded?.manifest.status, "cancelled");
			const events = fs
				.readFileSync(paths.eventsPath, "utf-8")
				.split("\n")
				.filter(Boolean)
				.map((line) => (JSON.parse(line) as { type: string }).type);
			assert.ok(events.includes("run.terminal_preserved"), "the refusal must be recorded on the audit spine");
		});
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("U8 sqlite: ST-4 empty-refuse guard reads the authoritative db", () => {
	const cwd = makeResolvedTempDir("u8-sqlite-st4-");
	try {
		withBackend("sqlite", () => {
			__test__clearManifestCache();
			const { manifest, tasks, paths } = createRunManifest({ cwd, team, workflow, goal: "st4" });
			// Wipe the mirror so only the db knows the tasks exist.
			fs.rmSync(paths.tasksPath, { force: true });
			saveRunTasks(manifest, []);
			const loaded = loadRunManifestById(cwd, paths.runId);
			assert.equal(loaded?.tasks.length, tasks.length, "refusing to persist [] must keep the db task set");
		});
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("U8 sqlite: legacy JSON-created run still loads after enabling the backend (fall-through)", () => {
	const cwd = makeResolvedTempDir("u8-sqlite-legacy-");
	try {
		let runId = "";
		withBackend("json", () => {
			__test__clearManifestCache();
			const { manifest, paths } = createRunManifest({ cwd, team, workflow, goal: "legacy" });
			runId = paths.runId;
			updateRunStatus(manifest, "running");
		});
		withBackend("sqlite", () => {
			__test__clearManifestCache();
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded, "legacy json run must load under the sqlite backend (no db → JSON path)");
			assert.equal(loaded.manifest.status, "running");
			assert.equal(loaded.tasks.length, 2);
		});
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("U8 sqlite: loadRunManifestByIdAsync twin reads the authoritative db", async () => {
	const cwd = makeResolvedTempDir("u8-sqlite-async-");
	try {
		let runId = "";
		await withBackendAsync("sqlite", async () => {
			__test__clearManifestCache();
			const { manifest, paths } = createRunManifest({ cwd, team, workflow, goal: "async" });
			runId = paths.runId;
			updateRunStatus(manifest, "running");
			fs.rmSync(path.join(paths.stateRoot, "manifest.json"), { force: true });
			fs.rmSync(path.join(paths.stateRoot, "tasks.json"), { force: true });
			const loaded = await loadRunManifestByIdAsync(cwd, runId);
			assert.ok(loaded, "async load must read through the db");
			assert.equal(loaded.manifest.status, "running");
			assert.equal(loaded.tasks.length, 2);
		});
	} finally {
		__test__closeAllSqliteStores();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

/** Async twin of withBackend. */
async function withBackendAsync<T>(backend: "json" | "sqlite", fn: () => Promise<T>): Promise<T> {
	const prev = process.env.PI_CREW_STATE_BACKEND;
	process.env.PI_CREW_STATE_BACKEND = backend;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env.PI_CREW_STATE_BACKEND;
		else process.env.PI_CREW_STATE_BACKEND = prev;
	}
}
