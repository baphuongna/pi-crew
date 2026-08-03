/**
 * RT-5 divergence #3 — maxTurns hardcoded to 5, ignoring runtimeConfig.maxTurns.
 *
 * The coalesced dispatch path hardcoded `maxTurns: 5` instead of passing
 * `runtimeConfig.maxTurns` from input (like the singleton path in
 * child-executor.ts:432). This test verifies:
 *
 * 1. STRUCTURAL: the source passes `input.runtimeConfig?.maxTurns` to
 *    runWorker and does NOT contain a hardcoded `maxTurns: 5`.
 * 2. BEHAVIORAL (smoke): calling with `runtimeConfig: { maxTurns: 10 }`
 *    + mock-mode workers completes successfully (no crash, correct status).
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

const SRC_PATH = "src/runtime/scheduling/run-coalesced-task-group.ts";

const team: TeamConfig = {
	name: "coalesced-maxturns",
	description: "maxTurns config test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf-maxturns",
	description: "maxTurns test",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "maxTurns worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-maxturns-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function restoreEnv(key: string, prev: string | undefined): void {
	if (prev === undefined) delete process.env[key];
	else process.env[key] = prev;
}

test("RT-5 #3 structural: source passes runtimeConfig.maxTurns (not hardcoded 5)", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	// Must pass config-derived maxTurns.
	assert.match(
		src,
		/maxTurns:\s*input\.runtimeConfig\?\.maxTurns/,
		"runWorker must receive maxTurns from runtimeConfig.maxTurns",
	);

	// Must NOT contain the old hardcoded value.
	assert.doesNotMatch(
		src,
		/maxTurns:\s*5\b/,
		"hardcoded maxTurns:5 must be removed",
	);
});

test("RT-5 #3 behavioral: maxTurns from config does not crash dispatch (mock mode)", async () => {
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";

	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "RT-5 maxTurns test",
		});

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({
			...t,
			status: "queued" as const,
		}));
		const step = workflow.steps![0]!;

		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step,
			agent,
			executeWorkers: true,
			workspaceId: "ws-maxturns",
			runtimeConfig: { maxTurns: 10 },
		});

		// Mock json-success returns exit 0 → should succeed.
		assert.equal(result.success, true, "mock dispatch with maxTurns:10 should succeed");
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "completed", `task ${taskId} should be completed`);
		}
	} finally {
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", prevMock);
		restoreEnv("PI_CREW_ALLOW_MOCK", prevAllow);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
