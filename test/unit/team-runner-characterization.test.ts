/**
 * Characterization tests for executeTeamRun / executeTeamRunCore (CORE-4).
 *
 * PURPOSE: Lock CURRENT behavior of the god function BEFORE the Sprint 5
 * CORE-4 refactor (split into scheduler/ 8 functions). After refactor, these
 * same tests must still pass — any failure indicates a behavioral regression.
 *
 * These tests assert CURRENT behavior, even if that behavior has known quirks.
 * They are NOT bug fixes — they are a safety net.
 *
 * Strategy: call the `executeTeamRun` PUBLIC API with PI_TEAMS_MOCK_CHILD_PI
 * to control worker outcomes, then assert on the returned task status map,
 * manifest status, and the events.jsonl stream.
 *
 * Commit under test: 484a584 (pi-crew v0.9.51, pre-refactor).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearHooks, registerHook } from "../../src/hooks/registry.ts";
import { executeTeamRun } from "../../src/runtime/team-runner.ts";
import { readEvents } from "../../src/state/event-log/event-log.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

// ─── Shared helpers ────────────────────────────────────────────────

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
	};
}

function setMockEnv(mode: string | undefined): void {
	if (mode === undefined) {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		delete process.env.PI_CREW_ALLOW_MOCK;
	} else {
		process.env.PI_TEAMS_MOCK_CHILD_PI = mode;
		process.env.PI_CREW_ALLOW_MOCK = "1";
	}
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
}

/**
 * Build a TeamTaskState with sensible defaults for characterization tests.
 *
 * IMPORTANT: the `graph` property is REQUIRED for the task-graph-scheduler to
 * classify a task as "ready". Without it, `withQueue()` in task-graph-scheduler.ts
 * leaves `graph` undefined and the task never enters the ready batch — causing
 * a spurious "No ready queued task" block. When tasks have explicit dependsOn,
 * the DAG planner (dagReadyTaskIds) bypasses the snapshot.ready check, but for
 * tasks without explicit deps, the graph.queue field is the only signal.
 */
function makeTask(
	id: string,
	stepId: string,
	role: string,
	agent: string,
	runId: string,
	cwd: string,
	overrides: { dependsOn?: string[]; status?: TeamTaskState["status"] } = {},
): TeamTaskState {
	return {
		id,
		runId,
		stepId,
		role,
		agent,
		title: id,
		status: overrides.status ?? "queued",
		dependsOn: overrides.dependsOn ?? [],
		cwd,
		graph: {
			taskId: id,
			children: [],
			dependencies: overrides.dependsOn ?? [],
			queue: "ready",
		},
	};
}

interface RunFixture {
	cwd: string;
	team: never;
	workflow: never;
	agents: never;
	created: ReturnType<typeof createRunManifest>;
}

/**
 * Create a temp workspace + manifest for a run. The caller is responsible for
 * fs.rmSync(cwd) in its finally block.
 */
