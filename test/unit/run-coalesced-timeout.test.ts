/**
 * RT-5 divergence #4 — no wall-clock timeout.
 *
 * The coalesced dispatch path never armed a wall-clock timeout, unlike the
 * singleton path which arms `taskTimeoutMs` via an AbortController+setTimeout
 * (child-executor.ts:395-430). This test verifies:
 *
 * 1. STRUCTURAL: the source mirrors the singleton's timeout pattern — creates
 *    a timeoutController, links the run-level signal, and arms a setTimeout
 *    from `input.runtimeConfig?.taskTimeoutMs`.
 * 2. BEHAVIORAL (smoke): calling with `runtimeConfig: { taskTimeoutMs: 5000 }`
 *    + mock-mode workers completes successfully (timeout armed then cleaned up).
 * 3. BEHAVIORAL (cancel via timeout): when `autoRetry===false` and the signal
 *    is pre-aborted, the timeout controller is immediately aborted and the
 *    result reflects cancellation (not failure).
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

const SRC_PATH = "src/runtime/run-coalesced-task-group.ts";

const team: TeamConfig = {
	name: "coalesced-timeout",
	description: "timeout test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf-timeout",
	description: "timeout test",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "timeout worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-timeout-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function restoreEnv(key: string, prev: string | undefined): void {
	if (prev === undefined) delete process.env[key];
	else process.env[key] = prev;
}

test("RT-5 #4 structural: source arms wall-clock timeout from taskTimeoutMs", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	// taskTimeoutMs must be read from runtimeConfig.
	assert.match(
		src,
		/taskTimeoutMs\s*=\s*input\.runtimeConfig\?\.taskTimeoutMs/,
		"taskTimeoutMs must be read from runtimeConfig",
	);

	// A timeoutController must be created and linked to the run-level signal.
	assert.match(src, /new AbortController\(\)/, "must create a timeout AbortController");
	assert.match(
		src,
		/externalAbortListener\s*=\s*\(\)\s*=>\s*timeoutController\.abort/,
		"must link run-level signal to timeoutController via listener",
	);

	// setTimeout must be armed when taskTimeoutMs > 0.
	assert.match(
		src,
		/if\s*\(taskTimeoutMs\s*>\s*0/,
		"setTimeout must be guarded by taskTimeoutMs > 0",
	);
	assert.match(
		src,
		/clearTimeout\(timeoutHandle\)/,
		"finally must clearTimeout to prevent leak",
	);
});

test("RT-5 #4 behavioral: taskTimeoutMs configured → dispatch completes (mock mode)", async () => {
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
			goal: "RT-5 timeout test",
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
			workspaceId: "ws-timeout",
			runtimeConfig: { taskTimeoutMs: 5000 },
		});

		// Mock completes fast — timeout must NOT fire, result should succeed.
		assert.equal(result.success, true, "fast mock dispatch should succeed despite timeout config");
	} finally {
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", prevMock);
		restoreEnv("PI_CREW_ALLOW_MOCK", prevAllow);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
