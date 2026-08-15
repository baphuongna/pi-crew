/**
 * Dispatch-batch selection and execution for the team-run scheduler loop.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * CORE-4 extractions 3+4). Pure code motion: selectDispatchBatch /
 * DispatchBatchDecision / dispatchBatch and their module-private
 * collaborators (findStep, findAgent, markBlocked, cancelNonTerminalTasks,
 * retryPolicyFromConfig, shouldUseRetry, failedTaskFrom, dagReadyTaskIds)
 * moved verbatim.
 */
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewReliabilityConfig } from "../config/config.ts";
import { CrewError, ErrorCode } from "../errors.ts";
import { appendHookEvent, executeHook } from "../hooks/registry.ts";
import { childCorrelation, withCorrelation } from "../observability/correlation.ts";
import { appendEventAsync, appendEventBuffered } from "../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasksAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { TaskAttemptState, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { saveCrewAgents } from "./crew-agent-records.ts";
import { appendDeadletter } from "./deadletter.ts";
import { isNonTerminalTaskStatus } from "./merge-gate.ts";
import { resolveTaskRuntimeKind } from "./model/runtime-policy.ts";
import { filterReadyByWriteOverlap } from "./path-overlap.ts";
import { isMutatingTask, isPlanApprovalPending } from "./plan-approval.ts";
import { CrewCancellationError, cancellationReasonFromSignal } from "./process/cancellation.ts";
import { DEFAULT_RETRY_POLICY, executeWithRetry, type RetryPolicy } from "./recovery/retry-executor.ts";
import type { SchedulerContext, SchedulerDecision, SettledUnit } from "./scheduler-context.ts";
import { buildDispatchUnits, type DispatchUnit, planCoalescedGroups } from "./scheduling/coalesce-tasks.ts";
import { resolveBatchConcurrency } from "./scheduling/concurrency.ts";
import { runCoalescedTaskGroup } from "./scheduling/run-coalesced-task-group.ts";
import { buildExecutionPlan as buildDagExecutionPlan, getReadyTasks as getDagReadyTasks, type TaskNode } from "./scheduling/task-graph.ts";
import { taskGraphSnapshot } from "./scheduling/task-graph-scheduler.ts";
import { recordsForMaterializedTasks } from "./task-display.ts";
import { computeStablePrefixComponents } from "./task-runner/prompt-builder.ts";
import { runTeamTask, type SpawnBudget } from "./task-runner.ts";
import { type PhaseGuardContext, validatePhasePreconditions } from "./workflow-state.ts";

function findStep(workflow: WorkflowConfig, task: TeamTaskState): WorkflowStep {
	const step = workflow.steps.find((candidate) => candidate.id === task.stepId);
	if (!step)
		throw new CrewError(ErrorCode.ResourceNotFound, `Workflow step '${task.stepId}' not found for task '${task.id}'.`).withContext(
			`workflow step lookup (task=${task.id})`,
		);
	return step;
}

function findAgent(agents: AgentConfig[], task: TeamTaskState): AgentConfig {
	const agent = agents.find((candidate) => candidate.name === task.agent);
	if (!agent)
		throw new CrewError(ErrorCode.ResourceNotFound, `Agent '${task.agent}' not found for task '${task.id}'.`).withContext(
			`agent lookup (task=${task.id})`,
		);
	return agent;
}

export function markBlocked(tasks: TeamTaskState[], reason: string): TeamTaskState[] {
	return tasks.map((task) =>
		task.status === "queued"
			? {
					...task,
					status: "skipped",
					error: reason,
					finishedAt: new Date().toISOString(),
					graph: task.graph ? { ...task.graph, queue: "blocked" } : undefined,
				}
			: task,
	);
}

/**
 * CORE-6: Unified cancel/fail of non-terminal tasks. Replaces hand-rolled
 * `.map()` + transform sites across this file.
 *
 * - Without `filter`: all non-terminal tasks (queued/running/waiting) are
 *   terminalised with the given status.
 * - With `filter`: the filter is the sole gate — the non-terminal check is
 *   NOT applied automatically, matching per-task/per-id variants.
 * - Optional `transform(task, terminalised)`: lets a caller attach
 *   site-specific fields (graph mutation, terminalEvidence) to the
 *   terminalised task. `terminalised` already carries status/finishedAt/error;
 *   the transform returns it unchanged or a modified copy.
 *
 * RT-14: the two remaining inline cancel sites (cancelPlanTasks,
 * cancelRunFromSignal) route through this helper via `transform` so EVERY
 * cancel site uses the single shared transform. Their extra logic
 * (graph mutation / terminalEvidence) is preserved inside the transform.
 *
 * `markBlocked` is intentionally NOT unified here (it sets status "skipped",
 * not cancelled/failed, and only acts on "queued" tasks).
 */