function createFixture(opts: {
	prefix: string;
	workflowName: string;
	steps: Array<{ id: string; role: string; task: string; dependsOn?: string[] }>;
	roles: Array<{ name: string; agent: string }>;
	agentNames: string[];
	goal?: string;
}): RunFixture {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-char-${opts.prefix}-`));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

	const team = {
		name: opts.workflowName,
		description: "",
		roles: opts.roles,
		source: "test" as const,
		filePath: "builtin",
	} as never;

	const workflow = {
		name: opts.workflowName,
		description: "",
		steps: opts.steps,
		source: "test" as const,
		filePath: "builtin",
	} as never;

	const agents = opts.agentNames.map((name) => ({
		name,
		description: "",
		source: "test" as const,
		filePath: "builtin",
		systemPrompt: "test",
	})) as never;

	const created = createRunManifest({ cwd, team, workflow, goal: opts.goal ?? "characterization" });

	return { cwd, team, workflow, agents, created };
}

/** Status map helper: taskId → status for quick assertions. */
function statusMap(tasks: TeamTaskState[]): Record<string, TeamTaskState["status"]> {
	const map: Record<string, TeamTaskState["status"]> = {};
	for (const t of tasks) map[t.id] = t.status;
	return map;
}

// ─── Scenario 1: Cancel mid-run ────────────────────────────────────

test("[char-1] cancel: pre-aborted signal marks all non-terminal tasks as cancelled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-cancel-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });

		const team = {
			name: "cancel",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "cancel",
			description: "",
			steps: [{ id: "a", role: "worker", task: "A" }],
			source: "test",
			filePath: "builtin",
		} as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "cancel" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd),
			makeTask("03_c", "c", "worker", "worker", created.manifest.runId, cwd),
		];
		saveRunTasks(created.manifest, tasks);

		// Pre-abort the signal — this triggers the cancel path at the TOP of the
		// while loop in executeTeamRunCore, before any task is dispatched. True
		// mid-run abort (with in-flight tasks) is hard to trigger reliably with
		// synchronous mocks; the cancel code path is identical regardless.
		const controller = new AbortController();
		controller.abort({ code: "leader_interrupted", message: "leader cancelled run" });

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents: [],
			executeWorkers: false,
			signal: controller.signal,
			workspaceId: cwd,
		});

		// All non-terminal tasks → cancelled
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_a"], "cancelled");
		assert.equal(sm["02_b"], "cancelled");
		assert.equal(sm["03_c"], "cancelled");
		assert.equal(result.manifest.status, "cancelled");

		// Events: run.cancelled + task.cancelled for each task
		const events = readEvents(created.manifest.eventsPath);
		assert.ok(
			events.some((e) => e.type === "run.cancelled"),
			"should emit run.cancelled event",
		);
		const cancelEvents = events.filter((e) => e.type === "task.cancelled");
		assert.ok(cancelEvents.length >= 3, `expected ≥3 task.cancelled events, got ${cancelEvents.length}`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 2: Failed task + retry ───────────────────────────────

test("[char-2] retry: failed task is re-queued when maxRetriesPerTask=1 (recovery.rerun_task)", async () => {
	// STRATEGY: Use retryable-failure mock (always fails) with maxRetriesPerTask=1.
	// Two tasks: A (fails) + B (dependsOn A, stays queued). When A fails, B is
	// still queued → the while loop re-enters → the failed-task check at the top
	// triggers shouldRerunFailedTask → recovery.rerun_task event + re-queue.
	// Since the mock always fails, the retried A also fails → run failed.
	//
	// IMPORTANT: the retry check at the top of the while loop body is only
	// reached when the while CONDITION is true (queued tasks or in-flight units).
	// A single-task run where the task fails exits the loop before reaching the
	// retry check. This is CURRENT behavior being characterized.
	//
	// NOTE: "fail then succeed" is hard to test reliably because the built-in
	// retryable-failure-then-success mock triggers MODEL-LEVEL fallback inside
	// runTeamTask (not the task-level retry path). A hook-based mock switcher
	// caused test contamination via clearHooks(). This approach is reliable and
	// characterizes the same retry-trigger code path.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-retry-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "retry",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "retry",
			description: "",
			steps: [
				{ id: "step-a", role: "worker", task: "A" },
				{ id: "step-b", role: "worker", task: "B", dependsOn: ["step-a"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "retry test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "step-a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "step-b", "worker", "worker", created.manifest.runId, cwd, { dependsOn: ["step-a"] }),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			limits: { maxRetriesPerTask: 1 },
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		// Task A ultimately fails (mock always fails, even on retry)
		assert.equal(result.tasks[0]?.status, "failed", "task A should fail after retry exhaustion");
		// Task B is downstream → skipped (blocked by failed A)
		assert.equal(result.tasks[1]?.status, "skipped", "task B should be skipped");
		assert.equal(result.manifest.status, "failed");

		// recovery.rerun_task event MUST be present — proves the retry was triggered
		const events = readEvents(created.manifest.eventsPath);
		const rerunEvents = events.filter((e) => e.type === "recovery.rerun_task");
		assert.ok(rerunEvents.length >= 1, "should emit recovery.rerun_task event (retry triggered)");
		assert.equal(rerunEvents[0]?.taskId, "01_a");
		assert.equal(rerunEvents[0]?.data?.attempt, 1, "first retry attempt");

		// Task A policy.retryCount should be 1 (one retry consumed)
		assert.equal(result.tasks[0]?.policy?.retryCount, 1, "retryCount should be 1 after one retry");
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 3: Failed task no retry ──────────────────────────────

test("[char-3] no-retry: failed task with maxRetriesPerTask=0 → run failed, downstream blocked", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-no-retry-"));
	const prevEnv = saveMockEnv();
	setMockEnv("retryable-failure"); // always fails
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "noretry",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "noretry",
			description: "",
			steps: [
				{ id: "step-a", role: "worker", task: "A" },
				{ id: "step-b", role: "worker", task: "B", dependsOn: ["step-a"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "no-retry" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "step-a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "step-b", "worker", "worker", created.manifest.runId, cwd, { dependsOn: ["step-a"] }),
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

		// Task A fails (mock always fails)
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_a"], "failed", "task A should fail");
		// Task B is downstream → markBlocked sets queued tasks to "skipped"
		assert.equal(sm["02_b"], "skipped", "downstream task B should be skipped (blocked)");
		assert.equal(result.manifest.status, "failed");
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 4: Budget abort ──────────────────────────────────────

test("[char-4] budget-abort: task consuming ≥95% of budget triggers run.budget_abort → run failed", async () => {
	// Mock json-success reports usage { input: 10, output: 5 } = 15 tokens total.
	// With budgetTotal=15, abort threshold = 0.95 * 15 = 14.25.
	// 15 >= 14.25 → abort fires.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-budget-abort-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "budget-abort",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "budget-abort",
			description: "",
			steps: [
				{ id: "step-a", role: "worker", task: "A" },
				{ id: "step-b", role: "worker", task: "B", dependsOn: ["step-a"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "budget abort" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "step-a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "step-b", "worker", "worker", created.manifest.runId, cwd, { dependsOn: ["step-a"] }),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			reliability: { autoRetry: false },
			budgetTotal: 15,
			budgetAbort: 0.95,
			budgetWarning: 0.8,
			workspaceId: cwd,
		});

		// Task A completed (15 tokens consumed), then budget abort fired
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_a"], "completed", "task A should complete before budget check");
		assert.equal(sm["02_b"], "skipped", "task B should be skipped after budget abort");
		assert.equal(result.manifest.status, "failed");

		const events = readEvents(created.manifest.eventsPath);
		assert.ok(
			events.some((e) => e.type === "run.budget_abort"),
			"should emit run.budget_abort event",
		);
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 5: Budget warning (no abort) ─────────────────────────

test("[char-5] budget-warning: task consuming ≥80% but <95% → run.budget_warning, run continues", async () => {
	// Mock json-success: 15 tokens. budgetTotal=18.
	// warn threshold = 0.8 * 18 = 14.4.  15 >= 14.4 → warning.
	// abort threshold = 0.95 * 18 = 17.1. 15 < 17.1 → no abort.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-budget-warn-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "budget-warn",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "budget-warn",
			description: "",
			steps: [{ id: "work", role: "worker", task: "work" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "budget warn" });
		const tasks: TeamTaskState[] = [makeTask("01_work", "work", "worker", "worker", created.manifest.runId, cwd)];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			reliability: { autoRetry: false },
			budgetTotal: 18,
			budgetAbort: 0.95,
			budgetWarning: 0.8,
			workspaceId: cwd,
		});

		// Task completes, warning fires, run continues → completed
		assert.equal(result.tasks[0]?.status, "completed");
		assert.equal(result.manifest.status, "completed");

		const events = readEvents(created.manifest.eventsPath);
		assert.ok(
			events.some((e) => e.type === "run.budget_warning"),
			"should emit run.budget_warning event",
		);
		assert.ok(!events.some((e) => e.type === "run.budget_abort"), "should NOT emit run.budget_abort");
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 6: Workflow phase advance ────────────────────────────

test("[char-6] phase-advance: completing phase-1 tasks emits workflow.phase_completed", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-phase-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "phase",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// 2-phase workflow: phase1 → phase2 (sequential via dependsOn)
		const workflow = {
			name: "phase",
			description: "",
			steps: [
				{ id: "phase1", role: "worker", task: "Phase 1" },
				{ id: "phase2", role: "worker", task: "Phase 2", dependsOn: ["phase1"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "phase test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_p1", "phase1", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_p2", "phase2", "worker", "worker", created.manifest.runId, cwd, { dependsOn: ["phase1"] }),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		// Both tasks complete, phases advance
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_p1"], "completed");
		assert.equal(sm["02_p2"], "completed");
		assert.equal(result.manifest.status, "completed");

		const events = readEvents(created.manifest.eventsPath);
		const phaseCompleted = events.filter((e) => e.type === "workflow.phase_completed");
		assert.ok(phaseCompleted.length >= 1, "should emit at least one workflow.phase_completed event");
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 7: Plan approval pending ─────────────────────────────

test("[char-7] plan-approval: mutating task blocked by plan approval, read-only task still executes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-plan-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "plan-approval",
			description: "",
			roles: [
				{ name: "explorer", agent: "explorer" },
				{ name: "executor", agent: "executor" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		// explorer = read-only (planning), executor = write (implementation)
		const workflow = {
			name: "plan-approval",
			description: "",
			steps: [
				{ id: "plan", role: "explorer", task: "Plan" },
				{ id: "execute", role: "executor", task: "Execute", dependsOn: ["plan"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [
			{ name: "explorer", description: "", source: "test", filePath: "builtin", systemPrompt: "test" },
			{ name: "executor", description: "", source: "test", filePath: "builtin", systemPrompt: "test" },
		] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "plan approval" });
		const tasks: TeamTaskState[] = [
			makeTask("01_plan", "plan", "explorer", "explorer", created.manifest.runId, cwd),
			makeTask("02_exec", "execute", "executor", "executor", created.manifest.runId, cwd, { dependsOn: ["plan"] }),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			reliability: { autoRetry: false },
			runtimeConfig: { requirePlanApproval: true },
			workspaceId: cwd,
		});

		// Read-only task A completes; mutating task B stays queued; run blocks
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_plan"], "completed", "read-only planning task should execute");
		assert.equal(sm["02_exec"], "queued", "mutating task should remain queued (plan approval pending)");
		assert.equal(result.manifest.status, "blocked");

		const events = readEvents(created.manifest.eventsPath);
		assert.ok(
			events.some((e) => e.type === "plan.approval_required"),
			"should emit plan.approval_required event",
		);
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 8: Parallel batch merge ──────────────────────────────

test("[char-8] parallel-merge: 3 tasks dispatched in parallel all reach completed (no lost updates)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-merge-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "merge",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// 3 independent tasks — all ready at once, dispatched as parallel batch
		const workflow = {
			name: "merge",
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

		const created = createRunManifest({ cwd, team, workflow, goal: "parallel merge" });
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
			workspaceId: cwd,
		});

		// All 3 tasks should be completed regardless of completion order.
		// The streaming-dispatch merge (withRunLock + mergeTaskUpdatesPreservingTerminal)
		// must not lose any task's terminal state.
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_a"], "completed", "task A should be completed");
		assert.equal(sm["02_b"], "completed", "task B should be completed");
		assert.equal(sm["03_c"], "completed", "task C should be completed");
		assert.equal(result.manifest.status, "completed");
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 9: DAG dependsOn ─────────────────────────────────────

test("[char-9] dag-depends: task B with dependsOn=['a'] not ready until A completes", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-dag-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "dag",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "dag",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B", dependsOn: ["a"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "dag test" });
		const tasks: TeamTaskState[] = [
			makeTask("01_a", "a", "worker", "worker", created.manifest.runId, cwd),
			makeTask("02_b", "b", "worker", "worker", created.manifest.runId, cwd, { dependsOn: ["a"] }),
		];
		saveRunTasks(created.manifest, tasks);

		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		// A completes first, then B (DAG ordering). Both terminal, no deadlock.
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_a"], "completed");
		assert.equal(sm["02_b"], "completed");
		assert.equal(result.manifest.status, "completed");

		// B should have started AFTER A finished (DAG dependency enforced)
		const taskA = result.tasks.find((t) => t.id === "01_a");
		const taskB = result.tasks.find((t) => t.id === "02_b");
		assert.ok(taskA?.finishedAt, "task A should have finishedAt");
		assert.ok(taskB?.startedAt, "task B should have startedAt");
		// B started at or after A finished (DAG ordering)
		assert.ok(
			new Date(taskB!.startedAt!).getTime() >= new Date(taskA!.finishedAt!).getTime() - 1,
			"task B should start after task A finishes (DAG ordering)",
		);
	} finally {
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── Scenario 10: Empty ready batch (all hook-skipped) ─────────────

test("[char-10] hook-skip: before_task_start blocking all tasks → run terminates (no deadlock)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-hookskip-"));
	const prevEnv = saveMockEnv();
	setMockEnv("json-success");
	// Register a blocking before_task_start hook that blocks ALL tasks.
	// This causes every ready task to be marked "skipped", producing an empty
	// readyBatch. The scheduler's `if (pendingUnits.size === 0) continue` re-loops,
	// and since no queued tasks remain, the while loop exits — no deadlock.
	const hookId = registerHook({
		name: "before_task_start",
		mode: "blocking",
		handler: () => ({ outcome: "block" as const, reason: "test: block all tasks" }),
	});
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");

		const team = {
			name: "hookskip",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "hookskip",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "A" },
				{ id: "b", role: "worker", task: "B" },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;

		const created = createRunManifest({ cwd, team, workflow, goal: "hook skip" });
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
			reliability: { autoRetry: false },
			workspaceId: cwd,
		});

		// Both tasks should be "skipped" (hook-blocked)
		const sm = statusMap(result.tasks);
		assert.equal(sm["01_a"], "skipped", "task A should be skipped by hook");
		assert.equal(sm["02_b"], "skipped", "task B should be skipped by hook");

		// The run must reach a terminal state — NOT hang/deadlock.
		// Current behavior: with all tasks skipped and no queued tasks remaining,
		// the loop exits. The post-loop status depends on effectiveness evaluation.
		assert.ok(
			result.manifest.status === "completed" || result.manifest.status === "blocked" || result.manifest.status === "failed",
			`run should reach terminal status, got: ${result.manifest.status}`,
		);
	} finally {
		clearHooks();
		restoreMockEnv(prevEnv);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
