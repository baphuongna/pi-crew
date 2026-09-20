/**
 * shadow-task-dag-readiness.test.ts — RR-012 adjacent scheduler risk:
 * END-TO-END REACHABILITY VERDICT (AC-8) + the fail-closed guard (AC-9).
 *
 * Hypothesis under test (docs/archive/2026-09-17-pi-crew-review-verification.md
 * §6.1 — explicitly UNVERIFIED there): the delegate shadow record
 * (`gc-*`, agent "delegate", dependsOn [], NO stepId) is not a workflow task,
 * yet scheduler selectors can surface it as ready; if it is selected into a
 * batch, dispatch-batch's findStep() throws ResourceNotFound (unguarded at
 * the pre-warm call site AND the singleton dispatch unit).
 *
 * VERDICT (locked by the tests below): REACHABLE.
 *   (a) getReadyTasks (task-graph.ts DAG primitive) returns the shadow in
 *       wave 0 — its dependsOn is empty.
 *   (b) taskGraphSnapshot().ready INCLUDES a QUEUED shadow (status==="queued"
 *       + empty deps ⇒ queue "ready"). NOTE: this refines the §6.1 probe
 *       claim that taskGraphSnapshot excludes it — the exclusion only holds
 *       for a RUNNING shadow. The DAG selector (selectDispatchBatch) ignores
 *       status entirely, so a RUNNING shadow is surfaced there instead.
 *   (c) A REAL mergeUnitResult tick ingests the shadow into ctx.tasks
 *       (merge-loop rebuilds from disk.tasks under the run lock).
 *   (d) A REAL selectDispatchBatch tick selects the shadow into
 *       decision.batch — both while queued (snapshot path) and while running
 *       (DAG path; the shadow is never in ctx.pendingUnits so the in-flight
 *       filter never drops it).
 *   (e) dispatchBatch on a batch containing the shadow throws
 *       ResourceNotFound("Workflow step 'undefined' ...") — proven by driving
 *       the REAL dispatchBatch with a hand-built decision (selection itself
 *       is now guarded, so the throw test bypasses selection deliberately to
 *       pin the blast radius if the guard ever regresses).
 *
 * Guard (AC-9, design §3.2 option B — existing marker, no schema change):
 * selectDispatchBatch excludes delegate-broker shadow records
 * (isDelegateShadowTask) at the single selection point, BEFORE any
 * findStep()/findAgent() lookup. Shadow records stay visible in snapshots /
 * `team status` — only batch selection skips them.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type { CrewRuntimeKind } from "../../../../src/runtime/crew-agent-runtime.ts";
import { dispatchBatch } from "../../../../src/runtime/dispatch-batch.ts";
import { buildExecutionPlan, getReadyTasks as getDagReadyTasks, type TaskNode } from "../../../../src/runtime/scheduling/task-graph.ts";
import { buildTaskGraphIndex, taskGraphSnapshot } from "../../../../src/runtime/scheduling/task-graph-scheduler.ts";
import { __test__mergeUnitResult, __test__selectDispatchBatch } from "../../../../src/runtime/team-runner.ts";
import type { WorkflowStateMachine } from "../../../../src/runtime/workflow-state.ts";
import { createRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

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

function makeWorkflow(name = "implementation"): WorkflowConfig {
	return { name, description: "", source: "test", filePath: "builtin", steps: [] } as unknown as WorkflowConfig;
}

function makeInMemoryManifest(runId = "run_shadow"): TeamRunManifest {
	return {
		runId,
		team: "test-team",
		workflow: "implementation",
		cwd: "/tmp/pi-crew-shadow-nonexistent",
		stateRoot: "/tmp/pi-crew-shadow-nonexistent/.crew/state",
		artifactsRoot: "/tmp/pi-crew-shadow-nonexistent/.crew/artifacts",
		eventsPath: "/tmp/pi-crew-shadow-nonexistent/.crew/state/events.jsonl",
		status: "queued",
		goal: "shadow reachability",
		summary: "",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		artifacts: [],
		tasks: [],
	} as unknown as TeamRunManifest;
}

function makeRealTask(id: string, stepId: string, status: TeamTaskState["status"] = "queued", dependsOn: string[] = []): TeamTaskState {
	return {
		id,
		runId: "run_shadow",
		stepId,
		role: "executor",
		agent: "executor",
		title: id,
		status,
		dependsOn,
		cwd: "/tmp/pi-crew-shadow-nonexistent",
	} as unknown as TeamTaskState;
}

/** Shadow record mirroring the literal at crew-broker.ts (gc-*, agent "delegate"). */
function makeShadowTask(id = "gc-abc", status: TeamTaskState["status"] = "queued"): TeamTaskState {
	return {
		id,
		runId: "run_shadow",
		role: "explorer",
		agent: "delegate",
		title: `delegate: ${id}`,
		status,
		cwd: "/tmp/pi-crew-shadow-nonexistent",
		dependsOn: [],
		depth: 2,
		startedAt: new Date().toISOString(),
	} as unknown as TeamTaskState;
}

