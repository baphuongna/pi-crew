/**
 * 1.9(b) — characterization tests for Phase 2.6 team-runner extraction targets.
 *
 * PURPOSE: Pin CURRENT behavior of the five module-private extraction targets
 * (requiresPlanApproval / ensurePlanApprovalRequested / selectDispatchBatch /
 * mergeUnitResult / advanceWorkflowPhases) plus the already-exported
 * mergeArtifacts helper, BEFORE the CORE-4 refactor moves them into
 * scheduler/ modules. These are characterization tests — NO behavior change.
 * After the extraction, these same tests must still pass; any failure
 * indicates a behavioral regression.
 *
 * Targets (verified at branch refactor/maintainability):
 *   requiresPlanApproval          src/runtime/team-runner.ts:662
 *   ensurePlanApprovalRequested   src/runtime/team-runner.ts:677
 *   selectDispatchBatch           src/runtime/team-runner.ts:1363
 *   mergeUnitResult               src/runtime/team-runner.ts:1925
 *   advanceWorkflowPhases         src/runtime/team-runner.ts:2004
 *   mergeArtifacts                src/runtime/team-runner-artifacts.ts:9 (already exported)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { CrewRuntimeConfig } from "../../../src/config/config.ts";
import type { CrewRuntimeKind } from "../../../src/runtime/crew-agent-runtime.ts";
import { __test_resetCap } from "../../../src/runtime/scheduling/global-worker-cap.ts";
import { buildTaskGraphIndex } from "../../../src/runtime/scheduling/task-graph-scheduler.ts";
import {
	__test__advanceWorkflowPhases,
	__test__ensurePlanApprovalRequested,
	__test__mergeUnitResult,
	__test__requiresPlanApproval,
	__test__selectDispatchBatch,
} from "../../../src/runtime/team-runner.ts";
import { mergeArtifacts } from "../../../src/runtime/team-runner-artifacts.ts";
import type { WorkflowStateMachine } from "../../../src/runtime/workflow-state.ts";
import { readEvents } from "../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

// ─── Types ────────────────────────────────────────────────────────

/** SchedulerContext is module-private; derive its shape from the test seam. */
type SchedulerCtx = Parameters<typeof __test__selectDispatchBatch>[0];

type PendingUnitLike = {
	taskIds: string[];
	promise: Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }>;
	wrapped: Promise<{
		unitKey: string;
		result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
		error: Error | undefined;
	}>;
};

// ─── Helpers ──────────────────────────────────────────────────────

/** Minimal workflow config (fields read by the extraction targets). */
function makeWorkflow(name = "implementation"): WorkflowConfig {
	return {
		name,
		description: "",
		source: "test",
		filePath: "builtin",
		steps: [],
	} as unknown as WorkflowConfig;
}

/** Minimal in-memory manifest — ONLY safe for pure read paths (no fs). */
function makeInMemoryManifest(runId = "run_extraction"): TeamRunManifest {
	return {
		runId,
		team: "test-team",
		workflow: "implementation",
		cwd: "/tmp/pi-crew-extraction",
		stateRoot: "/tmp/pi-crew-extraction/.crew/state",
		artifactsRoot: "/tmp/pi-crew-extraction/.crew/artifacts",
		eventsPath: "/tmp/pi-crew-extraction/.crew/state/events.jsonl",
		status: "queued",
		goal: "extraction characterization",
		summary: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
		tasks: [],
	} as unknown as TeamRunManifest;
}

/** Build a TeamTaskState with the fields the extraction targets read. */
function makeTask(
	id: string,
	stepId: string,
	role: string,
	status: TeamTaskState["status"] = "queued",
	overrides: Partial<TeamTaskState> = {},
): TeamTaskState {
	return {
		id,
		runId: "run_extraction",
		stepId,
		role,
		agent: role,
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/pi-crew-extraction",
		graph: {
			taskId: id,
			children: [],
			dependencies: [],
			queue: status === "queued" ? "ready" : status === "running" ? "running" : "done",
		},
		...overrides,
	} as unknown as TeamTaskState;
}