export function cancelNonTerminalTasks(
	tasks: TeamTaskState[],
	status: "cancelled" | "failed",
	reason: string,
	filter?: (task: TeamTaskState) => boolean,
	transform?: (task: TeamTaskState, terminalised: TeamTaskState) => TeamTaskState,
): TeamTaskState[] {
	const predicate = filter ?? ((task: TeamTaskState) => isNonTerminalTaskStatus(task.status));
	return tasks.map((task) => {
		if (!predicate(task)) return task;
		const terminalised: TeamTaskState = { ...task, status, finishedAt: new Date().toISOString(), error: reason };
		return transform ? transform(task, terminalised) : terminalised;
	});
}

// 2.8: adaptive-plan parsing/repair/injection moved to src/runtime/goal-workflow/adaptive-plan.ts.
// Re-export the test-only helpers so existing test imports still resolve.

function retryPolicyFromConfig(config: CrewReliabilityConfig | undefined): RetryPolicy {
	return { ...DEFAULT_RETRY_POLICY, ...(config?.retryPolicy ?? {}) };
}

/**
 * #1 (assessment): decide whether the per-task retry path (executeWithRetry) is used.
 * Defaults to TRUE (opt-out) so transient worker hangs (ChildTimeout) are retried
 * automatically. Previously opt-in, which left the entire retry+recovery stack dormant.
 * Exported for unit testing.
 */
export function shouldUseRetry(reliability: CrewReliabilityConfig | undefined): boolean {
	return reliability?.autoRetry !== false;
}

function failedTaskFrom(result: { tasks: TeamTaskState[] }, taskId: string): TeamTaskState | undefined {
	return result.tasks.find((item) => item.id === taskId && item.status === "failed");
}

/**
 * Check whether any task uses explicit `dependsOn` that would benefit from DAG-based
 * execution planning. If so, build an execution plan and use `getDagReadyTasks`
 * to augment the ready-set selection.
 */
function dagReadyTaskIds(tasks: TeamTaskState[], completedIds: Set<string>): string[] | null {
	const hasExplicitDeps = tasks.some((t) => t.dependsOn.length > 0);
	if (!hasExplicitDeps) return null;
	// FIX (goal-wrap runtime test): task.dependsOn stores STEP IDs (e.g. "execute"), not
	// task IDs (e.g. "02_execute"). The DAG scheduler compares deps against completedIds
	// (which are task IDs), so step-ID deps would never match → dependent tasks stuck blocked
	// forever. Map step IDs -> task IDs first (mirror dependencySatisfied in
	// task-graph-scheduler.ts which handles this via stepToTaskId). buildDagExecutionPlan +
	// getDagReadyTasks then work on consistent task IDs.
	const stepToTaskId = new Map<string, string>();
	for (const t of tasks) {
		if (t.stepId) stepToTaskId.set(t.stepId, t.id);
	}
	const nodes: TaskNode[] = tasks.map((t) => ({
		id: t.id,
		dependsOn: t.dependsOn.map((dep) => stepToTaskId.get(dep) ?? dep),
		phase: t.adaptive?.phase ?? t.stepId,
	}));
	const plan = buildDagExecutionPlan(nodes);
	if (plan.hasCycle) return null; // fall back to existing scheduler
	return getDagReadyTasks(plan, completedIds);
}

/**
 * CORE-4 extraction 3: select the dispatch batch for the current loop
 * iteration.
 *
 * Computes the task-graph snapshot, DAG-ready tasks, workflow phase
 * preconditions, batch concurrency, write-path-overlap serialization,
 * coalesced-group logging, and streaming-dispatch slot allocation to
 * determine which tasks are ready to dispatch this cycle.
 *
 * Returns:
 * - `{ kind: "return", result }` when the run must block or abort
 *   (plan-approval pending with mutating tasks, or no ready task at all).
 * - `{ kind: "dispatch", batch, ... }` when a batch is selected (may be
 *   empty when tasks are still in-flight — the caller proceeds to the
 *   wait phase with an empty dispatch set).
 *
 * The caller syncs `ctx.wfMachine` back after the call because this
 * function may advance the workflow phase state machine.
 *
 * @param ctx  The scheduler context; `ctx.wfMachine`, `ctx.tasks`, and
 *             `ctx.manifest` may be mutated in-place.
 */
