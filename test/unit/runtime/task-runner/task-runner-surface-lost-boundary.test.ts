/**
 * RR-013 (F04) — execution-result BOUNDARY fidelity regression tests.
 *
 * WHY THIS FILE EXISTS (and why `post-execution-surface-lost.test.ts` was not
 * enough): that test calls `finalizeTaskResult` DIRECTLY with a hand-built
 * `TaskExecutionResult` (it injects `surfaceLost` itself), so it bypasses the
 * exact adapter that was broken — the manual field copy in
 * `src/runtime/task-runner.ts`. Because `runTeamTask` is the ONLY production
 * caller of `finalizeTaskResult`, the `needs_attention` branch at
 * `post-execution.ts:149` was UNREACHABLE in production while that direct-call
 * test stayed green.
 *
 * These tests therefore drive the PUBLIC `runTeamTask` API (same harness as
 * `task-runner-characterization.test.ts`: mock child via
 * `PI_TEAMS_MOCK_CHILD_PI` + `PI_CREW_ALLOW_MOCK`) and assert on the OBSERVABLE
 * outcome — terminal status, terminal event, and the consumer effect of the
 * field — never on the field merely existing at a call site.
 *
 * Boundary under test:
 *   child-executor.ts (producer: `surfaceLost` / `rawFinalText`)
 *     → task-runner.ts  (the hand-off that dropped both)
 *       → post-execution.ts (consumer: needs_attention terminalisation /
 *                            spec-evidence footer union)
 *
 * Seam: `mock-fixtures.ts` modes `surface-degraded` and `raw-final-text-only`
 * (both guarded by the existing parent-only `PI_CREW_ALLOW_MOCK` check).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { planHeadlessRedeplays } from "../../../../src/runtime/surface/degrade.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { saveSpecRecord } from "../../../../src/state/stores/spec-store.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { SpecRecord, TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig, WorkflowStep } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Fixtures (mirrors task-runner-characterization.test.ts) ────────

const team: TeamConfig = {
	name: "rr013-boundary",
	description: "execution-result boundary fidelity",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const agent: AgentConfig = {
	name: "worker",
	description: "rr013 boundary worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

/** Default single-step workflow; callers spread in step overrides. */
function step(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
	return { id: "s", role: "worker", task: "Do the task", source: "builtin", ...overrides };
}

function workflowOf(steps: WorkflowStep[]): WorkflowConfig {
	return { name: "w", description: "rr013", source: "builtin", filePath: "builtin", steps };
}

/**
 * Spawn-relevant env snapshot/restore. `PI_CREW_DEPTH` is scrubbed because the
 * worker harness exports it (`.crew/knowledge.md` 2026-08-15) and the
 * child-pi depth guard reads it.
 */
interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
	depth: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
		depth: process.env.PI_CREW_DEPTH,
	};
}

function setMockEnv(mode: string | undefined): void {
	delete process.env.PI_CREW_DEPTH;
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
	if (state.depth === undefined) delete process.env.PI_CREW_DEPTH;
	else process.env.PI_CREW_DEPTH = state.depth;
}

function makeFixture(opts: { workflow: WorkflowConfig; goal: string }) {
	const cwd = createTrackedTempDir("pi-crew-rr013-boundary-");
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	const created = createRunManifest({ cwd, team, workflow: opts.workflow, goal: opts.goal });
	return { cwd, created };
}

function runTask(result: { manifest: TeamRunManifest; tasks: TeamTaskState[] }, id: string): TeamTaskState {
	const t = result.tasks.find((x) => x.id === id);
	assert.ok(t, `task ${id} must exist in result`);
	return t;
}

function eventTypes(eventsPath: string): string[] {
	return readEvents(eventsPath).map((e) => e.type);
}

/** Drive the child-process branch of runTeamTask with one mock mode. */
async function runWithMock(mockMode: string, opts: { workflow?: WorkflowConfig; step?: WorkflowStep; goal: string }) {
	const stepDef = opts.step ?? step();
	const { cwd, created } = makeFixture({ workflow: opts.workflow ?? workflowOf([stepDef]), goal: opts.goal });
	const prev = saveMockEnv();
	setMockEnv(mockMode);
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: stepDef,
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		});
		return { cwd, created, result, task: runTask(result, created.tasks[0]!.id), events: eventTypes(created.manifest.eventsPath) };
	} finally {
		restoreMockEnv(prev);
	}
}

// ─── AC-1/AC-3/AC-4/AC-5: surfaceLost must survive the boundary ─────

