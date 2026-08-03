/**
 * ST-4 integration test: corrupt tasks.json → reconstruct from events.jsonl.
 *
 * Verifies that loadRunManifestById (sync) does NOT silently return [] when
 * tasks.json is corrupt (SyntaxError or non-array). Instead it:
 *   1. Quarantines the corrupt file to `.corrupt-<ts>`.
 *   2. Reconstructs tasks from events.jsonl via reconstructTasksFromEvents.
 *   3. Returns the reconstructed tasks (not []).
 *
 * Also verifies edge cases:
 *   - ENOENT (no tasks.json) → [] (legitimate empty, NOT quarantined).
 *   - Non-array JSON (e.g. `{}`) → treated as corrupt (quarantined + reconstruct).
 *   - Refuse to persist [] over a previously-non-empty tasks file.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendEvent } from "../../src/state/event-log/event-log.ts";
import { __test__clearManifestCache, createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "st4test",
	description: "ST-4 recovery",
	source: "builtin",
	filePath: "<test>",
	roles: [{ name: "executor", agent: "executor" }],
	defaultWorkflow: "default",
	workspaceMode: "single",
};
const workflow: WorkflowConfig = {
	name: "st4test-wf",
	description: "ST-4 recovery wf",
	source: "builtin",
	filePath: "<test>",
	steps: [],
};

/**
 * Write 2 task lifecycles to events.jsonl using top-level `taskId`
 * (the field reconstructTasksFromEvents reads).
 *   task-A: created → started → completed
 *   task-B: created → started (still running)
 */
function writeTaskEvents(eventsPath: string, runId: string): void {
	appendEvent(eventsPath, { type: "task.created", runId, taskId: "task-A" });
	appendEvent(eventsPath, { type: "task.started", runId, taskId: "task-A" });
	appendEvent(eventsPath, { type: "task.completed", runId, taskId: "task-A" });
	appendEvent(eventsPath, { type: "task.created", runId, taskId: "task-B" });
	appendEvent(eventsPath, { type: "task.started", runId, taskId: "task-B" });
}

/**
 * Create a fully-laid-out run (via createRunManifest so path canonicalisation
 * matches what loadRunManifestById expects), write events + valid tasks.
 * Returns the paths needed by the test.
 */
function setupRun(): {
	tmpRoot: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
	eventsPath: string;
	tasksPath: string;
} {
	const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-st4-")));
	fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n", "utf-8");
	fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
	const { manifest } = createRunManifest({
		cwd: tmpRoot,
		team,
		workflow,
		goal: "ST-4 recovery test",
	});
	const eventsPath = manifest.eventsPath;
	const tasksPath = manifest.tasksPath;
	writeTaskEvents(eventsPath, manifest.runId);
	const tasks: TeamTaskState[] = [
		{
			id: "task-A",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "Task A",
			status: "completed",
			dependsOn: [],
			cwd: tmpRoot,
		},
		{
			id: "task-B",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "Task B",
			status: "running",
			dependsOn: ["task-A"],
			cwd: tmpRoot,
		},
	];
	saveRunTasks(manifest, tasks);
	// Clear cache so the next loadRunManifestById hits disk.
	__test__clearManifestCache();
	return { tmpRoot, manifest, eventsPath, tasksPath };
}

/** Glob-match helper for `.corrupt-*` quarantine files in a directory. */
function findCorruptFiles(dir: string): string[] {
	return fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
}