function makeDispatchCtx(tasks: TeamTaskState[], limits?: { maxConcurrentWorkers?: number }): SchedulerCtx {
	return {
		input: {
			team: { maxConcurrency: undefined } as SchedulerCtx["input"]["team"],
			limits,
		} as SchedulerCtx["input"],
		workflow: makeWorkflow(),
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

function makePendingUnit(
	taskIds: string[],
	result: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
	unitKey = "u1",
): PendingUnitLike {
	const wrapped = Promise.resolve({ unitKey, result, error: undefined });
	return { taskIds, promise: Promise.resolve(result), wrapped };
}

/** Real on-disk run fixture (for fs-touching targets). Caller rmSync's cwd. */
function makeRunFixture(prefix: string): { cwd: string; manifest: TeamRunManifest } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-shadow-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".git"));
	const team = {
		name: "test-team",
		description: "",
		roles: [{ name: "executor", agent: "executor" }],
		source: "test",
		filePath: "builtin",
	} as unknown as TeamConfig;
	const workflow = makeWorkflow("implementation");
	const created = createRunManifest({ cwd, team, workflow, goal: "shadow reachability" });
	return { cwd, manifest: created.manifest };
}

// ── (a)+(b): selector characterization — no src changes involved ──────────

test("AC-8(a): DAG primitive getReadyTasks returns the shadow as ready (wave 0)", () => {
	const tasks: TeamTaskState[] = [
		makeRealTask("01_explore", "explore"),
		makeRealTask("02_exec", "execute", "queued", ["explore"]),
		makeShadowTask("gc-abc"),
	];
	// dagReadyTaskIds mapping (dispatch-batch.ts:328): nodes carry task ids.
	const nodes: TaskNode[] = tasks.map((t) => ({
		id: t.id,
		dependsOn: t.dependsOn.map((dep) => dep), // step-id deps resolve via stepToTaskId; gc has none
		phase: t.stepId,
	}));
	const plan = buildExecutionPlan(nodes);
	assert.equal(plan.hasCycle, false);
	const ready = getDagReadyTasks(plan, new Set());
	// Characterization: wave 0 = [01_explore, gc-abc] — the shadow IS DAG-ready.
	assert.ok(ready.includes("gc-abc"), `getReadyTasks must surface the shadow (observed: ${JSON.stringify(ready)})`);
});

test("AC-8(b): taskGraphSnapshot — the graphless broker shadow is invisible to snapshot.ready; a graphed queued shadow would be ready", () => {
	// b1 — REAL broker record shape: the shadow literal at crew-broker.ts has NO
	// `graph` field, and withQueue() only updates `graph.queue` on records that
	// ALREADY have graph — so snapshot.ready ignores graphless records entirely.
	// THIS is why the §6.1 probe observed "taskGraphSnapshot excludes it": the
	// exclusion is the graph-field quirk, NOT a shadow-specific rule.
	const graphlessTasks = [makeRealTask("01_explore", "explore"), makeShadowTask("gc-abc", "queued")];
	const snapGraphless = taskGraphSnapshot(graphlessTasks);
	assert.deepEqual(snapGraphless.ready, [], "graphless records never surface in snapshot.ready (probe observation explained)");
	// b2 — had the record carried a graph (worker-path tasks do), a QUEUED
	// shadow with empty deps resolves to queue "ready": the status+deps logic
	// itself has no shadow exclusion.
	const withGraph = (t: TeamTaskState, queue: string): TeamTaskState => ({
		...t,
		graph: { taskId: t.id, children: [], dependencies: [], queue } as TeamTaskState["graph"],
	});
	const graphedTasks = [
		withGraph(makeRealTask("01_explore", "explore"), "ready"),
		withGraph(makeShadowTask("gc-abc", "queued"), "queued"),
		withGraph(makeShadowTask("gc-run", "running"), "running"),
	];
	const snapGraphed = taskGraphSnapshot(graphedTasks);
	assert.ok(snapGraphed.ready.includes("gc-abc"), "graphed queued shadow WOULD be snapshot-ready (no exclusion in the selector)");
	assert.ok(!snapGraphed.ready.includes("gc-run"), "running shadow excluded from snapshot.ready (status filter)");
	assert.ok(snapGraphed.running.includes("gc-run"), "running shadow reported in snapshot.running (visible in team status)");
});