export async function selectDispatchBatch(ctx: SchedulerContext): Promise<SchedulerDecision> {
	const snapshot = taskGraphSnapshot(ctx.tasks, ctx.queueIndex);

	// DAG-based execution plan: when tasks have explicit dependsOn, use the
	// topological wave planner to determine ready tasks. Fall back to the
	// existing task-graph-scheduler when no explicit deps exist (backward compat).
	const completedIds = new Set(ctx.tasks.filter((t) => t.status === "completed" || t.status === "needs_attention").map((t) => t.id));
	const dagReady = dagReadyTaskIds(ctx.tasks, completedIds);
	const readyBeforeFilter = dagReady ?? snapshot.ready;

	// Workflow phase precondition check (non-blocking: log warnings only).
	if (ctx.wfMachine.currentPhaseIndex < ctx.wfMachine.phases.length) {
		const completedArtifacts = ctx.manifest.artifacts.filter((a) => a.kind === "result" || a.kind === "summary").map((a) => a.path);
		const previousPhaseStatus =
			ctx.wfMachine.currentPhaseIndex > 0
				? (ctx.wfMachine.phases[ctx.wfMachine.currentPhaseIndex - 1]?.status ?? "pending")
				: "completed";
		const wfContext: PhaseGuardContext = {
			completedArtifacts,
			previousPhaseStatus,
			taskResults: ctx.tasks
				.filter((t) => t.status === "completed" || t.status === "needs_attention")
				.map((t) => ({
					taskId: t.id,
					status: t.status,
					outputPath: t.resultArtifact?.path,
				})),
		};
		const preconditions = validatePhasePreconditions(ctx.wfMachine, wfContext);
		if (!preconditions.ready) {
			await appendEventAsync(ctx.manifest.eventsPath, {
				type: "workflow.preconditions",
				runId: ctx.manifest.runId,
				message: `Workflow phase '${ctx.wfMachine.phases[ctx.wfMachine.currentPhaseIndex]?.name}' is missing inputs: ${preconditions.blocking.join(", ")}`,
				data: {
					phaseIndex: ctx.wfMachine.currentPhaseIndex,
					phaseName: ctx.wfMachine.phases[ctx.wfMachine.currentPhaseIndex]?.name,
					blocking: preconditions.blocking,
				},
			});
		} else {
			// Advance the machine past completed phases.
			while (
				ctx.wfMachine.currentPhaseIndex < ctx.wfMachine.phases.length &&
				ctx.wfMachine.phases[ctx.wfMachine.currentPhaseIndex]?.status === "completed"
			) {
				ctx.wfMachine = {
					...ctx.wfMachine,
					currentPhaseIndex: ctx.wfMachine.currentPhaseIndex + 1,
				};
			}
		}
	}

	// W5-4: by-id map once (was O(ready × tasks) via find-per-element).
	const taskByIdReady = new Map(ctx.tasks.map((t) => [t.id, t] as const));
	const readyRoles = readyBeforeFilter.map((taskId) => taskByIdReady.get(taskId)?.role).filter((role): role is string => Boolean(role));
	const concurrency = resolveBatchConcurrency({
		workflowName: ctx.workflow.name,
		workflowMaxConcurrency: ctx.workflow.maxConcurrency,
		teamMaxConcurrency: ctx.input.team.maxConcurrency,
		limitMaxConcurrentWorkers: ctx.input.limits?.maxConcurrentWorkers,
		allowUnboundedConcurrency: ctx.input.limits?.allowUnboundedConcurrency,
		readyCount: readyBeforeFilter.length,
		workspaceMode: ctx.manifest.workspaceMode,
		readyRoles,
	});

	// Round 25 (M5): serialize on write-path overlap when opted in.
	// Opt-in via limits.serializeOnPathOverlap; default off (= no behavior change).
	// filterReadyByWriteOverlap returns the same array when enabled=false, so
	// production runs pay nothing for the unused code path. When the flag is on,
	// `serializedReady` MAY be a strict subset of `readyBeforeFilter` (conflicting tasks
	// deferred to next cycle).
	const serializedReady = filterReadyByWriteOverlap(
		readyBeforeFilter,
		ctx.tasks,
		ctx.workflow,
		concurrency.maxConcurrent,
		ctx.input.limits?.serializeOnPathOverlap === true,
	);

	// Round 25 (M6): coalesce micro-tasks when opted in.
	// Default off; when on, groups same-(role,cwd) tasks into coalesced groups
	// (with write-path safety). In v0.9.17 first ship, we ONLY log the
	// coalesced group count to the event stream (informational). Actual
	// dispatching of one-multi-task worker instead of N workers is deferred
	// to a follow-up — it's a non-trivial prompt-construction change that
	// deserves its own PR. For now, every coalesced group => one info event.
	const coalesceEnabled = ctx.workflow.coalesceMicroTasks === true;
	if (coalesceEnabled) {
		const coalescedGroups = planCoalescedGroups(serializedReady, ctx.tasks, ctx.workflow, true);
		for (const group of coalescedGroups) {
			if (group.tasks.length < 2) continue; // singletons are not interesting
			await appendEventAsync(ctx.manifest.eventsPath, {
				type: "task.coalesced",
				runId: ctx.manifest.runId,
				message: `Coalesced ${group.tasks.length} micro-tasks (role=${group.role}, cwd=${group.cwd})`,
				data: {
					groupId: group.id,
					role: group.role,
					cwd: group.cwd,
					taskIds: group.tasks.map((task) => task.id),
				},
			});
		}
	}
	if (concurrency.reason.includes(";unbounded:")) {
		await appendEventAsync(ctx.manifest.eventsPath, {
			type: "limits.unbounded",
			runId: ctx.manifest.runId,
			message: "Unbounded worker concurrency was explicitly enabled for this run.",
			data: {
				concurrencyReason: concurrency.reason,
				maxConcurrent: concurrency.maxConcurrent,
			},
		});
	}
	// ── OPT-01 streaming dispatch: exclude tasks already in-flight, limit
	// new dispatches to available concurrency slots. ──
	const inFlightTaskIds = new Set<string>();
	for (const pendingUnit of ctx.pendingUnits.values()) {
		for (const taskId of pendingUnit.taskIds) inFlightTaskIds.add(taskId);
	}
	const slotsAvailable = Math.max(0, concurrency.maxConcurrent - ctx.pendingUnits.size);
	const approvalPending = isPlanApprovalPending(ctx.manifest);
	const dispatchableReady = serializedReady.filter((id) => !inFlightTaskIds.has(id));
	const readyIds = approvalPending ? dispatchableReady : dispatchableReady.slice(0, slotsAvailable);
	const taskByIdDispatch = new Map(ctx.tasks.map((t) => [t.id, t] as const));
	const candidateBatch = readyIds.map((id) => taskByIdDispatch.get(id)).filter((task): task is TeamTaskState => Boolean(task));
	const readyBatch = approvalPending ? candidateBatch.filter((task) => !isMutatingTask(task)).slice(0, slotsAvailable) : candidateBatch;
	if (readyBatch.length === 0) {
		if (ctx.pendingUnits.size > 0) {
			// Tasks are in-flight — skip dispatch and proceed to wait phase.
			// (No return; code falls through to the dispatch section which is
			// a no-op with an empty readyBatch, then reaches the wait phase.)
		} else if (approvalPending && candidateBatch.some(isMutatingTask)) {
			await saveRunTasksAsync(ctx.manifest, ctx.tasks);
			saveCrewAgents(ctx.manifest, recordsForMaterializedTasks(ctx.manifest, ctx.tasks, ctx.runtimeKind));
			ctx.manifest = updateRunStatus(ctx.manifest, "blocked", "Plan approval required before mutating implementation tasks run.");
			return { kind: "return", result: { manifest: ctx.manifest, tasks: ctx.tasks } };
		} else {
			ctx.tasks = markBlocked(ctx.tasks, "No ready queued task; dependency graph may be invalid.");
			await saveRunTasksAsync(ctx.manifest, ctx.tasks);
			saveCrewAgents(ctx.manifest, recordsForMaterializedTasks(ctx.manifest, ctx.tasks, ctx.runtimeKind));
			ctx.manifest = updateRunStatus(ctx.manifest, "blocked", "No ready queued task.");
			return { kind: "return", result: { manifest: ctx.manifest, tasks: ctx.tasks } };
		}
	}

	return { kind: "dispatch", batch: readyBatch, concurrency, snapshot, approvalPending, coalesceEnabled };
}