/** Fake in-flight dispatch unit with an already-settled wrapped promise. */
function makePendingUnit(
	taskIds: string[],
	result: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	unitKey = "u1",
): PendingUnitLike {
	const wrapped = Promise.resolve({ unitKey, result, error: undefined });
	return {
		taskIds,
		promise: Promise.resolve(result),
		wrapped,
	};
}

/** Real on-disk run fixture (for fs-touching targets). Caller rmSync's cwd. */
function makeRunFixture(prefix: string): { cwd: string; manifest: TeamRunManifest } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-extr-${prefix}-`));
	const team = {
		name: "test-team",
		description: "",
		roles: [{ name: "executor", agent: "executor" }],
		source: "test",
		filePath: "builtin",
	} as unknown as TeamConfig;
	const workflow = makeWorkflow("implementation");
	const created = createRunManifest({ cwd, team, workflow, goal: "extraction characterization" });
	return { cwd, manifest: created.manifest };
}

/** Build a minimal SchedulerContext (pure dispatch path — no fs needed). */
function makeDispatchCtx(tasks: TeamTaskState[], limits?: { maxConcurrentWorkers?: number }): SchedulerCtx {
	return {
		input: {
			team: { maxConcurrency: undefined } as SchedulerCtx["input"]["team"],
			limits,
		} as SchedulerCtx["input"],
		workflow: makeWorkflow("implementation"),
		manifest: makeInMemoryManifest(),
		tasks,
		queueIndex: buildTaskGraphIndex(tasks),
		wfMachine: { phases: [], currentPhaseIndex: 0 } as WorkflowStateMachine,
		pendingUnits: new Map<string, PendingUnitLike>(),
		dispatchedTaskIds: new Set<string>(),
		runController: new AbortController(),
		runtimeKind: "child-process" as CrewRuntimeKind,
		adaptivePlanInjected: false,
		adaptivePlanMissing: false,
		settledMerge: null,
	} as unknown as SchedulerCtx;
}

// ─── requiresPlanApproval (:662) — workflow × runtimeConfig matrix ────

test("1.9b requiresPlanApproval: undefined runtimeConfig → false (any workflow)", () => {
	assert.equal(__test__requiresPlanApproval(makeWorkflow("implementation"), undefined), false);
	assert.equal(__test__requiresPlanApproval(makeWorkflow("review"), undefined), false);
});

test("1.9b requiresPlanApproval: requirePlanApproval===true → true for ANY workflow", () => {
	// ROADMAP T1.2: plan-level HITL applies to any workflow when the config flag is set.
	assert.equal(__test__requiresPlanApproval(makeWorkflow("implementation"), { requirePlanApproval: true } as CrewRuntimeConfig), true);
	assert.equal(__test__requiresPlanApproval(makeWorkflow("review"), { requirePlanApproval: true } as CrewRuntimeConfig), true);
});

test("1.9b requiresPlanApproval: requirePlanApproval===false → false", () => {
	assert.equal(__test__requiresPlanApproval(makeWorkflow("implementation"), { requirePlanApproval: false } as CrewRuntimeConfig), false);
});

test("1.9b requiresPlanApproval: runtimeConfig present but flag absent → false", () => {
	assert.equal(__test__requiresPlanApproval(makeWorkflow("implementation"), { mode: "child-process" } as CrewRuntimeConfig), false);
});

// ─── ensurePlanApprovalRequested (:677) — manifest mutation ────────

test("1.9b ensurePlanApprovalRequested: already-present planApproval short-circuits (same object)", async () => {
	const { cwd, manifest } = makeRunFixture("plan-shortcircuit");
	try {
		const withApproval: TeamRunManifest = {
			...manifest,
			planApproval: {
				required: true,
				status: "approved",
				requestedAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		};
		const out = await __test__ensurePlanApprovalRequested(withApproval, [makeTask("a", "assess", "planner", "completed")]);
		assert.equal(out, withApproval, "must return the SAME object when planApproval already exists");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b ensurePlanApprovalRequested: completed assess task wins as planTaskId", async () => {
	const { cwd, manifest } = makeRunFixture("plan-assess");
	try {
		const assess = makeTask("02_assess", "assess", "planner", "completed", {
			resultArtifact: { path: "plan.md" },
		} as Partial<TeamTaskState>);
		const executor = makeTask("03_execute", "execute", "executor", "completed");
		const out = await __test__ensurePlanApprovalRequested(manifest, [assess, executor]);
		assert.equal(out.planApproval?.required, true);
		assert.equal(out.planApproval?.status, "pending");
		assert.equal(out.planApproval?.planTaskId, "02_assess");
		assert.equal(out.planApproval?.planArtifactPath, "plan.md");
		// event appended
		const events = readEvents(manifest.eventsPath);
		assert.ok(
			events.some((e) => e.type === "plan.approval_required"),
			"plan.approval_required event must be appended",
		);
		// persisted to disk
		const reloaded = loadRunManifestById(cwd, manifest.runId);
		assert.equal(reloaded?.manifest.planApproval?.required, true);
		assert.equal(reloaded?.manifest.planApproval?.planTaskId, "02_assess");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b ensurePlanApprovalRequested: falls back to most recent completed read-only task when no assess task", async () => {
	const { cwd, manifest } = makeRunFixture("plan-fallback");
	try {
		const executor = makeTask("01_execute", "execute", "executor", "completed");
		const planner = makeTask("02_plan", "plan", "planner", "completed");
		const out = await __test__ensurePlanApprovalRequested(manifest, [executor, planner]);
		// reversed scan → planner is the first completed read-only task
		assert.equal(out.planApproval?.planTaskId, "02_plan");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b ensurePlanApprovalRequested: no completed read-only task → planTaskId undefined", async () => {
	const { cwd, manifest } = makeRunFixture("plan-none");
	try {
		const executor = makeTask("01_execute", "execute", "executor", "completed");
		const out = await __test__ensurePlanApprovalRequested(manifest, [executor]);
		assert.equal(out.planApproval?.required, true);
		assert.equal(out.planApproval?.status, "pending");
		assert.equal(out.planApproval?.planTaskId, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── selectDispatchBatch (:1363) — batch boundary / slots / approval ──

test("1.9b selectDispatchBatch: max-batch boundary — cap 2 dispatches exactly 2 of 4 ready", async () => {
	__test_resetCap(16);
	const tasks = [
		makeTask("t1", "step-1", "executor"),
		makeTask("t2", "step-2", "executor"),
		makeTask("t3", "step-3", "executor"),
		makeTask("t4", "step-4", "executor"),
	];
	const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 2 });
	const decision = await __test__selectDispatchBatch(ctx);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind !== "dispatch") return;
	assert.equal(decision.batch.length, 2, "batch must be capped at maxConcurrent");
	assert.deepEqual(
		decision.batch.map((t) => t.id),
		["t1", "t2"],
		"first ready tasks win, declaration order",
	);
	assert.equal(decision.concurrency.maxConcurrent, 2);
	assert.equal(decision.snapshot.ready.length, 4, "snapshot still reports all ready tasks");
	assert.equal(decision.approvalPending, false);
});

test("1.9b selectDispatchBatch: slot release/backpressure — in-flight unit frees a slot on settle", async () => {
	__test_resetCap(16);
	const tasks = [
		makeTask("t1", "step-1", "executor"),
		makeTask("t2", "step-2", "executor"),
		makeTask("t3", "step-3", "executor"),
		makeTask("t4", "step-4", "executor"),
	];
	const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 2 });
	// one in-flight unit holds a concurrency slot (OPT-01 streaming dispatch)
	ctx.pendingUnits.set("u1", makePendingUnit(["t1"], { manifest: ctx.manifest, tasks }));
	const decision1 = await __test__selectDispatchBatch(ctx);
	assert.equal(decision1.kind, "dispatch");
	if (decision1.kind !== "dispatch") return;
	// slotsAvailable = 2 - 1 = 1 → only ONE new dispatch, and t1 (in-flight) is excluded
	assert.equal(decision1.batch.length, 1, "backpressure: 1 in-flight unit leaves 1 slot");
	assert.equal(decision1.batch[0]?.id, "t2", "in-flight t1 must not be re-dispatched");
	// unit settles → slot released → back to full dispatch capacity
	ctx.pendingUnits.delete("u1");
	const decision2 = await __test__selectDispatchBatch(ctx);
	assert.equal(decision2.kind, "dispatch");
	if (decision2.kind !== "dispatch") return;
	assert.equal(decision2.batch.length, 2, "slot released after unit settles");
	assert.deepEqual(
		decision2.batch.map((t) => t.id),
		["t1", "t2"],
	);
});

test("1.9b selectDispatchBatch: approval pending filters out mutating tasks from the batch", async () => {
	__test_resetCap(16);
	const tasks = [makeTask("t1", "plan", "planner"), makeTask("t2", "execute", "executor")];
	const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 4 });
	ctx.manifest = {
		...ctx.manifest,
		planApproval: { required: true, status: "pending", requestedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
	};
	const decision = await __test__selectDispatchBatch(ctx);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind !== "dispatch") return;
	assert.equal(decision.approvalPending, true);
	// read-only planner task dispatches; mutating executor task is held back
	assert.deepEqual(
		decision.batch.map((t) => t.id),
		["t1"],
	);
});

// ─── mergeUnitResult (:1925) — merge policy + race ─────────────────

test("1.9b mergeUnitResult: merges settled unit under run lock (policy + artifact merge)", async () => {
	const { cwd, manifest } = makeRunFixture("merge-policy");
	try {
		const baseTasks = [makeTask("a", "step-1", "executor", "queued"), makeTask("b", "step-2", "executor", "queued")];
		saveRunTasks(manifest, baseTasks);

		const workerManifest: TeamRunManifest = {
			...manifest,
			artifacts: [{ path: "artifacts/report.md", kind: "result", producer: "executor", createdAt: new Date().toISOString() }],
		} as unknown as TeamRunManifest;
		const workerTasks = [
			makeTask("a", "step-1", "executor", "completed", { finishedAt: "2026-01-01T00:00:01.000Z" }),
			makeTask("b", "step-2", "executor", "running", { startedAt: "2026-01-01T00:00:00.000Z" }),
		];
		const ctx = makeDispatchCtx(baseTasks, { maxConcurrentWorkers: 2 });
		ctx.manifest = manifest;
		ctx.tasks = baseTasks;
		ctx.pendingUnits = new Map<string, PendingUnitLike>([
			["u1", makePendingUnit(["a", "b"], { manifest: workerManifest, tasks: workerTasks })],
		]);

		const decision = await __test__mergeUnitResult(ctx);
		assert.equal(decision, null, "merge path returns null (continue)");
		assert.equal(ctx.pendingUnits.size, 0, "settled unit is removed from pendingUnits");
		assert.equal(ctx.tasks.find((t) => t.id === "a")?.status, "completed");
		assert.equal(ctx.tasks.find((t) => t.id === "b")?.status, "running");
		assert.ok(
			ctx.manifest.artifacts.some((a) => a.path.endsWith("report.md")),
			"worker artifact merged into manifest",
		);
		assert.equal(ctx.manifest.status, "running", "status recomputed via updateRunStatus");
		assert.deepEqual(ctx.settledMerge?.taskIds, ["a", "b"]);
		// persisted
		const reloaded = loadRunManifestById(cwd, manifest.runId);
		assert.equal(reloaded?.manifest.status, "running");
		assert.ok(reloaded?.manifest.artifacts.some((a) => a.path.endsWith("report.md")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b mergeUnitResult: external cancel on disk survives the merge (CANCEL-1 race)", async () => {
	const { cwd, manifest } = makeRunFixture("merge-race");
	try {
		// disk state: an external cancel already terminalised the task
		const diskTasks = [makeTask("a", "step-1", "executor", "cancelled", { finishedAt: "2026-01-01T00:00:00.000Z" })];
		saveRunTasks(manifest, diskTasks);

		// worker result: stale 'completed' arriving AFTER the cancel (newer timestamp)
		const workerTasks = [makeTask("a", "step-1", "executor", "completed", { finishedAt: "2026-01-01T00:00:05.000Z" })];
		const ctx = makeDispatchCtx(diskTasks, { maxConcurrentWorkers: 2 });
		ctx.manifest = manifest;
		ctx.tasks = diskTasks;
		ctx.pendingUnits = new Map<string, PendingUnitLike>([["u1", makePendingUnit(["a"], { manifest, tasks: workerTasks })]]);

		await __test__mergeUnitResult(ctx);
		// CANCEL-1: merge base is disk.tasks (freshest committed state), so the
		// stale completed result must NOT resurrect the cancelled task.
		assert.equal(ctx.tasks.find((t) => t.id === "a")?.status, "cancelled");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── advanceWorkflowPhases (:2004) — phase-transition table ────────

test("1.9b advanceWorkflowPhases: phase-transition table (completed → failed → non-terminal blocks)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-extr-phases-"));
	try {
		const manifest = {
			...makeInMemoryManifest("run_phases"),
			eventsPath: path.join(cwd, "events.jsonl"),
			stateRoot: path.join(cwd, ".crew", "state"),
		};
		const tasks = [
			makeTask("01_assess", "assess", "planner", "completed", { finishedAt: "2026-01-01T00:00:01.000Z" }),
			makeTask("02_execute", "execute", "executor", "failed", { finishedAt: "2026-01-01T00:00:02.000Z", error: "boom" }),
			makeTask("03_verify", "verify", "verifier", "queued"),
		];
		const wfMachine: WorkflowStateMachine = {
			currentPhaseIndex: 0,
			phases: [
				{ name: "assess", status: "pending", inputs: [], outputs: ["plan.md"] },
				{ name: "execute", status: "pending", inputs: [], outputs: ["result.md"] },
				{ name: "verify", status: "pending", inputs: [], outputs: ["report.md"] },
			],
		};
		const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 4 });
		ctx.manifest = manifest;
		ctx.wfMachine = wfMachine;

		await __test__advanceWorkflowPhases(ctx);

		assert.equal(ctx.wfMachine.phases[0]?.status, "completed", "all-terminal phase with no failure → completed");
		assert.equal(ctx.wfMachine.phases[1]?.status, "failed", "phase with failed/cancelled task → failed");
		assert.equal(ctx.wfMachine.phases[2]?.status, "pending", "non-terminal tasks block the phase");
		assert.equal(ctx.wfMachine.currentPhaseIndex, 2, "index advances past completed/failed phases only");
		const events = readEvents(manifest.eventsPath);
		// NOTE: the emitted event payload carries phaseIndex/phaseStatus in `data`;
		// the phase NAME is only in the message (characterization of current shape).
		assert.ok(
			events.some((e) => e.type === "workflow.phase_completed" && e.message?.includes("assess")),
			"phase_completed event for assess",
		);
		assert.ok(
			events.some((e) => e.type === "workflow.phase_failed" && e.message?.includes("execute")),
			"phase_failed event for execute",
		);
		assert.ok(
			!events.some((e) => e.type === "workflow.phase_completed" && e.message?.includes("verify")),
			"verify phase must not complete",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b advanceWorkflowPhases: non-terminal first phase → no transition at all", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-extr-phases-blocked-"));
	try {
		const manifest = {
			...makeInMemoryManifest("run_phases_blocked"),
			eventsPath: path.join(cwd, "events.jsonl"),
			stateRoot: path.join(cwd, ".crew", "state"),
		};
		const tasks = [makeTask("01_assess", "assess", "planner", "queued")];
		const wfMachine: WorkflowStateMachine = {
			currentPhaseIndex: 0,
			phases: [{ name: "assess", status: "pending", inputs: [], outputs: ["plan.md"] }],
		};
		const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 4 });
		ctx.manifest = manifest;
		ctx.wfMachine = wfMachine;

		await __test__advanceWorkflowPhases(ctx);

		assert.equal(ctx.wfMachine.phases[0]?.status, "pending");
		assert.equal(ctx.wfMachine.currentPhaseIndex, 0);
		const events = readEvents(manifest.eventsPath);
		assert.equal(
			events.filter((e) => e.type.startsWith("workflow.phase_")).length,
			0,
			"no phase events when the first phase is not terminal",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b advanceWorkflowPhases: guard-blocked phase → phase_guard_blocked + index unchanged", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-extr-phases-guard-"));
	try {
		const manifest = {
			...makeInMemoryManifest("run_phases_guard"),
			eventsPath: path.join(cwd, "events.jsonl"),
			stateRoot: path.join(cwd, ".crew", "state"),
		};
		const tasks = [makeTask("01_execute", "execute", "executor", "completed", { finishedAt: "2026-01-01T00:00:01.000Z" })];
		// phase declares an input artifact that no completed task produced
		const wfMachine: WorkflowStateMachine = {
			currentPhaseIndex: 0,
			phases: [{ name: "execute", status: "pending", inputs: ["plan.md"], outputs: ["result.md"] }],
		};
		const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 4 });
		ctx.manifest = manifest;
		ctx.wfMachine = wfMachine;

		await __test__advanceWorkflowPhases(ctx);

		assert.equal(ctx.wfMachine.phases[0]?.status, "pending", "guard failure leaves the phase unchanged");
		assert.equal(ctx.wfMachine.currentPhaseIndex, 0, "guard failure does not advance the machine");
		const events = readEvents(manifest.eventsPath);
		assert.ok(
			events.some((e) => e.type === "workflow.phase_guard_blocked"),
			"guard-blocked event must be emitted",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("1.9b advanceWorkflowPhases: phases with no matching tasks are skipped (no transition, no advance)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-extr-phases-skip-"));
	try {
		const manifest = {
			...makeInMemoryManifest("run_phases_skip"),
			eventsPath: path.join(cwd, "events.jsonl"),
			stateRoot: path.join(cwd, ".crew", "state"),
		};
		const tasks: TeamTaskState[] = [];
		const wfMachine: WorkflowStateMachine = {
			currentPhaseIndex: 0,
			phases: [
				{ name: "assess", status: "pending", inputs: [], outputs: ["plan.md"] },
				{ name: "execute", status: "pending", inputs: [], outputs: ["result.md"] },
			],
		};
		const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 4 });
		ctx.manifest = manifest;
		ctx.wfMachine = wfMachine;

		await __test__advanceWorkflowPhases(ctx);

		assert.equal(ctx.wfMachine.phases[0]?.status, "pending");
		assert.equal(ctx.wfMachine.phases[1]?.status, "pending");
		assert.equal(ctx.wfMachine.currentPhaseIndex, 0, "phaseTaskIds empty → continue, never advances");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── mergeArtifacts (team-runner-artifacts.ts:9) — dedupe by path ──

test("1.9b mergeArtifacts: dedupes by path, later occurrences win", () => {
	const base = {
		path: "artifacts/report.md",
		kind: "result",
		producer: "executor",
		createdAt: "2026-01-01T00:00:00.000Z",
	} as const;
	const merged = mergeArtifacts([
		base as never,
		{ ...base, path: "artifacts/other.md" } as never,
		{ ...base, path: "artifacts/report.md", producer: "verifier" } as never,
	]);
	assert.equal(merged.length, 2, "duplicate path collapses to one entry");
	const report = merged.find((a) => a.path === "artifacts/report.md");
	assert.equal(report?.producer, "verifier", "later occurrence wins for the same path");
});

test("1.9b mergeArtifacts: preserves order of first occurrence per path", () => {
	const merged = mergeArtifacts([
		{ path: "a.md", kind: "result", producer: "p1", createdAt: "2026-01-01T00:00:00.000Z" } as never,
		{ path: "b.md", kind: "result", producer: "p2", createdAt: "2026-01-01T00:00:00.000Z" } as never,
		{ path: "a.md", kind: "result", producer: "p3", createdAt: "2026-01-01T00:00:00.000Z" } as never,
	]);
	assert.deepEqual(
		merged.map((a) => a.path),
		["a.md", "b.md"],
		"first-occurrence order is stable (Map insertion order)",
	);
	assert.equal(merged[0]?.producer, "p3", "value replaced by later occurrence");
});
