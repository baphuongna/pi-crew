/**
 * RT-5 divergence #5 — DEFAULT_RETRY_POLICY hardcoded, ignoring
 * reliability.autoRetry===false.
 *
 * The coalesced dispatch path always used `executeWithRetry(fn,
 * DEFAULT_RETRY_POLICY, { signal })`, ignoring `reliability.autoRetry` (which
 * defaults to true / opt-out). The singleton path gates retry with
 * `shouldUseRetry(input.reliability)` and uses `retryPolicyFromConfig` for
 * the policy (team-runner.ts:1548-1578). This test verifies:
 *
 * 1. STRUCTURAL: the source checks `autoRetry` to decide retry vs single-shot,
 *    and builds the policy from config (not hardcoded DEFAULT_RETRY_POLICY as
 *    the sole policy argument).
 * 2. BEHAVIORAL: with `autoRetry===false`, the dispatch runs without the
 *    executeWithRetry wrapper (single-shot) and completes correctly in mock
 *    mode.
 * 3. BEHAVIORAL: with `autoRetry===false` + already-aborted signal, the error
 *    propagates directly (no retry sleep) and the status is "cancelled".
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
	name: "coalesced-retry",
	description: "retry config test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf-retry",
	description: "retry test",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "retry worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-retry-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function restoreEnv(key: string, prev: string | undefined): void {
	if (prev === undefined) delete process.env[key];
	else process.env[key] = prev;
}

test("RT-5 #5 structural: source gates retry with autoRetry and uses config policy", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	// Must check autoRetry to decide whether to use executeWithRetry.
	assert.match(
		src,
		/autoRetry/,
		"source must reference reliability.autoRetry for retry gating",
	);

	// Must build the policy from config, not pass DEFAULT_RETRY_POLICY directly
	// to executeWithRetry.
	assert.match(
		src,
		/\.\.\.DEFAULT_RETRY_POLICY,\s*\.\.\.\(input\.reliability\?\.retryPolicy/,
		"policy must spread config retryPolicy over DEFAULT_RETRY_POLICY",
	);

	// Must have a useRetry gate that conditionally calls executeWithRetry.
	assert.match(
		src,
		/useRetry/,
		"source must have a useRetry gate for conditional retry",
	);
});

test("RT-5 #5 behavioral: autoRetry===false → dispatch completes (mock mode, single-shot)", async () => {
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
			goal: "RT-5 retry test",
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
			workspaceId: "ws-retry",
			reliability: { autoRetry: false },
		});

		// autoRetry===false → single-shot path. Mock succeeds → completed.
		assert.equal(result.success, true, "single-shot mock dispatch should succeed");
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

test("RT-5 #5 behavioral: autoRetry===false + aborted signal → cancelled (no retry sleep)", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "RT-5 retry-cancel test",
		});

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({
			...t,
			status: "queued" as const,
		}));
		const step = workflow.steps![0]!;

		const controller = new AbortController();
		controller.abort();

		const start = Date.now();
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step,
			agent,
			signal: controller.signal,
			executeWorkers: true,
			workspaceId: "ws-retry-cancel",
			reliability: { autoRetry: false },
		});
		const elapsed = Date.now() - start;

		// With autoRetry===false, runOnce is called directly (no executeWithRetry).
		// The already-aborted signal → timeoutController immediately aborted →
		// runChildPi returns abort result → cancelled=true, success=false.
		// No retry sleep delays the result.
		assert.equal(result.success, false, "aborted dispatch must fail");
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "cancelled", `task ${taskId} must be cancelled`);
		}

		// Should complete quickly — no retry backoff sleep (default 1000ms).
		assert.ok(elapsed < 1000, `should complete without retry sleep (took ${elapsed}ms)`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
