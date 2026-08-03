/**
 * RT-5 divergence #1 — cancel misreported as "failed".
 *
 * When the run-level signal is aborted (user/leader cancel), the coalesced
 * dispatch path must report task status as "cancelled", NOT "failed".
 * Previously the path had no cancel concept — `ok ? "completed" : "failed"`
 * — which broke `handleRetry` discrimination downstream.
 *
 * This is a BEHAVIORAL test: an already-aborted signal causes
 * executeWithRetry's `throwIfCancelled` to fire before runWorker is called,
 * landing in the catch block where `cancelled` is set from `signal?.aborted`.
 * The status mapping then branches to "cancelled".
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runCoalescedTaskGroup } from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "coalesced-cancel",
	description: "cancel status test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf-cancel",
	description: "cancel test",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "cancel worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-cancel-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

test("RT-5 #1: already-aborted signal → tasks get 'cancelled' status (not 'failed')", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "RT-5 cancel test",
		});

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({
			...t,
			status: "queued" as const,
		}));
		const allTasks: TeamTaskState[] = [...groupTasks];
		const step = workflow.steps![0]!;

		// Abort the signal BEFORE calling — simulate user/leader cancel.
		const controller = new AbortController();
		controller.abort();

		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: allTasks,
			groupTasks,
			step,
			agent,
			signal: controller.signal,
			executeWorkers: true,
			workspaceId: "ws-cancel",
		});

		// success must be false (cancelled is not success).
		assert.equal(result.success, false, "cancelled dispatch must report success=false");

		// Every group task must be "cancelled" — NOT "failed".
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(
				task.status,
				"cancelled",
				`task ${taskId} must be 'cancelled' (got '${task.status}')`,
			);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
