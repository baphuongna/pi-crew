/**
 * Scheduler context types for the team-run scheduler loop.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * CORE-4 scheduler context, resolves RT-15). Pure type motion: SettledUnit /
 * PendingUnit / SchedulerContext / SchedulerDecision moved verbatim.
 */

import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";
import type { BatchConcurrencyDecision } from "./scheduling/concurrency.ts";
import type { TaskGraphIndex, TaskGraphSchedulerSnapshot } from "./scheduling/task-graph-scheduler.ts";
import type { ResultArtifactReadCache } from "./task-output-context.ts";
// ExecuteTeamRunInput is defined in team-runner.ts — import type ONLY so the
// type-level team-runner↔scheduler-context reference is erased at runtime
// (no runtime import cycle; team-runner.ts imports these types back).
import type { ExecuteTeamRunInput } from "./team-runner.ts";
import type { WorkflowStateMachine } from "./workflow-state.ts";

/** RT-12: result shape from a settled dispatch unit (pre-created wrapper). */
export type SettledUnit = {
	unitKey: string;
	result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
	error: Error | undefined;
};

/**
 * RT-12: in-flight dispatch unit. `wrapped` is a pre-created wrapper promise
 * (try/catch → SettledUnit) so mergeUnitResult can Promise.race without
 * allocating new async closures every loop iteration (O(C) total wrappers
 * instead of O(C×T) churn).
 */
export type PendingUnit = {
	taskIds: string[];
	promise: Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }>;
	wrapped: Promise<SettledUnit>;
};

// ── CORE-4: SchedulerContext state bag ─────────────────────────────
// A mutable bag of the closure locals used across executeTeamRunCore.
// Extracted scheduler functions receive this context and mutate it
// in-place. This enables incremental extraction of the ~1075-line god
// function into scheduler/ functions without changing control flow.

/**
 * Mutable state shared across the team-run scheduler loop.
 *
 * Fields mirror the closure locals of `executeTeamRunCore`. Extracted
 * scheduler functions mutate these fields in-place; the caller keeps the
 * local variables in sync by assigning back from `ctx` after each call.
 */
export interface SchedulerContext {
	input: ExecuteTeamRunInput;
	workflow: WorkflowConfig;
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	queueIndex: TaskGraphIndex;
	wfMachine: WorkflowStateMachine;
	pendingUnits: Map<string, PendingUnit>;
	/** Task ids ever dispatched (grows monotonically; never removed). Used by
	 * terminaliseRunWithDrain to cancel — not skip — tasks that were in-flight
	 * even after their dispatch unit settled + left pendingUnits (RT-NEW-2 race). */
	dispatchedTaskIds: Set<string>;
	runController: AbortController;
	runtimeKind: CrewRuntimeKind;
	adaptivePlanInjected: boolean;
	adaptivePlanMissing: boolean;
	/** Outcome of the most recent mergeUnitResult call: the settled unit's
	 * taskIds and the merged result object. Read by the post-merge inline
	 * logic (cancel-during-exec check + batch summary). Set by extraction 5. */
	settledMerge: { taskIds: string[]; result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } } | null;
	/** R10-1: per-run result-artifact read cache (single instance, created in
	 *  executeTeamRunCore). Shared by closeout aggregation and — via baseInput
	 *  in dispatch-batch.ts — dependency-context reads in prepareTaskExecutionContext. */
	resultReadCache: ResultArtifactReadCache;
}

/**
 * Discriminated union representing a scheduler sub-function's decision.
 *
 * - `continue`: proceed to the next phase of the loop body.
 * - `return`: short-circuit the loop and return the given result.
 * - `skip-dispatch`: skip the dispatch phase this iteration (reserved for
 *   future extractions).
 */
export type SchedulerDecision =
	| { kind: "continue" }
	| { kind: "return"; result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } }
	| { kind: "skip-dispatch" }
	| {
			kind: "dispatch";
			batch: TeamTaskState[];
			concurrency: BatchConcurrencyDecision;
			snapshot: TaskGraphSchedulerSnapshot;
			approvalPending: boolean;
			coalesceEnabled: boolean;
	  };