export type DispatchBatchDecision = Extract<SchedulerDecision, { kind: "dispatch" }>;

/**
 * CORE-4 extraction 4: execute the dispatch batch selected by
 * selectDispatchBatch.
 *
 * Runs before_task_start hooks (skipping blocked tasks), builds coalesced
 * dispatch units, pre-warms the stable-prefix cache for unique cwds, and
 * dispatches each unit into ctx.pendingUnits as a fire-and-forget promise
 * (wrapped in executeWithRetry on the singleton path). The function is a
 * verbatim lift of the inline dispatch block; it does not return a
 * SchedulerDecision (void — it only populates ctx.pendingUnits).
 *
 * Reads ctx.manifest/tasks/workflow/input + runController.signal. Mutates
 * ctx.pendingUnits (add), ctx.tasks (hook skips), ctx.manifest (hook
 * status). The mutable manifest/tasks are accessed via ctx.* (not captured
 * locals) so that async retry callbacks observe the caller's re-synced
 * values, matching the original closure semantics.
 *
 * @param ctx       The scheduler context.
 * @param decision  The dispatch decision from selectDispatchBatch.
 */
export async function dispatchBatch(ctx: SchedulerContext, decision: DispatchBatchDecision): Promise<void> {
	const { batch: readyBatch, concurrency, snapshot, approvalPending, coalesceEnabled } = decision;
	// Immutable context fields captured once; manifest/tasks are accessed via
	// ctx.* because they may be re-synced by the caller between dispatch and
	// promise resolution (retry callbacks fire asynchronously).
	const { workflow, input, runtimeKind, runController } = ctx;

	// 2.2 caller migration: batch progress is high-frequency informational (M7 wire).
	void appendEventBuffered(ctx.manifest.eventsPath, {
		type: "task.progress",
		runId: ctx.manifest.runId,
		message: `Starting ready batch with ${readyBatch.length} task(s).`,
		data: {
			taskIds: readyBatch.map((task) => task.id),
			readyCount: snapshot.ready.length,
			blockedCount: snapshot.blocked.length,
			runningCount: snapshot.running.length,
			doneCount: snapshot.done.length,
			selectedCount: readyBatch.length,
			maxConcurrent: concurrency.maxConcurrent,
			defaultConcurrency: concurrency.defaultConcurrency,
			concurrencyReason: approvalPending ? `${concurrency.reason};plan-approval-read-only` : concurrency.reason,
		},
	});
	// Execute before_task_start hooks for the batch — P1-10: run hooks in
	// parallel (each may be a subprocess), then apply skip mutations in order.
	const beforeTaskStartReports = await Promise.all(
		readyBatch.map((task) =>
			executeHook("before_task_start", {
				runId: ctx.manifest.runId,
				taskId: task.id,
				cwd: ctx.manifest.cwd,
			}).then((taskReport) => ({ task, taskReport })),
		),
	);
	for (const { task, taskReport } of beforeTaskStartReports) {
		appendHookEvent(ctx.manifest, taskReport);
		if (taskReport.outcome === "block") {
			ctx.tasks = ctx.tasks.map((t) =>
				t.id === task.id
					? {
							...t,
							status: "skipped" as const,
							error: taskReport.reason ?? "before_task_start hook blocked execution.",
						}
					: t,
			);
			ctx.manifest = updateRunStatus(ctx.manifest, ctx.manifest.status, `Task '${task.id}' blocked by hook.`);
		}
	}
	// W5-4: by-id map (was O(readyBatch × tasks) via find-per-element).
	const ctxTaskById = new Map(ctx.tasks.map((t) => [t.id, t] as const));
	const batchTasks = readyBatch.filter((task) => {
		const t = ctxTaskById.get(task.id);
		return t !== undefined && t.status !== "skipped";
	});
	if (batchTasks.length > 1) {
		await appendEventAsync(ctx.manifest.eventsPath, {
			type: "task.parallel_start",
			runId: ctx.manifest.runId,
			message: `Launching ${batchTasks.length} tasks in PARALLEL (concurrency=${concurrency.selectedCount}): ${batchTasks.map((t) => `${t.role}(${t.id})`).join(", ")}`,
			data: {
				taskIds: batchTasks.map((t) => t.id),
				roles: batchTasks.map((t) => t.role),
				concurrency: concurrency.selectedCount,
			},
		});
	}

	// M6 real dispatch: when coalesceMicroTasks is enabled, batch the
	// ready tasks into dispatch units. Multi-task groups are dispatched
	// as one worker (single cold-start) instead of N. Singletons fall
	// through to per-task dispatch.
	const coalescedGroups = planCoalescedGroups(
		batchTasks.map((t) => t.id),
		ctx.tasks,
		workflow,
		coalesceEnabled,
	);
	const dispatchUnits = buildDispatchUnits(
		batchTasks.map((t) => t.id),
		coalescedGroups,
	);

	// NEW-M1: Pre-warm stable prefix cache for one representative task
	// per unique cwd. Parallel siblings with the same cwd/step reuse
	// the cached workspace tree, file retrieval, and knowledge fragment
	// instead of recomputing them independently (~200-800ms per batch).
	if (batchTasks.length > 1) {
		const seenCwds = new Set<string>();
		await Promise.all(
			batchTasks
				.filter((task) => {
					if (seenCwds.has(task.cwd)) return false;
					seenCwds.add(task.cwd);
					return true;
				})
				.map((task) => {
					const step = findStep(workflow, task);
					return computeStablePrefixComponents(ctx.manifest, step, task);
				}),
		);
	}

	// ── OPT-01 streaming dispatch: dispatch each unit into ctx.pendingUnits
	// instead of awaiting the entire batch via mapConcurrent. Each unit's
	// promise is stored so we can Promise.race on the next iteration. ──
	const dispatchUnit = async (unit: DispatchUnit): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> => {
		// M6 real dispatch path: single worker for N tasks.
		if (unit.kind === "group") {
			const groupTasks = unit.group.tasks;
			const firstTask = groupTasks[0]!;
			const step = findStep(workflow, firstTask);
			const agent = findAgent(input.agents, firstTask);
			const teamRole = input.team.roles.find((role) => role.name === firstTask.role);
			const perTaskRuntime = resolveTaskRuntimeKind(runtimeKind, firstTask.role, input.runtimeConfig?.isolationPolicy);
			return runCoalescedTaskGroup({
				manifest: ctx.manifest,
				tasks: ctx.tasks,
				groupTasks,
				step,
				agent,
				signal: runController.signal,
				executeWorkers: input.executeWorkers,
				runtimeKind,
				workspaceId: input.workspaceId,
				onJsonEvent: input.onJsonEvent,
				runtimeConfig: input.runtimeConfig,
				reliability: input.reliability,
				teamRole,
				perTaskRuntime,
			});
		}
		// Singleton path: original per-task dispatch.
		const task = batchTasks.find((t) => t.id === unit.taskId)!;
		const step = findStep(workflow, task);
		const agent = findAgent(input.agents, task);
		const teamRole = input.team.roles.find((role) => role.name === task.role);
		const perTaskRuntime = resolveTaskRuntimeKind(runtimeKind, task.role, input.runtimeConfig?.isolationPolicy);
		// CORE-3: compute retry policy + spawn budget ONCE per dispatch unit.
		// The spawnBudget object is shared (by reference) across every
		// runTeamTask call within executeWithRetry via baseInput spread,
		// so the counter accumulates across retry attempts × model fallbacks.
		const policy = retryPolicyFromConfig(input.reliability);
		const spawnBudget: SpawnBudget = { count: 0, max: policy.maxTotalSpawns ?? 0 };
		const baseInput = {
			manifest: ctx.manifest,
			tasks: ctx.tasks,
			task,
			step,
			agent,
			signal: runController.signal,
			executeWorkers: input.executeWorkers,
			runtimeKind: runtimeKind,
			taskRuntimeOverride: perTaskRuntime !== runtimeKind ? perTaskRuntime : undefined,
			runtimeConfig: input.runtimeConfig,
			parentContext: input.parentContext,
			parentModel: input.parentModel,
			modelRegistry: input.modelRegistry,
			modelOverride: input.modelOverride,
			teamRoleModel: teamRole?.model,
			teamRoleThinking: teamRole?.thinking,
			teamRoleFallbackModels: teamRole?.fallbackModels,
			teamRoleSkills: teamRole?.skills,
			skillOverride: input.skillOverride,
			limits: input.limits,
			onJsonEvent: input.onJsonEvent,
			workspaceId: input.workspaceId,
			spawnBudget,
		};
		// #1 (assessment): autoRetry now defaults ON (opt-out via reliability.autoRetry=false).
		// The dominant v0.9.13 failure was ChildTimeout ("worker became unresponsive") with
		// ZERO retries because this gate was opt-in. isRetryable() defaults to true when
		// retryableErrors is empty, so transient hangs now retry up to maxAttempts (3) with
		// exponential backoff. Set reliability.autoRetry=false to restore old single-shot behavior.
		if (!shouldUseRetry(input.reliability))
			return withCorrelation(childCorrelation(ctx.manifest.runId, task.id), () => runTeamTask(baseInput));
		let lastFailed: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
		let lastAttemptId: string | undefined;
		const attemptsSoFar: TaskAttemptState[] = [...(task.attempts ?? [])];
		try {
			return await executeWithRetry(
				async (attempt, info) => {
					const startedAt = new Date().toISOString();
					const inFlightAttempts: TaskAttemptState[] = [...attemptsSoFar, { attemptId: info.attemptId, startedAt }];
					input.metricRegistry?.counter("crew.task.retry_attempt_total", "Retry attempts by run and task").inc({
						runId: ctx.manifest.runId,
						taskId: task.id,
					});
					// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
					const fresh = loadRunManifestById(ctx.manifest.cwd, ctx.manifest.runId);
					const freshManifest = fresh?.manifest ?? ctx.manifest;
					const freshTasks = fresh?.tasks ?? ctx.tasks;
					const freshTask = freshTasks.find((item) => item.id === task.id) ?? task;
					if (freshTask.status !== "queued" && freshTask.status !== "running")
						return {
							manifest: freshManifest,
							tasks: freshTasks,
						};
					const taskWithAttempt: TeamTaskState = {
						...freshTask,
						attempts: inFlightAttempts,
					};
					const result = await withCorrelation(childCorrelation(freshManifest.runId, task.id), () =>
						runTeamTask({
							...baseInput,
							manifest: freshManifest,
							tasks: freshTasks,
							task: taskWithAttempt,
						}),
					);
					const failed = failedTaskFrom(result, task.id);
					const endedAt = new Date().toISOString();
					const finishedAttempt: TaskAttemptState = {
						attemptId: info.attemptId,
						startedAt,
						endedAt,
						...(failed?.error ? { error: failed.error } : {}),
					};
					attemptsSoFar.push(finishedAttempt);
					const withAttempt = result.tasks.map((item) =>
						item.id === task.id ? { ...item, attempts: [...attemptsSoFar] } : item,
					);
					const enriched = {
						manifest: result.manifest,
						tasks: withAttempt,
					};
					if (failed) {
						lastFailed = enriched;
						throw new CrewError(ErrorCode.TaskNotFound, failed.error ?? `Task ${task.id} failed.`).withContext(
							`retry evaluation (run=${ctx.manifest.runId})`,
						);
					}
					input.metricRegistry?.histogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]).observe(
						{
							runId: ctx.manifest.runId,
							team: input.team.name,
						},
						Math.max(0, attempt - 1),
					);
					return enriched;
				},
				policy,
				{
					signal: runController.signal,
					attemptId: (attempt) => `${ctx.manifest.runId}:${task.id}:attempt-${attempt}`,
					onAttemptFailed: (attempt, error, delayMs, info) => {
						lastAttemptId = info.attemptId;
						appendEventAsync(ctx.manifest.eventsPath, {
							type: "crew.task.retry_attempt",
							runId: ctx.manifest.runId,
							taskId: task.id,
							message: error.message,
							data: {
								attempt,
								attemptId: info.attemptId,
								delayMs,
							},
							metadata: { attemptId: info.attemptId },
						}).catch((error) => logInternalError("team-runner.retry-attempt", error, `taskId=${task.id}`));
						input.metricRegistry?.histogram("crew.task.retry_delay_ms", "Retry backoff delay, milliseconds").observe(
							{
								runId: ctx.manifest.runId,
								taskId: task.id,
							},
							delayMs,
						);
					},
					onRetryGivenUp: (attempts, error, info) => {
						lastAttemptId = info.attemptId;
						appendDeadletter(ctx.manifest, {
							runId: ctx.manifest.runId,
							taskId: task.id,
							reason: "max-retries",
							attempts,
							attemptId: info.attemptId,
							lastError: error.message,
							timestamp: new Date().toISOString(),
						});
						input.metricRegistry
							?.counter("crew.task.deadletter_total", "Deadletter triggers by reason")
							.inc({ reason: "max-retries" });
						input.metricRegistry?.histogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]).observe(
							{
								runId: ctx.manifest.runId,
								team: input.team.name,
							},
							Math.max(0, attempts - 1),
						);
					},
				},
			);
		} catch (retryError) {
			if (retryError instanceof CrewCancellationError || input.signal?.aborted) {
				const reason = retryError instanceof CrewCancellationError ? retryError.reason : cancellationReasonFromSignal(input.signal);
				// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
				const fresh = loadRunManifestById(ctx.manifest.cwd, ctx.manifest.runId);
				const freshManifest = fresh?.manifest ?? ctx.manifest;
				const freshTasks = fresh?.tasks ?? ctx.tasks;
				const cancelledTasks = cancelNonTerminalTasks(
					freshTasks,
					"cancelled",
					`${reason.message} (${reason.code})`,
					(item) => item.id === task.id && (item.status === "queued" || item.status === "running"),
				);
				appendEventAsync(freshManifest.eventsPath, {
					type: "task.cancelled",
					runId: freshManifest.runId,
					taskId: task.id,
					message: reason.message,
					data: { reason, phase: "retry" },
					metadata: lastAttemptId ? { attemptId: lastAttemptId } : undefined,
				}).catch((error) => logInternalError("team-runner.cancelled", error, `taskId=${task.id}`));
				return {
					manifest: updateRunStatus(freshManifest, "cancelled", reason.message),
					tasks: cancelledTasks,
				};
			}
			if (lastFailed) return lastFailed;
			// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
			const fresh = loadRunManifestById(ctx.manifest.cwd, ctx.manifest.runId);
			const freshManifest = fresh?.manifest ?? ctx.manifest;
			const freshTasks = fresh?.tasks ?? ctx.tasks;
			const freshTask = freshTasks.find((item) => item.id === task.id) ?? task;
			if (freshTask.status !== "queued" && freshTask.status !== "running") return { manifest: freshManifest, tasks: freshTasks };
			return withCorrelation(childCorrelation(freshManifest.runId, task.id), () =>
				runTeamTask({
					...baseInput,
					manifest: freshManifest,
					tasks: freshTasks,
					task: freshTask,
				}),
			);
		}
	};
	// ── OPT-01 streaming dispatch: dispatch units into ctx.pendingUnits ──
	for (const unit of dispatchUnits) {
		const unitKey = unit.kind === "singleton" ? unit.taskId : unit.group.id;
		const unitTaskIds = unit.kind === "singleton" ? [unit.taskId] : unit.group.tasks.map((t) => t.id);
		// RT-12: create the wrapper promise ONCE at dispatch time so
		// mergeUnitResult can Promise.race on pre-existing wrappers instead
		// of allocating new async closures every loop iteration.
		const rawPromise = dispatchUnit(unit);
		const wrapped: Promise<SettledUnit> = (async () => {
			try {
				const result = await rawPromise;
				return {
					unitKey,
					result: result as { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined,
					error: undefined as Error | undefined,
				};
			} catch (error) {
				return { unitKey, result: undefined, error: error instanceof Error ? error : new Error(String(error)) };
			}
		})();
		ctx.pendingUnits.set(unitKey, {
			taskIds: unitTaskIds,
			promise: rawPromise,
			wrapped,
		});
		// RT-NEW-2 race fix: record ever-dispatched task ids so terminaliseRunWithDrain
		// cancels (not skips) tasks whose unit settled + left pendingUnits before
		// the abort fired but whose task status isn't terminal yet.
		for (const id of unitTaskIds) ctx.dispatchedTaskIds.add(id);
	}
}

/** @internal 1.9(b) test export — exercise selectDispatchBatch directly. */
export const __test__selectDispatchBatch = selectDispatchBatch;