// ── (c): real merge tick ingests the shadow into ctx.tasks ────────────────

test("AC-8(c): real mergeUnitResult rebuilds ctx.tasks from disk — the shadow record survives the merge", async () => {
	const { cwd, manifest } = makeRunFixture("merge");
	try {
		const realTask = makeRealTask("01_explore", "explore", "queued");
		realTask.cwd = cwd;
		realTask.runId = manifest.runId;
		const shadow = makeShadowTask("gc-merge", "queued");
		shadow.cwd = cwd;
		shadow.runId = manifest.runId;
		// disk.tasks contains the shadow (broker wrote it under the run lock).
		saveRunTasks(manifest, [realTask, shadow]);

		const workerTasks: TeamTaskState[] = [{ ...realTask, status: "completed", finishedAt: new Date().toISOString() }];
		const ctx = makeDispatchCtx([realTask, shadow], { maxConcurrentWorkers: 2 });
		ctx.manifest = manifest;
		ctx.tasks = [realTask, shadow];
		ctx.pendingUnits = new Map<string, PendingUnitLike>([["u1", makePendingUnit(["01_explore"], { manifest, tasks: workerTasks })]]);

		const decision = await __test__mergeUnitResult(ctx);
		assert.equal(decision, null, "merge path returns null (continue)");
		const mergedShadow = ctx.tasks.find((t) => t.id === "gc-merge");
		assert.ok(mergedShadow, "shadow record must survive the merge into ctx.tasks");
		assert.equal(mergedShadow!.status, "queued", "merge does not touch the shadow status");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── (d): real scheduler tick batch selection — THE GUARD (RED→GREEN) ──────

test("AC-8(d)+AC-9: real selectDispatchBatch tick NEVER selects a shadow record — queued OR running", async () => {
	// Queued shadow (snapshot path would surface it).
	{
		const tasks = [
			makeRealTask("01_explore", "explore"),
			makeRealTask("02_exec", "execute", "queued", ["explore"]),
			makeShadowTask("gc-q", "queued"),
		];
		const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 8 });
		const decision = await __test__selectDispatchBatch(ctx);
		assert.equal(decision.kind, "dispatch");
		if (decision.kind === "dispatch") {
			// RED pre-guard: batch contained gc-q (snapshot.ready path).
			assert.ok(
				!decision.batch.some((t) => t.id === "gc-q"),
				`queued shadow must NOT be selected into the batch (observed: ${decision.batch.map((t) => t.id).join(",")})`,
			);
			assert.ok(
				decision.batch.some((t) => t.id === "01_explore"),
				"real ready tasks still selected",
			);
		}
	}
	// Running shadow (DAG path — getDagReadyTasks ignores status AND graph; the
	// shadow is never in ctx.pendingUnits so the in-flight filter cannot drop
	// it). A 2nd real wave-0 task keeps the batch non-empty so we also verify
	// the shadow neither gets selected NOR gates wave-1 progress.
	{
		const tasks = [
			makeRealTask("01_explore", "explore", "completed"),
			makeRealTask("01b_ready", "explore2"),
			makeRealTask("02_exec", "execute", "queued", ["explore"]),
			makeShadowTask("gc-r", "running"),
		];
		const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 8 });
		const decision = await __test__selectDispatchBatch(ctx);
		assert.equal(decision.kind, "dispatch");
		if (decision.kind === "dispatch") {
			assert.ok(
				!decision.batch.some((t) => t.id === "gc-r"),
				`running shadow must NOT be selected into the batch (observed: ${decision.batch.map((t) => t.id).join(",")})`,
			);
			assert.ok(
				decision.batch.some((t) => t.id === "01b_ready"),
				"wave-0 real task still selected",
			);
		}
	}
});

// ── (e): the blast radius if selection ever leaks — REAL dispatchBatch ────

