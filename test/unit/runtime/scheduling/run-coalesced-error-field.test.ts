/**
 * RT-5 divergence #2 — error-field behavioral test.
 *
 * The RT-5 fix in src/runtime/scheduling/run-coalesced-task-group.ts (~:204) changed
 * success computation to:
 *
 *   success = !cancelled && result.exitCode === 0 && !result.error
 *
 * Previously success was `exitCode === 0` only. The `!result.error` guard
 * ensures that a child-pi result carrying an `error` string (e.g. from a
 * response-timeout kill) is treated as failure even when exitCode is 0.
 *
 * Coverage gap (Agent-8): the cancel-status test covers the `cancelled`
 * branch; the retry-config test covers `autoRetry`; neither covers
 * "exitCode:0 WITH an error field → success===false". This file closes that
 * gap with three tests:
 *
 * 1. STRUCTURAL — verifies `!result.error` exists in the source success
 *    computation (guards against accidental removal during refactor).
 * 2. BEHAVIORAL (mock, positive) — json-success mock → exitCode:0, NO error
 *    → success===true, tasks "completed". Proves the happy path where the
 *    `!result.error` operand is true.
 * 3. BEHAVIORAL (real process, negative) — a fake pi script that produces
 *    zero stdout, hits runChildPi's response-timeout, catches SIGTERM, and
 *    exits code 0. runChildPi sets `error` on the result (response-timeout
 *    message) while exitCode remains 0. → success===false, tasks "failed".
 *
 * Test #3 uses a REAL child process (not PI_TEAMS_MOCK_CHILD_PI) because
 * no existing mock mode produces exitCode:0 WITH an error field: the `error`
 * field is only set by runChildPi's response-timeout / spawn-error paths,
 * all of which the mocks bypass by returning a hardcoded result object.
 * The test drives the PUBLIC runCoalescedTaskGroup API (no internal mocking
 * or spying) and asserts on the returned task statuses.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { __test_resetCap, getWorkerCapCapacity } from "../../../../src/runtime/scheduling/global-worker-cap.ts";
import { runCoalescedTaskGroup } from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const SRC_PATH = "src/runtime/scheduling/run-coalesced-task-group.ts";

const team: TeamConfig = {
	name: "coalesced-error",
	description: "error-field test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf-error",
	description: "error test",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "error worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-error-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

/** Save/restore helper for a single env var. */
function snapshotEnv(keys: string[]): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of keys) snap[k] = process.env[k];
	return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(snap)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

// ── Tests ───────────────────────────────────────────────────────────

test("RT-5 #2 structural: success computation includes !result.error guard", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	// The success line must reference result.error.
	assert.match(src, /!\s*result\.error/, "success computation must include !result.error to treat error-field results as failure");

	// The full three-operand success expression must be present.
	assert.match(
		src,
		/success\s*=\s*!cancelled\s*&&\s*result\.exitCode\s*===\s*0\s*&&\s*!result\.error/,
		"success must be the conjunction of !cancelled && exitCode===0 && !result.error",
	);
});

test("RT-5 #2 behavioral: exitCode:0 with NO error → success (mock json-success)", async () => {
	const envSnap = snapshotEnv(["PI_TEAMS_MOCK_CHILD_PI", "PI_CREW_ALLOW_MOCK"]);
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_CREW_ALLOW_MOCK = "1";

	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "RT-5 error positive",
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
			workspaceId: "ws-error-pos",
		});

		// exitCode:0, no error field → success=true.
		assert.equal(result.success, true, "exitCode:0 with no error must succeed");

		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "completed", `task ${taskId} must be completed`);
		}
	} finally {
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("RT-5 #2 behavioral: exitCode:0 WITH error field → FAILED (not completed)", async () => {
	// ── Setup: fake pi script that produces zero stdout, catches SIGTERM, exits 0 ──
	//
	// runChildPi's response-timeout path sets `error` on the result when the
	// child stops producing output. If the child catches SIGTERM and exits
	// code 0, the close handler sees exitCode=0 AND responseTimeoutHit=true,
	// producing the rare but real combination: exitCode:0 + error.
	//
	// This cannot be reproduced via PI_TEAMS_MOCK_CHILD_PI (mocks return a
	// hardcoded object with no error field). We spawn a REAL process instead.
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-errfakepi-"));
	const scriptPath = path.join(scriptDir, "fake-pi-error.js");
	fs.writeFileSync(
		scriptPath,
		[
			"// Trap SIGTERM and exit 0 so the close handler sees exitCode=0.",
			"process.on('SIGTERM', () => process.exit(0));",
			"// Produce ZERO stdout so runChildPi's response-timeout fires.",
			"setTimeout(() => {}, 60000);",
		].join("\n"),
	);

	const envKeys = [
		"PI_TEAMS_PI_BIN",
		"PI_TEAMS_MOCK_CHILD_PI",
		"PI_CREW_ALLOW_MOCK",
		"PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS",
		"PI_CREW_DEPTH",
		"npm_config_prefix",
	];
	const envSnap = snapshotEnv(envKeys);

	// Use npm_config_prefix (lowercase takes precedence over NPM_CONFIG_PREFIX)
	// to make scriptDir an allowed prefix for PI_TEAMS_PI_BIN validation.
	process.env.npm_config_prefix = scriptDir;
	process.env.PI_TEAMS_PI_BIN = scriptPath;
	process.env.PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS = "1000"; // minimum allowed
	delete process.env.PI_TEAMS_MOCK_CHILD_PI; // MUST NOT use mock path
	delete process.env.PI_CREW_ALLOW_MOCK;
	delete process.env.PI_CREW_DEPTH; // avoid depth-guard interference

	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4); // ensure a free worker slot

	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "RT-5 error negative",
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
			workspaceId: "ws-error-neg",
			// Disable retry so the single-shot result is returned directly.
			reliability: { autoRetry: false },
		});

		// exitCode:0 BUT error field is set → success MUST be false.
		// This is the exact branch the RT-5 #2 fix added: without !result.error,
		// this would be success=true (exitCode===0 only).
		assert.equal(result.success, false, "exitCode:0 WITH error field must report success=false (RT-5 #2 fix)");

		// Tasks must be "failed" (not "completed", not "cancelled").
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(
				task.status,
				"failed",
				`task ${taskId} must be 'failed' (got '${task.status}') — exitCode:0+error → NOT completed`,
			);
		}
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});
