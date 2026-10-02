import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

/**
 * G19 (W-E Phase 1) pin: `controlReservation` and `workerExitStatus` were
 * dead fields (0 readers repo-wide) and have been dropped from
 * `TeamTaskState`. This test writes run state through the REAL store paths
 * (createRunManifest → tasks.json, then a post-execution-style terminal
 * write via saveRunTasks) and asserts the persisted JSON no longer contains
 * either field.
 */

function makeTmpCwd(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
	// LEAK PREVENTION: `.git` marker so useProjectState(dir) → true, keeping
	// the run records inside <tmpdir>/.crew/ instead of a global state dir.
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

const team: TeamConfig = {
	name: "fast-fix",
	description: "fast-fix",
	source: "builtin",
	filePath: "fast-fix.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "fast-fix",
	description: "fast-fix",
	source: "builtin",
	filePath: "fast-fix.workflow.md",
	steps: [{ id: "fix", role: "executor", task: "Fix {goal}" }],
};

function assertNoDeadFields(label: string, rows: TeamTaskState[]): void {
	assert.ok(rows.length > 0, `${label}: expected at least one task row`);
	for (const task of rows) {
		assert.ok(!("controlReservation" in task), `${label}: task ${task.id} still carries controlReservation`);
		assert.ok(!("workerExitStatus" in task), `${label}: task ${task.id} still carries workerExitStatus`);
	}
}

test("freshly written tasks.json contains no controlReservation/workerExitStatus", () => {
	const cwd = makeTmpCwd("pi-crew-g19-drop-");
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "pin dropped dead state fields" });
		assert.ok(tasks.length > 0, "workflow must produce at least one task");

		// 1) tasks.json straight from the real run-creation path
		const fresh = JSON.parse(fs.readFileSync(manifest.tasksPath, "utf8")) as TeamTaskState[];
		assertNoDeadFields("createRunManifest", fresh);

		// 2) after a post-execution-style terminal write through the real store
		const finished = tasks.map((task) => ({
			...task,
			status: "completed" as const,
			finishedAt: new Date().toISOString(),
		}));
		saveRunTasks(manifest, finished);
		const reread = JSON.parse(fs.readFileSync(manifest.tasksPath, "utf8")) as TeamTaskState[];
		assertNoDeadFields("saveRunTasks", reread);
		for (const task of reread) {
			assert.equal(task.status, "completed");
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