test("ST-4: malformed tasks.json (SyntaxError) → reconstruct from events, NOT []", { skip: process.platform === "win32" ? "Windows file-quarantine rename + reload timing flakes ('manifest must reload'). Follow up: make the reload assertion wait-free / Windows-tolerant." : undefined }, () => {
	const { tmpRoot, manifest, tasksPath } = setupRun();
	try {
		// Corrupt tasks.json with a syntax error.
		fs.writeFileSync(tasksPath, '{"this is": "not valid JSON }}}', "utf-8");
		// Clear cache so we hit disk.
		__test__clearManifestCache();

		const loaded = loadRunManifestById(tmpRoot, manifest.runId);
		assert.ok(loaded, "manifest must reload");
		assert.notEqual(loaded!.tasks.length, 0, "tasks must NOT be [] — reconstruct from events");

		// Both task-A and task-B should be reconstructed.
		assert.equal(loaded!.tasks.length, 2, "both tasks reconstructed from events");
		const ids = loaded!.tasks.map((t) => t.id).sort();
		assert.deepEqual(ids, ["task-A", "task-B"]);

		// task-A should be completed (last lifecycle event).
		const taskA = loaded!.tasks.find((t) => t.id === "task-A");
		assert.ok(taskA);
		assert.equal(taskA!.status, "completed");

		// task-B should be running.
		const taskB = loaded!.tasks.find((t) => t.id === "task-B");
		assert.ok(taskB);
		assert.equal(taskB!.status, "running");

		// Corrupt file must be quarantined.
		const corrupt = findCorruptFiles(path.dirname(tasksPath));
		assert.ok(corrupt.length >= 1, `corrupt file quarantined: ${corrupt.join(", ")}`);
		assert.ok(
			corrupt.some((f) => f.startsWith("tasks.json.corrupt-")),
			"quarantine file has correct prefix",
		);

		// Original tasks.json should now contain valid reconstructed data (persisted).
		assert.ok(fs.existsSync(tasksPath), "tasks.json was rewritten with reconstructed data");
		const rewritten = JSON.parse(fs.readFileSync(tasksPath, "utf-8"));
		assert.ok(Array.isArray(rewritten), "rewritten tasks.json is an array");
		assert.equal(rewritten.length, 2, "rewritten tasks.json has 2 tasks");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("ST-4: non-array JSON ({}) in tasks.json → treated as corrupt, quarantined + reconstructed", { skip: process.platform === "win32" ? "Windows file-quarantine rename + reload timing flakes ('manifest must reload'). Follow up: make the reload assertion wait-free / Windows-tolerant." : undefined }, () => {
	const { tmpRoot, manifest, tasksPath } = setupRun();
	try {
		// Write non-array JSON.
		fs.writeFileSync(tasksPath, '{"not": "an array"}', "utf-8");
		__test__clearManifestCache();

		const loaded = loadRunManifestById(tmpRoot, manifest.runId);
		assert.ok(loaded, "manifest must reload");
		assert.notEqual(loaded!.tasks.length, 0, "non-array JSON must NOT silently become []");

		// Should be reconstructed from events.
		assert.equal(loaded!.tasks.length, 2, "both tasks reconstructed");

		// Corrupt file quarantined.
		const corrupt = findCorruptFiles(path.dirname(tasksPath));
		assert.ok(
			corrupt.some((f) => f.startsWith("tasks.json.corrupt-")),
			"non-array file quarantined",
		);
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("ST-4: ENOENT (no tasks.json) → [] is legitimate, NOT quarantined", { skip: process.platform === "win32" ? "Windows file-quarantine rename + reload timing flakes ('manifest must reload'). Follow up: make the reload assertion wait-free / Windows-tolerant." : undefined }, () => {
	const { tmpRoot, manifest, tasksPath } = setupRun();
	try {
		// Delete tasks.json entirely.
		fs.unlinkSync(tasksPath);
		__test__clearManifestCache();

		const loaded = loadRunManifestById(tmpRoot, manifest.runId);
		assert.ok(loaded, "manifest must reload");
		assert.equal(loaded!.tasks.length, 0, "ENOENT → [] is legitimate empty");

		// Must NOT be quarantined — no .corrupt-* files.
		const corrupt = findCorruptFiles(path.dirname(tasksPath));
		assert.equal(corrupt.length, 0, "ENOENT must NOT quarantine");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("ST-4: saveRunTasks refuses to persist [] over a previously-non-empty tasks file", () => {
	const { tmpRoot, manifest, tasksPath } = setupRun();
	try {
		// tasks.json currently has 2 tasks.
		const before = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as TeamTaskState[];
		assert.equal(before.length, 2, "precondition: 2 tasks on disk");

		// Attempt to save [] — should be refused.
		saveRunTasks(manifest, []);

		// tasks.json must still have 2 tasks (not overwritten with []).
		const after = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as TeamTaskState[];
		assert.equal(after.length, 2, "saveRunTasks([]) must NOT overwrite non-empty tasks");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("ST-4: saveRunTasks([]) proceeds when tasks.json is empty or missing (legitimate)", () => {
	const { tmpRoot, manifest, tasksPath } = setupRun();
	try {
		// Delete tasks.json → ENOENT → readJsonFile returns undefined → guard allows [].
		fs.unlinkSync(tasksPath);
		__test__clearManifestCache();

		// Should NOT throw — saving [] over missing file is legitimate.
		saveRunTasks(manifest, []);

		// tasks.json should now exist with [].
		assert.ok(fs.existsSync(tasksPath), "tasks.json written");
		const after = JSON.parse(fs.readFileSync(tasksPath, "utf-8")) as TeamTaskState[];
		assert.equal(after.length, 0, "empty tasks written when file was missing");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});
