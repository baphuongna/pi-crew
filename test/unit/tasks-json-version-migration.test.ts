import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { __test__clearManifestCache, createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/stores/state-store.ts";
import { CURRENT_TASKS_SCHEMA_VERSION } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

/**
 * ST-9 tests: tasks.json schema-version migration.
 *
 * tasks.json has two on-disk shapes:
 * - v0 (legacy): bare JSON array `TeamTaskState[]`.
 * - v1+ (current): envelope `{ schemaVersion, tasks }`.
 *
 * The reader must accept both without crashing, warn on version mismatch,
 * and return the correct task array in every case.
 */

const team: TeamConfig = {
	name: "test-team",
	description: "Test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const singleStepWorkflow: WorkflowConfig = {
	name: "test-workflow",
	description: "Test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [{ id: "step1", role: "executor", task: "Do thing" }],
};

/** Overwrite tasks.json on disk with arbitrary content, then clear cache. */
function writeTasksJson(manifest: { tasksPath: string }, content: unknown): void {
	fs.writeFileSync(manifest.tasksPath, JSON.stringify(content, null, 2));
	__test__clearManifestCache();
}

/** Read tasks.json from disk and parse it. */
function readTasksJson(tasksPath: string): unknown {
	return JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
}

test("ST-9: v0 bare-array tasks.json loads without crash", () => {
	const cwd = createTrackedTempDir("pi-crew-st9-v0-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "v0 test" });
		// Overwrite with v0 format: bare array, no schemaVersion envelope.
		writeTasksJson(manifest, tasks);

		const result = loadRunManifestById(cwd, manifest.runId);
		assert.ok(result, "loadRunManifestById should return a result");
		assert.ok(result!.tasks.length > 0, "should load tasks from v0 bare array");
		assert.equal(result!.tasks[0].id, tasks[0].id);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("ST-9: v1 envelope tasks.json loads correctly", () => {
	const cwd = createTrackedTempDir("pi-crew-st9-v1-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "v1 test" });
		// Overwrite with v1 format: envelope with schemaVersion.
		writeTasksJson(manifest, { schemaVersion: CURRENT_TASKS_SCHEMA_VERSION, tasks });

		const result = loadRunManifestById(cwd, manifest.runId);
		assert.ok(result, "loadRunManifestById should return a result");
		assert.ok(result!.tasks.length > 0);
		assert.equal(result!.tasks[0].id, tasks[0].id);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("ST-9: saveRunTasks writes loadable tasks (currently v0 bare array)", () => {
	const cwd = createTrackedTempDir("pi-crew-st9-write-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "write test" });
		__test__clearManifestCache();
		saveRunTasks(manifest, tasks);

		// Writers currently produce v0 bare arrays (backward-compatible with
		// 6+ production readers that parse tasks.json directly as TeamTaskState[]).
		// The migration hook on the reader side handles this seamlessly.
		const onDisk = JSON.parse(fs.readFileSync(manifest.tasksPath, "utf-8")) as unknown;
		assert.ok(Array.isArray(onDisk), "writers produce v0 bare array for backward compat");
		assert.ok(onDisk.length > 0);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("ST-9: round-trip save then load preserves tasks", () => {
	const cwd = createTrackedTempDir("pi-crew-st9-rt-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "round-trip" });
		__test__clearManifestCache();
		saveRunTasks(manifest, tasks);
		__test__clearManifestCache();

		const result = loadRunManifestById(cwd, manifest.runId);
		assert.ok(result, "loadRunManifestById should return a result");
		assert.equal(result!.tasks.length, tasks.length);
		assert.deepEqual(
			result!.tasks.map((t) => t.id),
			tasks.map((t) => t.id),
		);
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("ST-9: corrupt (non-array, non-envelope) tasks.json triggers recovery without crash", () => {
	const cwd = createTrackedTempDir("pi-crew-st9-corrupt-");
	try {
		const { manifest } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "corrupt test" });
		// Write a plain object that is NOT a valid envelope (no tasks array).
		writeTasksJson(manifest, { foo: "bar" });

		// Should not crash — recovery path handles corrupt files.
		const result = loadRunManifestById(cwd, manifest.runId);
		// Result may be undefined if manifest validation fails, or tasks=[] if recovery ran.
		// Either way, no crash.
		if (result) {
			assert.ok(Array.isArray(result.tasks));
		}
	} finally {
		removeTrackedTempDir(cwd);
	}
});

test("ST-9: future schemaVersion (v99) warns but proceeds", () => {
	const cwd = createTrackedTempDir("pi-crew-st9-future-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow: singleStepWorkflow, goal: "future version" });
		// Write an envelope with a future schemaVersion.
		writeTasksJson(manifest, { schemaVersion: 99, tasks });

		const result = loadRunManifestById(cwd, manifest.runId);
		// Should warn but still return the tasks (warn-and-proceed).
		assert.ok(result, "should return a result despite version mismatch");
		assert.ok(result!.tasks.length > 0);
		assert.equal(result!.tasks[0].id, tasks[0].id);
	} finally {
		removeTrackedTempDir(cwd);
	}
});
