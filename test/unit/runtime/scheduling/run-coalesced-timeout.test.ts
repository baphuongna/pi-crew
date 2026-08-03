/**
 * RT-5 divergence #4 — wall-clock task timeout (taskTimeoutMs).
 *
 * The coalesced dispatch path must arm a wall-clock timeout from
 * `input.runtimeConfig?.taskTimeoutMs` (mirroring the singleton path's
 * AbortController+setTimeout pattern in child-executor.ts). When the timeout
 * fires it aborts the per-attempt AbortController whose signal is threaded
 * into runWorker → runChildPi, which kills the hung child and reports
 * exitStatus.cancelled=true → the task lands in the "cancelled" branch
 * (NOT "failed", NOT "completed").
 *
 * ── WHY THE OLD BEHAVIORAL CASE WAS A FALSE CONFIRMATION ──
 * The previous behavioral case used PI_TEAMS_MOCK_CHILD_PI=json-success,
 * which resolves synchronously in <1ms. With taskTimeoutMs:5000 the timeout
 * was ARMED but NEVER FIRED, and the test asserted success===true (i.e. it
 * only proved the timeout *didn't* break the happy path). If the entire
 * timeout guard (`if (taskTimeoutMs > 0 ...)`) is deleted, that old test
 * STILL passes — zero behavioral coverage of the safety-critical divergence.
 *
 * ── NEW BEHAVIORAL CASE (mutation-equivalent) ──
 * Spawns a REAL fake-pi process that emits one message then HANGS, with
 * taskTimeoutMs (300ms) well below the response-timeout (2000ms). The TASK
 * timeout fires first, aborts the worker, and the task is reported "cancelled".
 *
 * Mutation equivalence: delete the `if (taskTimeoutMs > 0 && ...)` arming block
 * (or set taskTimeoutMs to 0). Then taskTimeoutMs never fires; the response-
 * timeout (2000ms) kills the hung child instead via a DIFFERENT path that
 * leaves exitStatus.cancelled=false (abortRequested is only set by the parent-
 * signal abort listener, not by the response-timeout path). Result: success is
 * still false, but the task lands in the "failed" branch (not "cancelled"), and
 * the elapsed time jumps to ~2000ms. The status + timing assertions both fail.
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

// taskTimeoutMs must be BELOW the response-timeout so the TASK timeout fires
// first (this is the divergence under test).
const TASK_TIMEOUT_MS = 300;
// Response-timeout floor is 1000ms; set 2000ms so the task timeout (300ms)
// wins, and so the "timeout removed" mutation still resolves in ~2s (not the
// 10-minute default — which would exceed the test runner timeout).
const RESPONSE_TIMEOUT_MS = 2000;

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

/** Snapshot a set of env vars for later restore. */
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

test("RT-5 #4 structural: source arms wall-clock timeout from taskTimeoutMs", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	// taskTimeoutMs must be read from runtimeConfig.
	assert.match(src, /taskTimeoutMs\s*=\s*input\.runtimeConfig\?\.taskTimeoutMs/, "taskTimeoutMs must be read from runtimeConfig");

	// A timeoutController must be created and linked to the run-level signal.
	assert.match(src, /new AbortController\(\)/, "must create a timeout AbortController");
	assert.match(
		src,
		/externalAbortListener\s*=\s*\(\)\s*=>\s*timeoutController\.abort/,
		"must link run-level signal to timeoutController via listener",
	);

	// setTimeout must be armed when taskTimeoutMs > 0.
	assert.match(src, /if\s*\(taskTimeoutMs\s*>\s*0/, "setTimeout must be guarded by taskTimeoutMs > 0");
	assert.match(src, /clearTimeout\(timeoutHandle\)/, "finally must clearTimeout to prevent leak");
});

