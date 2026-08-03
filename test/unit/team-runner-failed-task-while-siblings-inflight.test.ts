/**
 * RT-1 regression test: failed task while siblings are in-flight.
 *
 * BUG (verified): handleFailedTask did `markBlocked` + `saveRunTasksAsync`
 * while sibling tasks were still in-flight (in ctx.pendingUnits). The
 * streaming-dispatch path only sets ctx.pendingUnits — it never updates
 * ctx.tasks to "running" — so ctx.tasks was stale ("queued") for in-flight
 * tasks. saveRunTasksAsync writes ctx.tasks DIRECTLY (no re-read/merge),
 * overwriting disk "running" with "skipped" (markBlocked maps queued→skipped).
 * drainPendingUnits only ran in the finally block (AFTER return), so settled
 * results were dropped. Net: in-flight task clobbered to skipped, work lost,
 * team resume won't re-queue skipped.
 *
 * FIX: In handleFailedTask, drain pendingUnits + merge settled results BEFORE
 * markBlocked+save. Cancel (not skip) in-flight tasks that didn't settle so
 * resume can re-queue them.
 *
 * Test strategy: 3 independent parallel tasks, all using the
 * retryable-failure mock (all fail). The first to merge triggers
 * handleFailedTask while the other two are still in-flight. With the fix,
 * the in-flight tasks' settled results are drained+merged → "failed" (not
 * "skipped"). Without the fix (mutation: revert drain+merge), the in-flight
 * tasks are clobbered to "skipped".
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test_resetCap, getWorkerCapCapacity } from "../../src/runtime/scheduling/global-worker-cap.ts";
import { executeTeamRun } from "../../src/runtime/team-runner.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

// ─── Mock env helpers ──────────────────────────────────────────────

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
	maxWorkers: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
		maxWorkers: process.env.PI_CREW_MAX_WORKERS,
	};
}

function setMockEnv(mock: string): void {
	process.env.PI_TEAMS_MOCK_CHILD_PI = mock;
	process.env.PI_CREW_ALLOW_MOCK = "1";
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
	if (state.maxWorkers === undefined) delete process.env.PI_CREW_MAX_WORKERS;
	else process.env.PI_CREW_MAX_WORKERS = state.maxWorkers;
}

// ─── Task fixture helpers ──────────────────────────────────────────

function makeTask(
	id: string,
	stepId: string,
	role: string,
	agent: string,
	runId: string,
	cwd: string,
): TeamTaskState {
	return {
		id,
		runId,
		stepId,
		role,
		agent,
		title: id,
		status: "queued",
		dependsOn: [],
		cwd,
		graph: {
			taskId: id,
			children: [],
			dependencies: [],
			queue: "ready",
		},
	};
}

function statusMap(tasks: TeamTaskState[]): Record<string, TeamTaskState["status"]> {
	const map: Record<string, TeamTaskState["status"]> = {};
	for (const t of tasks) map[t.id] = t.status;
	return map;
}

// ─── Tests ─────────────────────────────────────────────────────────

test("[RT-1] in-flight siblings are NOT skipped when one task fails (drain+merge preserves results)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt1-inflight-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure"); // all tasks fail
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4); // ensure enough worker slots for 3 parallel tasks
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "rt1-inflight",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// 3 INDEPENDENT tasks — all ready at once, dispatched as parallel batch.
		const workflow = {
			name: "rt1-inflight",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B" },
				{ id: "c", role: "worker", task: "C" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "RT-1 inflight test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd),
			makeTask("03_c", "c", "worker", "worker", created.manifest.runId, cwd),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 3 },
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// All 3 tasks fail (retryable-failure mock) and are dispatched in parallel
		// (maxConcurrentWorkers=3). The first to settle triggers handleFailedTask
		// while the other 2 are still in-flight (in ctx.pendingUnits). With the
		// fix, the in-flight tasks are drained+merged → NOT "skipped".
		// Without the fix (mutation: revert drain+merge), the in-flight siblings
		// would be clobbered to "skipped" by markBlocked+saveRunTasksAsync.
		const skippedIds = result.tasks.filter((t) => t.status === "skipped").map((t) => t.id);
		assert.equal(
			skippedIds.length,
			0,
			`no in-flight task should be skipped (RT-1 fix). Got skipped: [${skippedIds.join(", ")}]. ` +
				`All tasks: ${JSON.stringify(sm)}`,
		);

		// All tasks should have a terminal, re-queueable status (failed/cancelled),
		// NOT skipped.
		for (const t of result.tasks) {
			assert.ok(
				t.status === "failed" || t.status === "cancelled",
				`task ${t.id} should be failed/cancelled (re-queueable), got "${t.status}"`,
			);
		}

		// Verify disk state is consistent — no task clobbered to "skipped" on disk.
		const diskState = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(diskState, "run should be loadable from disk");
		const diskSm = statusMap(diskState.tasks);
		const diskSkipped = diskState.tasks.filter((t) => t.status === "skipped");
		assert.equal(
			diskSkipped.length,
			0,
			`no task should be skipped on disk. Got: ${JSON.stringify(diskSm)}`,
		);

		// Run should be marked failed.
		assert.equal(result.manifest.status, "failed", "run should be failed");
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[RT-1] in-flight sibling's settled result is merged (not lost)", async () => {
	// Use json-success for 2 tasks (they succeed) and retryable-failure for 1
	// (it fails). But since the mock is env-var based (not per-task), we test
	// with all-succeed first to confirm the merge path works, then verify the
	// failed-task abort path with retryable-failure.
	//
	// This sub-test focuses on verifying that after handleFailedTask drains,
	// the settled results are present in the final tasks (not dropped). With
	// retryable-failure, all tasks settle as "failed" — we verify those results
	// are in the final output (not silently dropped).
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt1-merge-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure");
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "rt1-merge",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "rt1-merge",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "RT-1 merge test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 2 },
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// Both tasks are dispatched in parallel and both fail. The first to merge
		// triggers handleFailedTask while the other is still in-flight. With the
		// fix, the in-flight sibling is drained+merged or cancelled → NOT skipped.
		// Without the fix, the in-flight sibling would be "skipped".
		for (const t of result.tasks) {
			assert.ok(
				t.status === "failed" || t.status === "cancelled",
				`task ${t.id} should be failed/cancelled (re-queueable, not skipped), got "${t.status}"`,
			);
		}

		// No task should be skipped — all dispatched tasks are in-flight and
		// should be drained/cancelled, not markBlocked→skipped.
		assert.ok(
			!result.tasks.some((t) => t.status === "skipped"),
			`no task should be skipped — all in-flight results should be drained/merged. ` +
				`Got: ${JSON.stringify(sm)}`,
		);
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[RT-1] downstream non-dispatched task IS skipped (original behavior preserved)", async () => {
	// 2 tasks: A (no deps) and B (dependsOn A). A fails → handleFailedTask runs.
	// B was never dispatched (DAG dependency not met), so it's NOT in
	// pendingUnits. B should still be "skipped" (original markBlocked behavior
	// for never-dispatched queued tasks). This verifies the fix only changes
	// behavior for IN-FLIGHT tasks, not for never-dispatched ones.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt1-downstream-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure");
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "rt1-downstream",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "rt1-downstream",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B", dependsOn: ["a"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "RT-1 downstream test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			{
				...makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd),
				dependsOn: ["a"],
				graph: {
					taskId: "02_b",
					children: [],
					dependencies: ["a"],
					queue: "ready",
				},
			},
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0 },
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// Task A fails (mock). Task B was never dispatched (dependsOn A) →
		// should be skipped (original markBlocked behavior for queued tasks
		// not in-flight).
		assert.equal(sm["01_a"], "failed", "task A should fail");
		assert.equal(sm["02_b"], "skipped", "downstream task B should be skipped (never dispatched, original behavior)");
		assert.equal(result.manifest.status, "failed");
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[RT-1] in-flight sibling's SUCCESSFUL result is preserved when another task fails", async () => {
	// Coverage gap closed: the tests above use an ALL-FAIL mock for in-flight
	// tasks, so they can only assert that in-flight tasks are NOT wrongly marked
	// "skipped". They cannot verify that a SUCCESSFUL in-flight result is
	// PRESERVED by the drain+merge. This test mixes success + failure in the
	// SAME parallel batch so that when the failing task triggers
	// handleFailedTask, an in-flight sibling that SUCCEEDED keeps its completed
	// result + output (not dropped, not skipped).
	//
	// Mock: `retryable-failure-then-success` — the FIRST runChildPi invocation
	// (per process) returns a soft retryable failure; subsequent invocations
	// return the standard json-success transcript. The mock counter is a
	// synchronous read-modify-write keyed by process.pid, so across the 3
	// concurrent (in-process, mock-mode) workers EXACTLY ONE reads count=1
	// (fails) and the other TWO read count>=2 (succeed) — regardless of
	// dispatch order. A single-model registry is supplied so the failing task
	// has NO fallback candidate to retry-and-succeed on; it stays "failed".
	//
	// NOTE on the abort race: handleFailedTask drains in-flight units via
	// drainPendingUnits, which aborts the run-scoped controller before
	// awaiting all settled promises. Workers that already produced output are
	// merged ("completed"); workers still mid-flight are cancelled
	// (re-queueable, NOT skipped). The completed/cancelled split is a
	// timing-dependent micro-race, so the assertions below verify INVARIANTS
	// that hold in every outcome (never skipped; exactly one model-error
	// failure; all terminal) plus the coverage-gap check that any task which
	// DID succeed keeps its full result data (modelAttempts/finishedAt).
	const counterFile = path.join(os.tmpdir(), `pi-crew-mock-counter-${process.pid}-retryable-failure-then-success`);
	try {
		fs.unlinkSync(counterFile);
	} catch {
		/* clean start — ignore if missing */
	}
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-rt1-success-preserved-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure-then-success");
	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4); // enough worker slots for 3 parallel tasks
	// Single-model registry → exactly one candidate → no model-fallback retry.
	// This makes the test robust regardless of the host's configured models.
	const modelRegistry = { getAvailable: () => [{ provider: "test", id: "mock-model" }] };
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "rt1-success",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// 3 INDEPENDENT tasks — all ready at once, dispatched as a parallel batch.
		const workflow = {
			name: "rt1-success",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B" },
				{ id: "c", role: "worker", task: "C" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "RT-1 success-preserved test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd),
			makeTask("03_c", "c", "worker", "worker", created.manifest.runId, cwd),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 0, maxConcurrentWorkers: 3 },
			reliability: { autoRetry: false },
			modelRegistry,
			workspaceId: cwd,
		});

		const sm = statusMap(result.tasks);

		// ── DETERMINISTIC INVARIANTS (hold regardless of the abort race) ──────
		//
		// handleFailedTask drains in-flight units by aborting the run-scoped
		// controller (drainPendingUnits) then merging whatever settled. Workers
		// that already produced output are merged ("completed"); workers still
		// running are cancelled (re-queueable). The exact split between
		// completed/cancelled is timing-dependent (a micro-race between worker
		// completion and abort propagation), so we assert INVARIANTS that hold
		// in every outcome rather than exact counts.

		// INVARIANT 1 (core RT-1 fix): NO task is skipped. In-flight tasks are
		// drained+merged or cancelled — never markBlocked→skipped. Without the
		// fix, the in-flight siblings would be clobbered to "skipped".
		const skipped = result.tasks.filter((t) => t.status === "skipped");
		assert.equal(
			skipped.length,
			0,
			`no in-flight task should be skipped (RT-1 fix). Got skipped: [${skipped.map((t) => t.id).join(", ")}]. ` +
				`All tasks: ${JSON.stringify(sm)}`,
		);

		// INVARIANT 2: exactly one task fails with the mock's model error — the
		// count=1 worker (single-model registry → no fallback retry → stays
		// failed). Other tasks may be completed/cancelled (abort race) but are
		// never the model-error failure.
		const modelFailed = result.tasks.filter((t) => /provider[_ ]?error/i.test(t.error ?? ""));
		assert.equal(
			modelFailed.length,
			1,
			`exactly one task should fail with the mock model error. Got: ${JSON.stringify(sm)}`,
		);
		assert.ok(modelFailed[0]!.error, `failed task ${modelFailed[0]!.id} must carry an error`);

		// INVARIANT 3: all tasks reach a terminal, accounted-for state — none is
		// lost/dropped (left "queued"/"running").
		for (const t of result.tasks) {
			assert.ok(
				t.status === "failed" || t.status === "completed" || t.status === "cancelled",
				`task ${t.id} should be terminal (failed/completed/cancelled), got "${t.status}"`,
			);
		}

		// INVARIANT 4: run is failed (the model-error task aborts via handleFailedTask).
		assert.equal(result.manifest.status, "failed", "run should be failed");

		// ── COVERAGE-GAP ASSERTION (closes the gap the all-fail tests leave) ──
		// The all-fail tests can only assert "not skipped". This test mixes a
		// real SUCCESS into the in-flight batch. Any task that SUCCEEDED must
		// keep its completed result + execution evidence (modelAttempts /
		// finishedAt) — PRESERVED by the drain+merge, not dropped. A task
		// clobbered to "skipped" (the original RT-1 bug) would have none of
		// this. With 2 success tasks in the batch, at least one typically
		// settles and is preserved; whenever a completion occurs this asserts
		// its data is intact.
		const completed = result.tasks.filter((t) => t.status === "completed");
		for (const t of completed) {
			assert.ok(t.finishedAt, `completed task ${t.id} must have finishedAt (result not dropped). All: ${JSON.stringify(sm)}`);
			assert.ok(
				t.modelAttempts?.some((a) => a.success),
				`completed task ${t.id} must preserve a successful model attempt (result not dropped). All: ${JSON.stringify(sm)}`,
			);
		}

		// Disk consistency: no task clobbered to "skipped" on disk either.
		const diskState = loadRunManifestById(cwd, created.manifest.runId);
		assert.ok(diskState, "run should be loadable from disk");
		const diskSkipped = diskState!.tasks.filter((t) => t.status === "skipped");
		assert.equal(
			diskSkipped.length,
			0,
			`no task should be skipped on disk. Got: ${JSON.stringify(statusMap(diskState!.tasks))}`,
		);
	} finally {
		__test_resetCap(prevCap);
		restoreMockEnv(prevEnv);
		try {
			fs.unlinkSync(counterFile);
		} catch {
			/* fine if already gone */
		}
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
