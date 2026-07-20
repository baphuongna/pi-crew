/**
 * FIND-06 follow-up — smoke / regression test for `runCoalescedTaskGroup`.
 *
 * The deterministic race test (asserting terminal state survives a >5s
 * heartbeat save that clobbers the final write) is **deferred** because:
 *   1. `node:test`'s `mock.module` cannot reliably replace the ESM-named
 *      export `saveRunTasksAsync` in `../../src/state/state-store.ts` for
 *      the already-bound import inside `run-coalesced-task-group.ts` (ESM
 *      live-binding semantics make the replacement non-deterministic).
 *   2. Driving the heartbeat path requires `executeWorkers: true` + a mocked
 *      `runChildPi`, and the heartbeat (15s `setInterval`) is internal to
 *      `runCoalescedTaskGroup` — there is no injection seam to control its
 *      timing or to force a late `saveRunTasksAsync` resolution.
 *
 * Instead, this test exercises the SCAFFOLD path (`executeWorkers: false`),
 * which still walks the FIND-06 code paths that matter for regression:
 *   - Hoisted-variable init (`heartbeatTimer`, `heartbeatInFlight`,
 *     `heartbeatPromise`, `finalWriteStarted`).
 *   - The `clearInterval` + drain block (`heartbeatTimer` is null in scaffold
 *     mode, so the drain is a no-op — but the guard conditions are exercised).
 *   - The final `saveRunTasksAsync` terminal write.
 *   - `writeArtifact` + `splitCoalescedOutput` + `mergeArtifacts`.
 *
 * This confirms the FIND-06 edits did not break the function's contract:
 * correct terminal status, resultArtifact shape, and manifest artifact merge.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { runCoalescedTaskGroup } from "../../src/runtime/run-coalesced-task-group.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "coalesced-smoke",
	description: "smoke",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf",
	description: "smoke",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "smoke worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-smoke-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

test("runCoalescedTaskGroup scaffold path produces correct terminal state + resultArtifact", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "FIND-06 smoke",
		});

		// The manifest comes with tasks created from the workflow; coalesce
		// them into a single group to exercise the multi-task scaffold path.
		const groupTasks: TeamTaskState[] = tasks.map((t) => ({
			...t,
			status: "queued" as const,
		}));
		const allTasks: TeamTaskState[] = [...groupTasks];

		const step = workflow.steps![0]!;
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: allTasks,
			groupTasks,
			step,
			agent,
			executeWorkers: false, // scaffold path — no heartbeat, no child pi
			workspaceId: "ws-smoke",
		});

		// ── Result shape ──
		assert.equal(typeof result, "object");
		assert.equal(result.success, true, "scaffold dispatch should succeed");
		assert.ok(result.taskIds.length > 0, "should have task IDs");

		// ── Terminal status ──
		// In scaffold mode, success=true and each task gets scaffold text, so
		// all tasks should be "completed".
		for (const task of result.tasks) {
			if (result.taskIds.includes(task.id)) {
				assert.equal(task.status, "completed", `task ${task.id} should be completed (got ${task.status})`);
				assert.ok(task.finishedAt, `task ${task.id} should have finishedAt`);
				assert.ok(task.resultArtifact, `task ${task.id} should have resultArtifact`);
			}
		}

		// ── resultArtifact shape ──
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			const artifact = task.resultArtifact!;
			assert.equal(artifact.kind, "result", `artifact kind should be 'result' for ${taskId}`);
			assert.ok(artifact.path?.includes(`${taskId}.txt`), `artifact path should include ${taskId}.txt (got ${artifact.path})`);
			// The artifact file should actually exist on disk.
			assert.ok(fs.existsSync(artifact.path), `artifact file should exist: ${artifact.path}`);
			const content = fs.readFileSync(artifact.path, "utf-8");
			assert.ok(content.length > 0, `artifact content should be non-empty for ${taskId}`);
		}

		// ── Manifest artifact merge ──
		const manifestArtifacts = result.manifest.artifacts;
		const resultArtifacts = manifestArtifacts.filter((a) => a.kind === "result");
		assert.equal(resultArtifacts.length, result.taskIds.length, "manifest should have one result artifact per task");

		// ── rawOutput should contain scaffold markers ──
		assert.ok(result.rawOutput.includes("<<<TASK_RESULT:"), "scaffold output should contain TASK_RESULT delimiters");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runCoalescedTaskGroup is a function (characterization)", () => {
	assert.equal(typeof runCoalescedTaskGroup, "function");
});