test("RT-5 #4 behavioral: hung worker → taskTimeoutMs FIRES → task 'cancelled' (not completed/failed)", async () => {
	// ── Setup: fake-pi that STARTS (emits one message) then HANGS ──
	//
	// Emulates a worker that begins responding but never completes. The
	// taskTimeoutMs (300ms) must abort it long before the response-timeout
	// (2000ms). We use a REAL child process (not PI_TEAMS_MOCK_CHILD_PI)
	// because no mock mode sleeps: every mock resolves synchronously, so the
	// timeout can never fire against a mock. The test drives the PUBLIC
	// runCoalescedTaskGroup API (no internal mocking/spying) and asserts on
	// the returned task statuses.
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-timeout-fakepi-"));
	const scriptPath = path.join(scriptDir, "fake-pi-hang.js");
	fs.writeFileSync(
		scriptPath,
		[
			"// RT-5 #4 fixture: emit one valid message (a 'started' worker), then hang.",
			"process.stdout.write(JSON.stringify({",
			"\ttype: 'message',",
			"\tmessage: { role: 'assistant', content: [{ type: 'text', text: 'started, now hanging' }] },",
			"}) + '\\n');",
			"// Exit promptly on SIGTERM so the abort path reaps us fast.",
			"process.on('SIGTERM', () => process.exit(143));",
			"// Hang — taskTimeoutMs (300ms) aborts the run long before this fires.",
			"setTimeout(() => {}, 60000);",
		].join("\n"),
	);

	// npm_config_prefix (lowercase takes precedence) makes scriptDir an allowed
	// prefix for PI_TEAMS_PI_BIN validation (pi-spawn.ts isWithinAllowedPrefixes).
	const envSnap = snapshotEnv([
		"PI_TEAMS_PI_BIN",
		"PI_TEAMS_MOCK_CHILD_PI",
		"PI_CREW_ALLOW_MOCK",
		"PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS",
		"PI_CREW_DEPTH",
		"npm_config_prefix",
	]);
	process.env.npm_config_prefix = scriptDir;
	process.env.PI_TEAMS_PI_BIN = scriptPath;
	process.env.PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS = String(RESPONSE_TIMEOUT_MS);
	delete process.env.PI_TEAMS_MOCK_CHILD_PI; // MUST NOT use the sync mock path
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
			goal: "RT-5 timeout fire",
		});

		const groupTasks: TeamTaskState[] = tasks.map((t) => ({
			...t,
			status: "queued" as const,
		}));
		const step = workflow.steps![0]!;

		const startMs = Date.now();
		const result = await runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step,
			agent,
			executeWorkers: true,
			workspaceId: "ws-timeout-fire",
			// taskTimeoutMs below RESPONSE_TIMEOUT_MS so the TASK timeout fires first.
			runtimeConfig: { taskTimeoutMs: TASK_TIMEOUT_MS },
			// Single attempt — deterministic; runOnce returns a settled result
			// (does not throw on timeout) so retry would not change the outcome,
			// but disabling it removes any retry-delay noise from timing.
			reliability: { autoRetry: false },
		});
		const elapsedMs = Date.now() - startMs;

		// PRIMARY (behavioral): the taskTimeoutMs FIRED and aborted the hung
		// worker via the parent-signal path → success MUST be false.
		assert.equal(result.success, false, "a worker aborted by taskTimeoutMs must NOT succeed");

		// The abort sets exitStatus.cancelled=true (child-pi.ts abort listener
		// sets abortRequested=true → exitStatus.cancelled=true), so the status
		// maps to "cancelled" (NOT "completed", NOT "failed"). This is the
		// mutation-discriminating assertion: see the file header for why removing
		// the timeout arming flips this to "failed".
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(
				task.status,
				"cancelled",
				`task ${taskId} must be 'cancelled' (got '${task.status}') — taskTimeoutMs fired and aborted the worker`,
			);
		}

		// SECONDARY (timing): the run must complete near the 300ms TASK timeout,
		// NOT the 2000ms response-timeout. Corroborates that the task timeout
		// (not the response-timeout) terminated the worker. The threshold sits
		// well above 300ms + spawn/kill/settle overhead and well below 2000ms.
		assert.ok(
			elapsedMs < 1500,
			`run should complete near the ${TASK_TIMEOUT_MS}ms task timeout, not the ${RESPONSE_TIMEOUT_MS}ms response-timeout (took ${elapsedMs}ms)`,
		);
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});