test("AC-8(e): dispatchBatch on a leaked shadow throws ResourceNotFound (blast radius pinned; guard upstream is the fix)", async () => {
	const { cwd, manifest } = makeRunFixture("blast");
	try {
		const realTask = makeRealTask("01_explore", "explore", "queued");
		realTask.cwd = cwd;
		realTask.runId = manifest.runId;
		const shadow = makeShadowTask("gc-blast", "queued");
		shadow.cwd = cwd;
		shadow.runId = manifest.runId;
		saveRunTasks(manifest, [realTask, shadow]);

		const ctx = makeDispatchCtx([realTask, shadow], { maxConcurrentWorkers: 2 });
		ctx.manifest = manifest; // real eventsPath so the buffered progress event lands
		ctx.tasks = [realTask, shadow];
		// Hand-built decision: the shadow IS in the batch (this test
		// deliberately bypasses the now-guarded selection to pin what happens
		// if the guard ever regresses — findStep() on task.stepId===undefined).
		const decision = {
			kind: "dispatch" as const,
			batch: [shadow],
			concurrency: { maxConcurrent: 2, selectedCount: 2, defaultConcurrency: 2, reason: "test" },
			snapshot: taskGraphSnapshot([realTask, shadow]),
			approvalPending: false,
			coalesceEnabled: false,
		};
		await dispatchBatch(ctx, decision);
		const unit = ctx.pendingUnits.get("gc-blast");
		assert.ok(unit, "singleton dispatch unit must be registered for the shadow");
		const settled = await unit.wrapped;
		assert.ok(settled.error, "findStep on the shadow must throw (no stepId ⇒ no workflow step match)");
		assert.match(settled.error!.message, /Workflow step 'undefined' not found for task 'gc-blast'/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── BR-09: the discriminator must not eat REAL `delegate`-agent tasks ────

test("BR-09: a REAL workflow task whose agent is literally `delegate` (WITH a stepId) is still dispatched", async () => {
	// Pre-fix (agent-name discriminator) 02_del was filtered out of the batch ⇒
	// never dispatched ⇒ finalize-run marks the run `blocked`.
	//
	// 02_del is placed in the SAME wave as 01_alpha (no deps) so it is genuinely
	// reachable this tick — getReadyTasks() only surfaces the earliest wave with
	// unfinished tasks, so a dep would have parked it behind 01_alpha and made the
	// assertion vacuous. The shadow's explicit dep keeps the tick on the DAG path
	// (dagReadyTaskIds) — the path that ALSO filters `isDelegateShadowTask` nodes.
	const tasks: TeamTaskState[] = [
		makeRealTask("00_done", "assess", "completed"),
		makeRealTask("01_alpha", "explore"),
		{ ...makeRealTask("02_del", "deliver"), agent: "delegate" },
		// A genuine shadow in the same tick (gc-* id, NO stepId) must still stay
		// out of the batch.
		{ ...makeShadowTask("gc-br09", "queued"), dependsOn: ["deliver"] },
	];
	const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 8 });
	const decision = await __test__selectDispatchBatch(ctx);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind === "dispatch") {
		const ids = decision.batch.map((t) => t.id);
		const delegated = decision.batch.find((t) => t.id === "02_del");
		assert.ok(delegated, `delegate-NAMED workflow task must be selected (observed: ${ids.join(",")})`);
		assert.equal(delegated!.agent, "delegate", "the selected task really carries agent `delegate`");
		assert.equal(delegated!.stepId, "deliver", "it is a workflow task (has a stepId)");
		assert.ok(ids.includes("01_alpha"), "ordinary ready task still selected");
		assert.ok(!ids.includes("gc-br09"), `shadow (no stepId) must stay out of the batch (observed: ${ids.join(",")})`);
	}
});

// ── regression: the guard must not change selection of ordinary tasks ─────

test("AC-9 regression: ordinary multi-wave selection is unchanged by the shadow guard", async () => {
	const tasks = [
		makeRealTask("01_explore", "explore"),
		makeRealTask("02_exec", "execute", "queued", ["explore"]),
		makeRealTask("03_verify", "verify", "queued", ["execute"]),
	];
	const ctx = makeDispatchCtx(tasks, { maxConcurrentWorkers: 2 });
	const decision = await __test__selectDispatchBatch(ctx);
	assert.equal(decision.kind, "dispatch");
	if (decision.kind === "dispatch") {
		assert.deepEqual(
			decision.batch.map((t) => t.id),
			["01_explore"],
			"wave-0 real task selected, wave-1+ blocked",
		);
	}
});