test("[rr013-ac1] surfaceLost survives runTeamTask: degraded child → needs_attention (NOT completed), no result artifact", async () => {
	// RED before the fix: `task-runner.ts` copied 11 fields from `child.*` and
	// rebuilt the `execResult` literal without `surfaceLost`, so the finalizer
	// never saw it. With collectYieldEvents=false for child-process
	// (pre-execution.ts) and the bug-026 gate requiring `resultArtifact?.path`
	// (which the degrade path leaves undefined BY DESIGN), the chain
	// deterministically produced status "completed" + a `task.completed` event
	// for a worker that lost its pane and produced no result.
	const { cwd, task, events, result } = await runWithMock("surface-degraded", { goal: "rr013-surface-lost" });
	try {
		// AC-1 — the terminal state the degrade path was designed to produce.
		assert.equal(task.status, "needs_attention", `degraded surface must terminalise needs_attention, got: ${task.status}`);
		assert.equal(task.error, undefined, "a lost pane is not a task failure");
		assert.equal(task.exitCode, null, "degrade path leaves exitCode null");

		// AC-3 — no fabricated result artifact ("(no output)" must not appear).
		assert.equal(
			task.resultArtifact === undefined || task.resultArtifact === null,
			true,
			"degrade path must NOT fabricate a result artifact",
		);

		// AC-4 — the correct terminal event, and ONLY that one.
		assert.ok(events.includes("task.surface_lost"), `must emit task.surface_lost; got: ${events.join(",")}`);
		assert.ok(!events.includes("task.completed"), `AC-5: must NOT emit task.completed for a lost surface; got: ${events.join(",")}`);
		assert.ok(!events.includes("task.failed"), `a lost pane must not be reported as task.failed; got: ${events.join(",")}`);

		// diagnostics.surfaceLost — written only by the finalizer's degrade branch.
		const lost = (task.diagnostics as { surfaceLost?: { cause?: string; paneId?: string } } | undefined)?.surfaceLost;
		assert.equal(lost?.cause, "pane-closed", "diagnostics.surfaceLost.cause must come from the producer");
		assert.equal(lost?.paneId, "%9", "diagnostics.surfaceLost.paneId must come from the producer");

		// The returned manifest/tasks are the persisted state (no phantom completed).
		const persisted = result.tasks.find((t) => t.id === task.id);
		assert.equal(persisted?.status, "needs_attention");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── AC-2: rawFinalText must survive the boundary ──────────────────

test("[rr013-ac2] rawFinalText survives runTeamTask: footer found by the spec gate when finalText/finalStdout are empty", async () => {
	// The consumer of `rawFinalText` is the spec-evidence footer union
	// (post-execution.ts → computeSpecGate), so this asserts the CONSUMER EFFECT,
	// not the field's presence: a spec-bearing task whose ONLY text channel is
	// `rawFinalText` (compaction scenario — parsedOutput.finalText and
	// finalStdout both empty) must still have its footer parsed.
	//
	// RED before the fix: `rawFinalText` had 0 occurrences in task-runner.ts, so
	// the union saw nothing and the must-acceptance id surfaced as missing.
	const { cwd, created } = makeFixture({
		workflow: workflowOf([step({ specRefs: ["rr013-boundary-spec"] })]),
		goal: "rr013-raw-final-text",
	});
	const specRecord: SpecRecord = {
		id: "rr013-boundary-spec",
		version: 1,
		title: "RR-013 boundary spec",
		requirements: [{ id: "req-1", text: "the boundary must preserve the raw final text", priority: "must" }],
		acceptance: [{ id: "acc-1", requirementId: "req-1", check: "footer cites acc-1" }],
		source: { kind: "generated" },
	};
	saveSpecRecord(cwd, specRecord);
	const prev = saveMockEnv();
	setMockEnv("raw-final-text-only");
	try {
		const result = await runTeamTask({
			manifest: created.manifest,
			tasks: created.tasks,
			task: created.tasks[0]!,
			step: step({ specRefs: ["rr013-boundary-spec"] }),
			agent,
			executeWorkers: true,
			workspaceId: cwd,
		});
		const t = runTask(result, created.tasks[0]!.id);

		// Positive control: the mock run itself must be a normal, successful
		// child-process task (this test is NOT about terminal state).
		assert.equal(t.status, "completed", `positive control: mock run must complete, got: ${t.status}`);
		assert.ok(t.specGate, "a spec-bearing packet must produce a specGate");

		// AC-2 — the footer was parsed from rawFinalText.
		assert.equal(t.specGate!.footerPresent, true, "footer must be found via rawFinalText (finalText/finalStdout are empty here)");
		assert.deepEqual(t.specGate!.missingMustIds, [], "acc-1 must be cited — the footer union must have seen rawFinalText");
		assert.deepEqual(t.specGate!.citedIds, ["acc-1"]);
		assert.equal(t.specGate!.badge, undefined, "full coverage must pass without an `unverified` badge");
	} finally {
		restoreMockEnv(prev);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── AC-6/AC-7: the second-order consequence must also be gone ─────

test("[rr013-ac6] headless redeploy accepts the task runTeamTask produces (was skipped as phantom `completed`)", async () => {
	// SECOND-ORDER consequence of the same defect: `planHeadlessRedeplays`
	// (degrade.ts) only requeues `needs_attention` or `running` tasks and
	// deliberately refuses every other terminal state (its comment: "lifecycle
	// khác đã quyết — không giành quyền"). While the boundary dropped
	// `surfaceLost`, runTeamTask produced a PHANTOM `completed` task, so the
	// recovery mechanism DESIGNED to save this task actively refused it.
	//
	// This asserts the causal chain end-to-end: runTeamTask's real output is fed
	// into the real planner. It is NOT a re-test of the planner's guard — the
	// guard is frozen (correctly) by degrade.test.ts and must not be loosened.
	const { cwd, task } = await runWithMock("surface-degraded", { goal: "rr013-redeploy-chain" });
	try {
		const degraded = [{ taskId: task.id, paneId: "%9", cause: "pane-closed" as const, ts: new Date().toISOString() }];

		// AC-6 — the task is requeued (not skipped).
		const handled = new Set<string>();
		const plan = planHeadlessRedeplays({ tasks: [task], degraded, handledTaskIds: handled });
		assert.deepEqual(
			plan.requeuedTaskIds,
			[task.id],
			`surface-lost task must be requeued, not skipped; skipped=${JSON.stringify(plan.skipped)}`,
		);
		assert.deepEqual(plan.skipped, [], "a needs_attention task must produce no skip reason");
		assert.equal(plan.tasks[0]!.status, "queued", "requeue returns the unit to the queue");

		// AC-7 — idempotent: a second drain with the same handled set must not
		// double-dispatch (spec §7: requeue must not consume retry budget twice).
		const second = planHeadlessRedeplays({ tasks: plan.tasks, degraded, handledTaskIds: handled });
		assert.deepEqual(second.requeuedTaskIds, [], "must not re-dispatch the same unit twice");
		assert.equal(second.skipped[0]!.reason, "already re-dispatched once for surface loss");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── AC-9/AC-10: over-correction guards ────────────────────────────

test("[rr013-ac10a] over-correction guard: normal successful child-process task still completes", async () => {
	// The fix forwards a field that is only ever SET on the degrade path. A
	// normal child-process task must keep its existing meaning: `completed`,
	// with `task.completed` emitted and no `task.surface_lost`.
	const { cwd, task, events } = await runWithMock("json-success", { goal: "rr013-normal-success" });
	try {
		assert.equal(task.status, "completed", "normal success must stay completed");
		assert.ok(events.includes("task.completed"), "normal success must emit task.completed");
		assert.ok(!events.includes("task.surface_lost"), "normal success must NOT emit task.surface_lost");
		assert.equal(
			(task.diagnostics as { surfaceLost?: unknown } | undefined)?.surfaceLost,
			undefined,
			"normal success must NOT write diagnostics.surfaceLost",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("[rr013-ac10b] over-correction guard: normal failing child-process task still fails", async () => {
	// A real failure (retryable-failure mock → exit 1 + stderr) must remain
	// `failed` with `task.failed`, and must NOT be rerouted into the degrade
	// branch (that would be the reverse over-correction: turning every
	// non-completing child task into needs_attention).
	const { cwd, task, events } = await runWithMock("retryable-failure", { goal: "rr013-normal-failure" });
	try {
		assert.equal(task.status, "failed", `normal failure must stay failed, got: ${task.status}`);
		assert.ok(task.error, "normal failure must carry an error");
		assert.ok(events.includes("task.failed"), `must emit task.failed; got: ${events.join(",")}`);
		assert.ok(!events.includes("task.surface_lost"), "a model failure is NOT a surface loss");
		assert.ok(!events.includes("task.completed"), "a failed task must not emit task.completed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
