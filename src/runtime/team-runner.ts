import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewRuntimeConfig, CrewReliabilityConfig } from "../config/config.ts";
import type { CrewRuntimeCapabilities } from "./runtime-resolver.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { resolveTaskRuntimeKind } from "./runtime-policy.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { executeHook, appendHookEvent } from "../hooks/registry.ts";
import { appendEvent, appendEventAsync, appendEventFireAndForget } from "../state/event-log.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { ArtifactDescriptor, PolicyDecision, TeamRunManifest, TaskAttemptState, TeamTaskState } from "../state/types.ts";
import { loadRunManifestById, saveRunManifest, saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/state-store.ts";
import { withRunLock } from "../state/locks.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { evaluateCrewPolicy, summarizePolicyDecisions } from "./policy-engine.ts";
import { buildRecoveryLedger } from "./recovery-recipes.ts";
import { buildTaskGraphIndex, refreshTaskGraphQueues, taskGraphSnapshot } from "./task-graph-scheduler.ts";
import { buildExecutionPlan as buildDagExecutionPlan, getReadyTasks as getDagReadyTasks, type TaskNode } from "./task-graph.ts";
import { checkBranchFreshness } from "../worktree/branch-freshness.ts";
import { aggregateTaskOutputs } from "./task-output-context.ts";
import { readCrewAgents, saveCrewAgents } from "./crew-agent-records.ts";
import { recordsForMaterializedTasks } from "./task-display.ts";
import { deliverGroupJoin, resolveGroupJoinMode } from "./group-join.ts";
import { runTeamTask } from "./task-runner.ts";
import { terminateLiveAgentsForRun } from "./live-agent-manager.ts";
import { createWorkflowStateMachine, validatePhasePreconditions, transitionPhase, type PhaseState, type PhaseGuardContext } from "./workflow-state.ts";
import { executeWithRetry, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./retry-executor.ts";
import { appendDeadletter } from "./deadletter.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { childCorrelation, withCorrelation } from "../observability/correlation.ts";
import { crewHooks } from "./crew-hooks.ts";
import { resolveBatchConcurrency } from "./concurrency.ts";
import { mapConcurrent } from "./parallel-utils.ts";
import { permissionForRole } from "./role-permission.ts";
import { registerRunPromise, resolveRunPromise, rejectRunPromise } from "./run-tracker.ts";
import { clearTrackedTaskUsage } from "./usage-tracker.ts";
import { CrewCancellationError, buildSyntheticTerminalEvidence, cancellationReasonFromSignal } from "./cancellation.ts";
import { effectivenessPolicyDecision, evaluateRunEffectiveness, formatRunEffectivenessLines } from "./effectiveness.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { PluginRegistry } from "../plugins/plugin-registry.ts";
import { NextJsPlugin, VitestPlugin, VitePlugin } from "../plugins/plugins/index.ts";
import { HealthStore } from "../state/health-store.ts";

// Built-in plugin registry for framework awareness.
// NOTE: This registry is registered here for future use. The integration
// point (reading package.json deps, computing active plugin context, and
// passing it into RunConfig / task-runner) is not yet implemented; see
// `getPluginContext` in src/plugins/plugin-context.ts (planned).
const builtInRegistry = new PluginRegistry();
builtInRegistry.register(NextJsPlugin);
builtInRegistry.register(VitestPlugin);
builtInRegistry.register(VitePlugin);

/**
 * Start a periodic heartbeat for the team-level run.
 *
 * The stale reconciler (src/runtime/stale-reconciler.ts) marks runs as failed
 * if their heartbeat is older than `NO_PID_HEARTBEAT_STALE_MS` (5 minutes).
 * Without this, long-running team runs (e.g. multi-phase workflows) get
 * cancelled by the reconciler as "stale" even when they are actively
 * executing. The team-runner has no periodic heartbeat today, so any
 * team run lasting >5min is at risk.
 */
function startTeamRunHeartbeat(stateRoot: string, runId: string): () => void {
	const heartbeatPath = path.join(stateRoot, "heartbeat.json");
	const writeHeartbeat = (): void => {
		try {
			// lastTaskUpdateAt is written fresh on each tick so the heartbeat
			// never carries a stale creation-time timestamp. Previously this
			// captured manifest.updatedAt once at startup, making the value
			// permanently stale throughout the run.
			const now = new Date().toISOString();
			fs.writeFileSync(heartbeatPath, JSON.stringify({
				pid: process.pid,
				at: Date.now(),
				runId,
				kind: "team-runner",
				lastTaskUpdateAt: now,
			}), { encoding: "utf-8", mode: 0o600 });
		} catch {
			// best-effort
		}
	};
	writeHeartbeat();
	// NOTE: This interval is deliberately NOT unref'd. Unlike background-runner's
	// heartbeat and interrupt guard (both unref'd), the team heartbeat must keep
	// the event loop alive so the stale reconciler does not cancel long-running
	// team runs (>5 min) as "stale" while they are actively executing.
	const interval = setInterval(writeHeartbeat, 30_000);
	return () => clearInterval(interval);
}

export interface ExecuteTeamRunInput {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	team: TeamConfig;
	workflow: WorkflowConfig;
	agents: AgentConfig[];
	executeWorkers: boolean;
	limits?: CrewLimitsConfig;
	runtime?: CrewRuntimeCapabilities;
	runtimeConfig?: CrewRuntimeConfig;
	parentContext?: string;
	parentModel?: unknown;
	modelRegistry?: unknown;
	modelOverride?: string;
	signal?: AbortSignal;
	reliability?: CrewReliabilityConfig;
	metricRegistry?: MetricRegistry;
	/** Skill override from the team tool. false disables skill injection for this run. */
	skillOverride?: string[] | false;
	/** Optional callback for JSON events from child Pi. Used for overflow recovery tracking. */
	onJsonEvent?: (taskId: string, runId: string, event: unknown) => void;
	/** Workspace where this run was initiated — used for session-scoped live-agent visibility. */
	workspaceId: string;
}

function findStep(workflow: WorkflowConfig, task: TeamTaskState): WorkflowStep {
	const step = workflow.steps.find((candidate) => candidate.id === task.stepId);
	if (!step) throw new Error(`Workflow step '${task.stepId}' not found for task '${task.id}'.`);
	return step;
}

function findAgent(agents: AgentConfig[], task: TeamTaskState): AgentConfig {
	const agent = agents.find((candidate) => candidate.name === task.agent);
	if (!agent) throw new Error(`Agent '${task.agent}' not found for task '${task.id}'.`);
	return agent;
}

function markBlocked(tasks: TeamTaskState[], reason: string): TeamTaskState[] {
	return tasks.map((task) => task.status === "queued" ? { ...task, status: "skipped", error: reason, finishedAt: new Date().toISOString(), graph: task.graph ? { ...task.graph, queue: "blocked" } : undefined } : task);
}

function mergeArtifacts(items: ArtifactDescriptor[]): ArtifactDescriptor[] {
	const byPath = new Map<string, ArtifactDescriptor>();
	for (const item of items) byPath.set(item.path, item);
	return [...byPath.values()];
}

function isNonTerminalTaskStatus(status: TeamTaskState["status"]): boolean {
	return status === "queued" || status === "running" || status === "waiting";
}

/**
 * Returns the finishedAt timestamp as a number, or Infinity for invalid/malformed dates.
 * This makes comparison logic in shouldMergeTaskUpdate more readable by abstracting
 * the NaN handling into a single well-named function.
 */
function safeFinishedAt(task: TeamTaskState): number {
	if (!task.finishedAt) return -Infinity;
	const ms = new Date(task.finishedAt).getTime();
	return Number.isNaN(ms) ? Infinity : ms;
}

/**
 * Returns true when the current task has a malformed finishedAt (NaN/Infinity)
 * and the updated task has a valid finite finishedAt. Malformed finishedAt
 * should be replaced rather than persisting corruption.
 */
function isMalformedFinishedAtReplacement(currentTime: number, updatedTime: number): boolean {
	return !Number.isFinite(currentTime) && Number.isFinite(updatedTime);
}

function shouldMergeTaskUpdate(current: TeamTaskState, updated: TeamTaskState): boolean {
	// Parallel workers receive the same input snapshot. A later result may still
	// contain stale queued/running copies of tasks that another worker already
	// completed. Never let those stale snapshots regress durable task state.
	if (current.status === "waiting" && updated.status === "running") return false;
	// Block terminal→non-terminal transitions (e.g. completed→running).
	// A task that has reached a terminal state must not be resurrected.
	const currentIsTerminal = !isNonTerminalTaskStatus(current.status);
	const updatedIsNonTerminal = isNonTerminalTaskStatus(updated.status);
	if (currentIsTerminal && updatedIsNonTerminal) return false;
	// Explicitly block completed↔needs_attention terminal-to-terminal transitions.
// Both are success terminal states used interchangeably; stale worker updates must
// not cause a completed task to appear as needs_attention or vice versa.
if (current.status === "completed" && updated.status === "needs_attention") return false;
if (current.status === "needs_attention" && updated.status === "completed") return false;
	// Explicitly block failed→completed resurrection. Both statuses are terminal,
	// but completed is the success terminal state and should not be reachable from
	// failed via a stale merge. The check above only guards non-terminal→terminal.
	if (current.status === "failed" && updated.status === "completed") return false;
	// Guard: when current is "running" but has resultArtifact (another worker already
	// completed it), a stale updated with status="running" and no resultArtifact
	// must not overwrite the actual completed state.
	if (current.status === updated.status && updated.status === "running" && Boolean(current.resultArtifact) && !updated.resultArtifact) return false;
	// Guard: when current is "completed" and has resultArtifact but updated is also
	// "completed" without resultArtifact, block the stale update from overwriting
	// a task that successfully produced output.
	if (current.status === updated.status && current.status === "completed" && Boolean(current.resultArtifact) && !updated.resultArtifact) return false;
	// Prevent a stale completed task from overwriting a fresher one.
	// Restructure to handle undefined current.finishedAt as a special case:
	// - undefined current + valid updated: allow the update
	// - valid current + undefined updated: block the update (don't lose completion time)
	// - both undefined: finishedAt guard does not apply, fall through to heartbeat check
	// - both valid: compare timestamps as before
	if (current.finishedAt !== undefined && updated.finishedAt !== undefined) {
		const currentTime = safeFinishedAt(current);
		const updatedTime = safeFinishedAt(updated);
		// Malformed finishedAt (NaN) is treated as Infinity — invalid state should be
		// replaced rather than persisting corruption. Log warning for visibility.
		if (!Number.isFinite(currentTime)) {
			console.warn(`[team-runner] Task ${current.id} has malformed finishedAt: ${current.finishedAt}`);
		}
		if (isMalformedFinishedAtReplacement(currentTime, updatedTime)) {
			return true;
		}
		if (updatedTime < currentTime) return false;
	}
	// Block if updated is trying to establish a terminal status without a finishedAt
	// timestamp. Heartbeat-only updates (status='running', no finishedAt) are
	// allowed if heartbeat has changed (checked separately in hasMeaningfulUpdate).
	if (!updated.finishedAt && !isNonTerminalTaskStatus(updated.status)) return false;
	// Explicitly enumerate all fields that constitute a meaningful update so that
// adding a new important field requires updating this list (rather than silently
// losing data if a field is forgotten in the boolean OR chain below).
const hasMeaningfulUpdate =
  updated.status !== current.status ||
  updated.finishedAt !== current.finishedAt ||
  updated.startedAt !== current.startedAt ||
  Boolean(updated.resultArtifact) !== Boolean(current.resultArtifact) ||
  (Boolean(updated.resultArtifact) && updated.resultArtifact !== current.resultArtifact) ||
  Boolean(updated.error) ||
  Boolean(updated.modelAttempts?.length) ||
  Boolean(updated.usage) ||
  Boolean(updated.attempts?.length) ||
  updated.heartbeat?.lastSeenAt !== current.heartbeat?.lastSeenAt ||
  updated.jsonEvents !== current.jsonEvents ||
  updated.agentProgress?.lastActivityAt !== current.agentProgress?.lastActivityAt;
return hasMeaningfulUpdate;
}

// H4 fix: rename to descriptive name. Kept __test__ as alias for backward
// compat test imports.
export function mergeTaskUpdatesPreservingTerminal(base: TeamTaskState[], results: Array<{ tasks: TeamTaskState[] }>): TeamTaskState[] {
	let merged = base;
	for (const result of results) {
		for (const updated of result.tasks) {
			const current = merged.find((task) => task.id === updated.id);
			if (!current) continue;
			if (!shouldMergeTaskUpdate(current, updated)) {
				// Log skipped merges for visibility into rejected parallel updates.
				// In distributed systems with parallel workers, rejected merges may
				// indicate bugs (wrong status, timestamp corruption) if they accumulate.
				console.debug("[team-runner] Skipping stale merge for task", updated.id, {
					currentStatus: current.status,
					updatedStatus: updated.status,
					currentFinishedAt: current.finishedAt,
					updatedFinishedAt: updated.finishedAt,
				});
				continue;
			}
			merged = merged.map((task) => task.id === updated.id ? updated : task);
		}
	}
	return refreshTaskGraphQueues(merged);
}
/** @deprecated Use mergeTaskUpdatesPreservingTerminal. Kept for backward test import compat. */
export const __test__mergeTaskUpdates = mergeTaskUpdatesPreservingTerminal;

// 2.8: adaptive-plan parsing/repair/injection moved to src/runtime/adaptive-plan.ts.
// Re-export the test-only helpers so existing test imports still resolve.
export { __test__parseAdaptivePlan, __test__repairAdaptivePlan } from "./adaptive-plan.ts";
import { injectAdaptivePlanIfReady } from "./adaptive-plan.ts";

function formatTaskProgress(task: TeamTaskState): string {
	return `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.error ? ` - ${task.error}` : ""}`;
}

function runEffectivenessLines(manifest: TeamRunManifest, tasks: TeamTaskState[], executeWorkers: boolean, runtimeConfig?: CrewRuntimeConfig): string[] {
	return formatRunEffectivenessLines(evaluateRunEffectiveness({ manifest, tasks, executeWorkers, runtimeConfig }));
}

function writeProgress(manifest: TeamRunManifest, tasks: TeamTaskState[], producer: string, executeWorkers = true, runtimeConfig?: CrewRuntimeConfig): TeamRunManifest {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const queue = taskGraphSnapshot(tasks);
	const progress = writeArtifact(manifest.artifactsRoot, {
		kind: "progress",
		relativePath: "progress.md",
		producer,
		content: [
			`# pi-crew progress ${manifest.runId}`,
			"",
			`Status: ${manifest.status}`,
			`Team: ${manifest.team}`,
			`Workflow: ${manifest.workflow ?? "(none)"}`,
			`Updated: ${new Date().toISOString()}`,
			`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
			`Queue: ready=${queue.ready.length}, blocked=${queue.blocked.length}, running=${queue.running.length}, done=${queue.done.length}, failed=${queue.failed.length}, cancelled=${queue.cancelled.length}`,
			"",
			"## Tasks",
			...tasks.map(formatTaskProgress),
			"",
			"## Effectiveness",
			...runEffectivenessLines(manifest, tasks, executeWorkers, runtimeConfig),
			"",
		].join("\n"),
	});
	return { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts.filter((artifact) => !(artifact.kind === "progress" && artifact.path === progress.path)), progress].filter((artifact, index, self) => self.findIndex((a) => a.path === artifact.path) === index) };
}

function applyPolicy(manifest: TeamRunManifest, tasks: TeamTaskState[], limits?: CrewLimitsConfig): TeamRunManifest {
	const branchFreshness = checkBranchFreshness(manifest.cwd);
	const branchArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "metadata/branch-freshness.json",
		producer: "branch-freshness",
		content: `${JSON.stringify(branchFreshness, null, 2)}\n`,
	});
	let decisions: PolicyDecision[] = evaluateCrewPolicy({ manifest, tasks, limits });
	if (branchFreshness.status === "stale" || branchFreshness.status === "diverged") {
		const branchDecision: PolicyDecision = {
			action: "notify",
			reason: "branch_stale",
			message: branchFreshness.message,
			createdAt: new Date().toISOString(),
		};
		decisions = [...decisions, branchDecision];
		appendEvent(manifest.eventsPath, { type: "branch.stale", runId: manifest.runId, message: branchFreshness.message, data: { branchFreshness } });
	}
	const policyArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "policy-decisions.json",
		producer: "policy-engine",
		content: `${JSON.stringify(decisions, null, 2)}\n`,
	});
	const recoveryLedger = buildRecoveryLedger(decisions);
	const recoveryArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "recovery-ledger.json",
		producer: "recovery-engine",
		content: `${JSON.stringify(recoveryLedger, null, 2)}\n`,
	});
	for (const item of decisions) appendEvent(manifest.eventsPath, { type: item.action === "escalate" ? "policy.escalated" : "policy.action", runId: manifest.runId, taskId: item.taskId, message: item.message, data: { action: item.action, reason: item.reason } });
	for (const item of recoveryLedger.entries) appendEvent(manifest.eventsPath, { type: item.state === "escalation_required" ? "recovery.escalated" : "recovery.attempted", runId: manifest.runId, taskId: item.taskId, message: item.message, data: { scenario: item.scenario, steps: item.steps, attempt: item.attempt, state: item.state } });
	return { ...manifest, updatedAt: new Date().toISOString(), policyDecisions: decisions, artifacts: [...manifest.artifacts.filter((artifact) => !(artifact.kind === "metadata" && (artifact.path.endsWith("policy-decisions.json") || artifact.path.endsWith("recovery-ledger.json") || artifact.path.endsWith("branch-freshness.json")))), branchArtifact, policyArtifact, recoveryArtifact] };
}

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

function requiresPlanApproval(_workflow: WorkflowConfig, runtimeConfig: CrewRuntimeConfig | undefined): boolean {
	// ROADMAP T1.2: plan-level HITL applies to ANY workflow when
	// config.runtime.requirePlanApproval === true (not just 'implementation').
	// The gate fires at the read-only → mutating (plan → execute) boundary.
	return runtimeConfig?.requirePlanApproval === true;
}

function isPlanApprovalPending(manifest: TeamRunManifest): boolean {
	return manifest.planApproval?.required === true && manifest.planApproval.status === "pending";
}

function isMutatingTask(task: TeamTaskState): boolean {
	return permissionForRole(task.role) !== "read_only";
}

function ensurePlanApprovalRequested(manifest: TeamRunManifest, tasks: TeamTaskState[]): TeamRunManifest {
	if (manifest.planApproval) return manifest;
	const assessTask = tasks.find((task) => task.stepId === "assess" && task.status === "completed");
	// ROADMAP T1.2: for non-adaptive workflows, fall back to the most recent
	// completed read-only (planning) task as the plan reference.
	const planTask = assessTask ?? [...tasks].reverse().find((t) => t.status === "completed" && !isMutatingTask(t));
	const now = new Date().toISOString();
	const updated: TeamRunManifest = {
		...manifest,
		updatedAt: now,
		planApproval: {
			required: true,
			status: "pending",
			requestedAt: now,
			updatedAt: now,
			planTaskId: planTask?.id,
			planArtifactPath: planTask?.resultArtifact?.path,
		},
	};
	saveRunManifest(updated);
	appendEvent(updated.eventsPath, { type: "plan.approval_required", runId: updated.runId, taskId: planTask?.id, message: "Plan requires explicit approval before mutating tasks run. Use: team api op=approve-plan runId=...", data: { planArtifactPath: planTask?.resultArtifact?.path } });
	return updated;
}

function cancelPlanTasks(tasks: TeamTaskState[], reason: string): TeamTaskState[] {
	return tasks.map((task) => task.status === "queued" || task.status === "running" || task.status === "waiting" ? { ...task, status: "cancelled", finishedAt: new Date().toISOString(), error: reason, graph: task.graph ? { ...task.graph, queue: "done" } : undefined } : task);
}

function hasPendingMutatingAdaptiveTask(tasks: TeamTaskState[]): boolean {
	return tasks.some((task) => task.status === "queued" && task.adaptive && isMutatingTask(task));
}

/**
 * ROADMAP T1.2: gate detection for ANY workflow (not just adaptive).
 * Fires when there are pending mutating tasks whose prerequisites (read-only
 * tasks) have completed — i.e. the plan→execute boundary.
 */
export function hasPendingMutatingTaskAtBoundary(tasks: TeamTaskState[]): boolean {
	const hasCompletedReadOnly = tasks.some((t) => t.status === "completed" && !isMutatingTask(t));
	const hasPendingMutating = tasks.some((t) => t.status === "queued" && isMutatingTask(t));
	return hasCompletedReadOnly && hasPendingMutating;
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

export async function executeTeamRun(input: ExecuteTeamRunInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	const workflow = input.workflow;
	let manifest = updateRunStatus(input.manifest, "running", input.executeWorkers ? "Executing team workflow." : "Creating workflow prompts and placeholder results.");

	void registerRunPromise(manifest.runId);

	// FIX (Round 15, regression): Start a team-level heartbeat so the stale
	// reconciler does not cancel long-running team runs after 5 minutes
	// (NO_PID_HEARTBEAT_STALE_MS). Previously only sub-task runners wrote
	// heartbeats; the team-level run had no heartbeat, so any multi-phase
	// workflow lasting >5min was marked stale and cancelled.
	const stopTeamHeartbeat = startTeamRunHeartbeat(manifest.stateRoot, manifest.runId);

	const cleanupUsage = (): void => {
		for (const task of input.tasks) clearTrackedTaskUsage(task.id);
	};

	try {
		const result = await executeTeamRunCore(input, manifest, workflow);
		stopTeamHeartbeat();
		resolveRunPromise(manifest.runId, result);
		cleanupUsage();
		// Terminate live agents for this run — agents are done when the run ends.
		void terminateLiveAgentsForRun(manifest.runId, "completed", appendEvent, manifest.eventsPath).catch((error) => logInternalError("team-runner.completed.terminate", error, `runId=${manifest.runId}`));

		// Emit run completion hook (100% reliable, fire-and-forget)
		crewHooks.emit({ type: "run_completed", timestamp: new Date().toISOString(), runId: manifest.runId, data: { status: result.manifest.status, taskCount: result.tasks.length } });

		// Execute after_run_complete lifecycle hook (non-blocking)
		const afterRunReport = await executeHook("after_run_complete", { runId: manifest.runId, cwd: manifest.cwd, status: result.manifest.status });
		appendHookEvent(manifest, afterRunReport);
		if (afterRunReport.outcome === "block") {
			logInternalError("team-runner.after_run_complete.blocked", new Error(afterRunReport.reason ?? "after_run_complete hook blocked"), `runId=${manifest.runId}`);
		}

		return result;
	} catch (error) {
		// Round 27 (BUG 1): the success path calls stopTeamHeartbeat() but this
			// catch path did NOT. The team heartbeat is a non-unref'd setInterval
			// (30s) that deliberately keeps the event loop alive — without this
			// call, a failed team run leaves the interval firing forever and the
			// foreground pi process hangs (never returns to the prompt); in
			// background-runner mode the worker never exits. clearInterval is
			// idempotent so a double-call (if this runs after the success path)
			// is harmless.
		stopTeamHeartbeat();
		// P1: Catch unhandled errors — ensure manifest/tasks/agents are terminal so they don't stay "running" forever.
		const message = error instanceof Error ? error.message : String(error);
		// Reload manifest with lock to avoid stale data overwriting concurrent writes.
		// If lock acquisition fails, use in-memory data rather than stale disk data.
		let loaded;
		try {
			loaded = await withRunLock(input.manifest, async () => loadRunManifestById(input.manifest.cwd, input.manifest.runId));
		} catch {
			loaded = undefined; // best-effort: use in-memory data if lock fails
		}
		const freshManifest = loaded?.manifest ?? manifest;
		const freshTasks = refreshTaskGraphQueues(loaded?.tasks ?? input.tasks);
		const failedAt = new Date().toISOString();
		const tasks = freshTasks.map((task) =>
			task.status === "running" || task.status === "queued" || task.status === "waiting"
				? { ...task, status: "failed" as const, finishedAt: failedAt, error: message }
				: task,
		);
		manifest = freshManifest;
		try {
			await terminateLiveAgentsForRun(manifest.runId, "failed", appendEvent, manifest.eventsPath);
			await saveRunTasksAsync(manifest, tasks);
			const existingRuntimeByTask = new Map(readCrewAgents(manifest).map((agent) => [agent.taskId, agent.runtime]));
			const globalRuntime = input.runtime?.kind ?? "child-process";
			const runtimeForAgent = (agent: ReturnType<typeof recordsForMaterializedTasks>[number]): CrewRuntimeKind => {
				const task = tasks.find((item) => item.id === agent.taskId);
				return existingRuntimeByTask.get(agent.taskId) ?? resolveTaskRuntimeKind(globalRuntime, task?.role ?? agent.role, input.runtimeConfig?.isolationPolicy);
			};
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, globalRuntime).map((agent) => ({ ...agent, runtime: runtimeForAgent(agent) })));
			manifest = updateRunStatus(manifest, "failed", `Unhandled error in team runner: ${message}`);
			await saveRunManifestAsync(manifest);
		} catch {
			// Best-effort — state write may also fail
		}
		const result = { manifest, tasks };
		rejectRunPromise(manifest.runId, error instanceof Error ? error : new Error(message));
		crewHooks.emit({ type: "run_failed", timestamp: new Date().toISOString(), runId: manifest.runId, data: { status: manifest.status, error: message } });
		cleanupUsage();
		return result;
	}
}

async function executeTeamRunCore(
	input: ExecuteTeamRunInput,
	manifest: TeamRunManifest,
	workflow: WorkflowConfig,
): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	// Execute before_run_start hook (non-blocking by default)
	const beforeRunReport = await executeHook("before_run_start", { runId: manifest.runId, cwd: manifest.cwd });
	appendHookEvent(manifest, beforeRunReport);
	if (beforeRunReport.outcome === "block") {
		manifest = updateRunStatus(manifest, "blocked", beforeRunReport.reason ?? "before_run_start hook blocked the run.");
		return { manifest, tasks: input.tasks };
	}
	let tasks = refreshTaskGraphQueues(input.tasks);
	let queueIndex = buildTaskGraphIndex(tasks);
	const canInjectAdaptivePlan = workflow.name === "implementation";
	let adaptivePlanInjected = false;
	let adaptivePlanMissing = false;
	const attemptAdaptivePlan = () => {
		if (!canInjectAdaptivePlan || adaptivePlanInjected || adaptivePlanMissing) return { injected: false, missing: false };
		const adaptivePlan = injectAdaptivePlanIfReady({ manifest, tasks, workflow, team: input.team });
		adaptivePlanInjected = adaptivePlanInjected || adaptivePlan.injected;
		adaptivePlanMissing = adaptivePlan.missingPlan;
		workflow = adaptivePlan.workflow;
		if (adaptivePlan.injected) tasks = adaptivePlan.tasks;
		return { injected: adaptivePlan.injected, missing: adaptivePlan.missingPlan };
	};
	const initialAdaptive = attemptAdaptivePlan();
	if (initialAdaptive.missing) {
		tasks = markBlocked(tasks, "Adaptive planner did not produce a valid subagent plan.");
		await saveRunTasksAsync(manifest, tasks);
		manifest = updateRunStatus(manifest, "blocked", "Adaptive planner did not produce a valid subagent plan.");
		return { manifest, tasks };
	}
	if (initialAdaptive.injected) {
		manifest = requiresPlanApproval(workflow, input.runtimeConfig) ? ensurePlanApprovalRequested(manifest, tasks) : manifest;
		queueIndex = buildTaskGraphIndex(tasks);
	} else if (requiresPlanApproval(workflow, input.runtimeConfig) && (hasPendingMutatingAdaptiveTask(tasks) || hasPendingMutatingTaskAtBoundary(tasks))) {
		manifest = ensurePlanApprovalRequested(manifest, tasks);
	}
	if (manifest.planApproval?.status === "cancelled") {
		tasks = cancelPlanTasks(tasks, "Plan approval was cancelled.");
		await saveRunTasksAsync(manifest, tasks);
		manifest = updateRunStatus(manifest, "cancelled", "Plan approval was cancelled.");
		return { manifest, tasks };
	}
	manifest = writeProgress(manifest, tasks, "team-runner", input.executeWorkers, input.runtimeConfig);
	await saveRunManifestAsync(manifest);
	const runtimeKind = input.runtime?.kind ?? (input.executeWorkers ? "child-process" : "scaffold");
	saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));

	// Build a workflow phase state machine from workflow steps for precondition tracking.
	const workflowPhases: PhaseState[] = workflow.steps.map((step): PhaseState => ({
		name: step.id,
		status: "pending",
		inputs: step.reads === false ? [] : Array.isArray(step.reads) ? step.reads : [],
		outputs: step.output === false ? [] : step.output ? [step.output] : [],
	}));
	let wfMachine = createWorkflowStateMachine(workflowPhases);

	while (tasks.some((task) => task.status === "queued")) {
		if (input.signal?.aborted) {
			const cancelReason = cancellationReasonFromSignal(input.signal);
			const message = `${cancelReason.message} (${cancelReason.code})`;
			const cancelledTaskIds: string[] = [];
			tasks = tasks.map((task) => {
				if (task.status !== "queued" && task.status !== "running" && task.status !== "waiting") return task;
				cancelledTaskIds.push(task.id);
				const base = { ...task, status: "cancelled" as const, finishedAt: new Date().toISOString(), error: message };
				if (task.status === "running") {
					return { ...base, terminalEvidence: [...(task.terminalEvidence ?? []), buildSyntheticTerminalEvidence("worker", cancelReason, task.startedAt)] };
				}
				return base;
			});
			await saveRunTasksAsync(manifest, tasks);
			for (const taskId of cancelledTaskIds) await appendEventAsync(manifest.eventsPath, { type: "task.cancelled", runId: manifest.runId, taskId, message, data: { reason: cancelReason.code } });
			manifest = updateRunStatus(manifest, "cancelled", message, { data: { reason: cancelReason.code, cancelledTaskIds } });
			return { manifest, tasks };
		}

		const failed = tasks.find((task) => task.status === "failed");
		if (failed) {
			tasks = markBlocked(tasks, `Blocked by failed task '${failed.id}'.`);
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "failed", `Failed at task '${failed.id}'.`);
			return { manifest, tasks };
		}

		const snapshot = taskGraphSnapshot(tasks, queueIndex);

		// DAG-based execution plan: when tasks have explicit dependsOn, use the
		// topological wave planner to determine ready tasks. Fall back to the
		// existing task-graph-scheduler when no explicit deps exist (backward compat).
		const completedIds = new Set(tasks.filter((t) => t.status === "completed" || t.status === "needs_attention").map((t) => t.id));
		const dagReady = dagReadyTaskIds(tasks, completedIds);
		const effectiveReady = dagReady ?? snapshot.ready;

		// Workflow phase precondition check (non-blocking: log warnings only).
		if (wfMachine.currentPhaseIndex < wfMachine.phases.length) {
			const completedArtifacts = manifest.artifacts.filter((a) => a.kind === "result" || a.kind === "summary").map((a) => a.path);
			const previousPhaseStatus = wfMachine.currentPhaseIndex > 0 ? (wfMachine.phases[wfMachine.currentPhaseIndex - 1]?.status ?? "pending") : "completed";
			const wfContext: PhaseGuardContext = {
				completedArtifacts,
				previousPhaseStatus,
				taskResults: tasks.filter((t) => t.status === "completed" || t.status === "needs_attention").map((t) => ({ taskId: t.id, status: t.status, outputPath: t.resultArtifact?.path })),
			};
			const preconditions = validatePhasePreconditions(wfMachine, wfContext);
			if (!preconditions.ready) {
				await appendEventAsync(manifest.eventsPath, { type: "workflow.preconditions", runId: manifest.runId, message: `Workflow phase '${wfMachine.phases[wfMachine.currentPhaseIndex]?.name}' is missing inputs: ${preconditions.blocking.join(", ")}`, data: { phaseIndex: wfMachine.currentPhaseIndex, phaseName: wfMachine.phases[wfMachine.currentPhaseIndex]?.name, blocking: preconditions.blocking } });
			} else {
				// Advance the machine past completed phases.
				while (wfMachine.currentPhaseIndex < wfMachine.phases.length && wfMachine.phases[wfMachine.currentPhaseIndex]?.status === "completed") {
					wfMachine = { ...wfMachine, currentPhaseIndex: wfMachine.currentPhaseIndex + 1 };
				}
			}
		}

		const readyRoles = effectiveReady.map((taskId) => tasks.find((task) => task.id === taskId)?.role).filter((role): role is string => Boolean(role));
		const concurrency = resolveBatchConcurrency({ workflowName: workflow.name, workflowMaxConcurrency: workflow.maxConcurrency, teamMaxConcurrency: input.team.maxConcurrency, limitMaxConcurrentWorkers: input.limits?.maxConcurrentWorkers, allowUnboundedConcurrency: input.limits?.allowUnboundedConcurrency, readyCount: effectiveReady.length, workspaceMode: manifest.workspaceMode, readyRoles });
		if (concurrency.reason.includes(";unbounded:")) {
			await appendEventAsync(manifest.eventsPath, { type: "limits.unbounded", runId: manifest.runId, message: "Unbounded worker concurrency was explicitly enabled for this run.", data: { concurrencyReason: concurrency.reason, maxConcurrent: concurrency.maxConcurrent } });
		}
		const approvalPending = isPlanApprovalPending(manifest);
		const readyIds = approvalPending ? effectiveReady : effectiveReady.slice(0, concurrency.selectedCount);
		const candidateBatch = readyIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is TeamTaskState => Boolean(task));
		const readyBatch = approvalPending ? candidateBatch.filter((task) => !isMutatingTask(task)).slice(0, concurrency.selectedCount) : candidateBatch;
		if (readyBatch.length === 0) {
			if (approvalPending && candidateBatch.some(isMutatingTask)) {
				await saveRunTasksAsync(manifest, tasks);
				saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
				manifest = updateRunStatus(manifest, "blocked", "Plan approval required before mutating implementation tasks run.");
				return { manifest, tasks };
			}
			tasks = markBlocked(tasks, "No ready queued task; dependency graph may be invalid.");
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "blocked", "No ready queued task.");
			return { manifest, tasks };
		}

		// 2.2 caller migration: batch progress is high-frequency informational.
		appendEventFireAndForget(manifest.eventsPath, { type: "task.progress", runId: manifest.runId, message: `Starting ready batch with ${readyBatch.length} task(s).`, data: { taskIds: readyBatch.map((task) => task.id), readyCount: snapshot.ready.length, blockedCount: snapshot.blocked.length, runningCount: snapshot.running.length, doneCount: snapshot.done.length, selectedCount: readyBatch.length, maxConcurrent: concurrency.maxConcurrent, defaultConcurrency: concurrency.defaultConcurrency, concurrencyReason: approvalPending ? `${concurrency.reason};plan-approval-read-only` : concurrency.reason } });
		// Execute before_task_start hooks for the batch
		for (const task of readyBatch) {
			const taskReport = await executeHook("before_task_start", { runId: manifest.runId, taskId: task.id, cwd: manifest.cwd });
			appendHookEvent(manifest, taskReport);
			if (taskReport.outcome === "block") {
				tasks = tasks.map((t) => t.id === task.id ? { ...t, status: "skipped" as const, error: taskReport.reason ?? "before_task_start hook blocked execution." } : t);
				manifest = updateRunStatus(manifest, manifest.status, `Task '${task.id}' blocked by hook.`);
			}
		}
		const batchTasks = readyBatch.filter((task) => tasks.find((t) => t.id === task.id && t.status !== "skipped"));
		if (batchTasks.length > 1) {
			await appendEventAsync(manifest.eventsPath, { type: "task.parallel_start", runId: manifest.runId, message: `Launching ${batchTasks.length} tasks in PARALLEL (concurrency=${concurrency.selectedCount}): ${batchTasks.map((t) => `${t.role}(${t.id})`).join(", ")}`, data: { taskIds: batchTasks.map((t) => t.id), roles: batchTasks.map((t) => t.role), concurrency: concurrency.selectedCount } });
		}
		const results = await mapConcurrent(
			batchTasks,
			concurrency.selectedCount,
			async (task) => {
				const step = findStep(workflow, task);
				const agent = findAgent(input.agents, task);
				const teamRole = input.team.roles.find((role) => role.name === task.role);
				const perTaskRuntime = resolveTaskRuntimeKind(runtimeKind, task.role, input.runtimeConfig?.isolationPolicy);
				const baseInput = { manifest, tasks, task, step, agent, signal: input.signal, executeWorkers: input.executeWorkers, runtimeKind: runtimeKind, taskRuntimeOverride: perTaskRuntime !== runtimeKind ? perTaskRuntime : undefined, runtimeConfig: input.runtimeConfig, parentContext: input.parentContext, parentModel: input.parentModel, modelRegistry: input.modelRegistry, modelOverride: input.modelOverride, teamRoleModel: teamRole?.model, teamRoleSkills: teamRole?.skills, skillOverride: input.skillOverride, limits: input.limits, onJsonEvent: input.onJsonEvent, workspaceId: input.workspaceId };
				// #1 (assessment): autoRetry now defaults ON (opt-out via reliability.autoRetry=false).
				// The dominant v0.9.13 failure was ChildTimeout ("worker became unresponsive") with
				// ZERO retries because this gate was opt-in. isRetryable() defaults to true when
				// retryableErrors is empty, so transient hangs now retry up to maxAttempts (3) with
				// exponential backoff. Set reliability.autoRetry=false to restore old single-shot behavior.
				if (!shouldUseRetry(input.reliability)) return withCorrelation(childCorrelation(manifest.runId, task.id), () => runTeamTask(baseInput));
				let lastFailed: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
				let lastAttemptId: string | undefined;
				const attemptsSoFar: TaskAttemptState[] = [...(task.attempts ?? [])];
				const policy = retryPolicyFromConfig(input.reliability);
				try {
					return await executeWithRetry(async (attempt, info) => {
						const startedAt = new Date().toISOString();
						const inFlightAttempts: TaskAttemptState[] = [...attemptsSoFar, { attemptId: info.attemptId, startedAt }];
						input.metricRegistry?.counter("crew.task.retry_attempt_total", "Retry attempts by run and task").inc({ runId: manifest.runId, taskId: task.id });
						// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
						const fresh = loadRunManifestById(manifest.cwd, manifest.runId);
						const freshManifest = fresh?.manifest ?? manifest;
						const freshTasks = fresh?.tasks ?? tasks;
						const freshTask = freshTasks.find((item) => item.id === task.id) ?? task;
						if (freshTask.status !== "queued" && freshTask.status !== "running") return { manifest: freshManifest, tasks: freshTasks };
						const taskWithAttempt: TeamTaskState = { ...freshTask, attempts: inFlightAttempts };
						const result = await withCorrelation(childCorrelation(freshManifest.runId, task.id), () => runTeamTask({ ...baseInput, manifest: freshManifest, tasks: freshTasks, task: taskWithAttempt }));
						const failed = failedTaskFrom(result, task.id);
						const endedAt = new Date().toISOString();
						const finishedAttempt: TaskAttemptState = { attemptId: info.attemptId, startedAt, endedAt, ...(failed?.error ? { error: failed.error } : {}) };
						attemptsSoFar.push(finishedAttempt);
						const withAttempt = result.tasks.map((item) => item.id === task.id ? { ...item, attempts: [...attemptsSoFar] } : item);
						const enriched = { manifest: result.manifest, tasks: withAttempt };
						if (failed) {
							lastFailed = enriched;
							throw new Error(failed.error ?? `Task ${task.id} failed.`);
						}
						input.metricRegistry?.histogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]).observe({ runId: manifest.runId, team: input.team.name }, Math.max(0, attempt - 1));
						return enriched;
					}, policy, {
						signal: input.signal,
						attemptId: (attempt) => `${manifest.runId}:${task.id}:attempt-${attempt}`,
						onAttemptFailed: (attempt, error, delayMs, info) => {
							lastAttemptId = info.attemptId;
							appendEventAsync(manifest.eventsPath, { type: "crew.task.retry_attempt", runId: manifest.runId, taskId: task.id, message: error.message, data: { attempt, attemptId: info.attemptId, delayMs }, metadata: { attemptId: info.attemptId } }).catch((error) => logInternalError("team-runner.retry-attempt", error, `taskId=${task.id}`));
							input.metricRegistry?.histogram("crew.task.retry_delay_ms", "Retry backoff delay, milliseconds").observe({ runId: manifest.runId, taskId: task.id }, delayMs);
						},
						onRetryGivenUp: (attempts, error, info) => {
							lastAttemptId = info.attemptId;
							appendDeadletter(manifest, { runId: manifest.runId, taskId: task.id, reason: "max-retries", attempts, attemptId: info.attemptId, lastError: error.message, timestamp: new Date().toISOString() });
							input.metricRegistry?.counter("crew.task.deadletter_total", "Deadletter triggers by reason").inc({ reason: "max-retries" });
							input.metricRegistry?.histogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]).observe({ runId: manifest.runId, team: input.team.name }, Math.max(0, attempts - 1));
						},
					});
				} catch (retryError) {
					if (retryError instanceof CrewCancellationError || input.signal?.aborted) {
						const reason = retryError instanceof CrewCancellationError ? retryError.reason : cancellationReasonFromSignal(input.signal);
						// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
						const fresh = loadRunManifestById(manifest.cwd, manifest.runId);
						const freshManifest = fresh?.manifest ?? manifest;
						const freshTasks = fresh?.tasks ?? tasks;
						const cancelledTasks = freshTasks.map((item) => item.id === task.id && (item.status === "queued" || item.status === "running") ? { ...item, status: "cancelled" as const, finishedAt: new Date().toISOString(), error: `${reason.message} (${reason.code})` } : item);
						appendEventAsync(freshManifest.eventsPath, { type: "task.cancelled", runId: freshManifest.runId, taskId: task.id, message: reason.message, data: { reason, phase: "retry" }, metadata: lastAttemptId ? { attemptId: lastAttemptId } : undefined }).catch((error) => logInternalError("team-runner.cancelled", error, `taskId=${task.id}`));
						return { manifest: updateRunStatus(freshManifest, "cancelled", reason.message), tasks: cancelledTasks };
					}
					if (lastFailed) return lastFailed;
					// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
					const fresh = loadRunManifestById(manifest.cwd, manifest.runId);
					const freshManifest = fresh?.manifest ?? manifest;
					const freshTasks = fresh?.tasks ?? tasks;
					const freshTask = freshTasks.find((item) => item.id === task.id) ?? task;
					if (freshTask.status !== "queued" && freshTask.status !== "running") return { manifest: freshManifest, tasks: freshTasks };
					return withCorrelation(childCorrelation(freshManifest.runId, task.id), () => runTeamTask({ ...baseInput, manifest: freshManifest, tasks: freshTasks, task: freshTask }));
				}
			},
		);
		if (results.length === 0) break;
		// FIX: Filter out undefined entries from partial results when error occurred
		// during parallel execution. Other workers may have written partial results
		// before one threw. Results may be partial - some tasks in-flight at error
		// time will not have entries in the results array.
		const validResults = results.filter((item): item is NonNullable<typeof item> => item !== undefined);
		// Guard: if ALL parallel workers threw before returning, validResults is empty.
		// at(-1)! would crash. Mark the run failed rather than crashing.
		if (validResults.length === 0) {
			manifest = updateRunStatus(manifest, "failed", "All parallel tasks failed catastrophically.");
			return { manifest, tasks };
		}
		// Reconstruct manifest from the last worker's snapshot. The .artifacts field
// is re-merged from both the team-runner's in-memory state and all workers'
// snapshots, so artifact writes by task-runner (which individually save manifest
// after writing artifacts) are safely persisted. The in-memory manifest is only
// used for the next batch iteration's orchestration — actual persistence is safe.
// Use updateRunStatus to recompute manifest status from merged tasks rather than
// relying on the last result's manifest (which is arbitrary due to mapConcurrent
// returning results in arbitrary order).
// Use the in-memory manifest as base (not the last-completing worker's snapshot).
// Recompute status from merged tasks so the manifest reflects actual task state,
// not the arbitrary order in which mapConcurrent returned results.
// Read committed manifest from disk inside the lock so artifact merge is based
// on committed state, not in-memory state that may differ from disk.
const mergeResult = await withRunLock(manifest, async () => {
    const disk = loadRunManifestById(manifest.cwd, manifest.runId);
    const diskManifest = disk?.manifest ?? manifest;
    const diskArtifacts = diskManifest.artifacts;
    const reconciledArtifacts = mergeArtifacts([...diskArtifacts, ...validResults.map((item) => item.manifest.artifacts)].flat());
    const resultManifest = updateRunStatus({ ...diskManifest, artifacts: reconciledArtifacts }, "running", "Merged task updates from parallel batch.");
    const resultTasks = mergeTaskUpdatesPreservingTerminal(tasks, validResults);
    await saveRunManifestAsync(resultManifest);
    await saveRunTasksAsync(resultManifest, resultTasks);
    return { resultManifest, resultTasks };
});
manifest = mergeResult.resultManifest;
tasks = mergeResult.resultTasks;

		// Advance workflow phases whose tasks are all in terminal state
		const terminalStatuses = new Set(["completed", "failed", "skipped", "cancelled", "needs_attention"]);
		const phaseTaskMap = new Map<string, string[]>();
		for (const task of tasks) {
			if (!task.stepId) continue;
			const existing = phaseTaskMap.get(task.stepId) ?? [];
			existing.push(task.id);
			phaseTaskMap.set(task.stepId, existing);
		}
		for (let pi = wfMachine.currentPhaseIndex; pi < wfMachine.phases.length; pi++) {
			const phase = wfMachine.phases[pi]!;
			const phaseTaskIds = phaseTaskMap.get(phase.name) ?? [];
			if (phaseTaskIds.length === 0) continue;
			const allTerminal = phaseTaskIds.every((taskId) => {
				const task = tasks.find((t) => t.id === taskId);
				return task ? terminalStatuses.has(task.status) : false;
			});
			if (!allTerminal) break;
			if (phase.status !== "completed" && phase.status !== "failed" && phase.status !== "skipped") {
				const completedArtifacts = manifest.artifacts.filter((a) => a.kind === "result" || a.kind === "summary").map((a) => a.path);
				const previousPhaseStatus = pi > 0 ? (wfMachine.phases[pi - 1]?.status ?? "pending") : "completed";
				const wfContext: PhaseGuardContext = {
					completedArtifacts,
					previousPhaseStatus,
					taskResults: tasks.filter((t) => t.status === "completed" || t.status === "needs_attention").map((t) => ({ taskId: t.id, status: t.status, outputPath: t.resultArtifact?.path })),
				};
				// Determine phase transition status based on individual task outcomes
				const phaseTasks = phaseTaskIds.map((taskId) => tasks.find((t) => t.id === taskId)).filter((t): t is NonNullable<typeof t> => t !== undefined);
				const hasFailedOrCancelled = phaseTasks.some((t) => t.status === "failed" || t.status === "cancelled");
				const phaseStatus = hasFailedOrCancelled ? "failed" : "completed";
				const transition = transitionPhase(wfMachine, pi, phaseStatus, wfContext);
				wfMachine = transition.machine;
				if (transition.guardResult && !transition.guardResult.allowed) {
					await appendEventAsync(manifest.eventsPath, { type: "workflow.phase_guard_blocked", runId: manifest.runId, message: `Workflow phase '${phase.name}' guard blocked: ${transition.guardResult.reason ?? "unknown"}`, data: { phaseIndex: pi, phaseName: phase.name, reason: transition.guardResult.reason } });
					break;
				}
				await appendEventAsync(manifest.eventsPath, { type: phaseStatus === "failed" ? "workflow.phase_failed" : "workflow.phase_completed", runId: manifest.runId, message: `Workflow phase '${phase.name}' ${phaseStatus}.`, data: { phaseIndex: pi, phaseStatus } });
			}
			wfMachine = { ...wfMachine, currentPhaseIndex: pi + 1 };
		}

		const cancelledResult = results.find((item) => item.manifest.status === "cancelled");
		if (cancelledResult || input.signal?.aborted) {
			const reason = input.signal?.aborted ? cancellationReasonFromSignal(input.signal) : undefined;
			const message = reason?.message ?? cancelledResult?.manifest.summary ?? "Run cancelled during task execution.";
			manifest = { ...manifest, status: "running" };
			manifest = updateRunStatus(manifest, "cancelled", message);
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			await saveRunManifestAsync(manifest);
			await appendEventAsync(manifest.eventsPath, { type: "run.cancelled", runId: manifest.runId, message, data: { reason, phase: "task-batch", cancelledResultRunId: cancelledResult?.manifest.runId } });
			return { manifest, tasks };
		}
		queueIndex = buildTaskGraphIndex(tasks);
		const injectedAfterBatch = attemptAdaptivePlan();
		if (injectedAfterBatch.missing) {
			tasks = markBlocked(tasks, "Adaptive planner did not produce a valid subagent plan.");
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "blocked", "Adaptive planner did not produce a valid subagent plan.");
			return { manifest, tasks };
		}
		if (injectedAfterBatch.injected) {
			manifest = requiresPlanApproval(workflow, input.runtimeConfig) ? ensurePlanApprovalRequested(manifest, tasks) : manifest;
			queueIndex = buildTaskGraphIndex(tasks);
		} else if (requiresPlanApproval(workflow, input.runtimeConfig) && (hasPendingMutatingAdaptiveTask(tasks) || hasPendingMutatingTaskAtBoundary(tasks))) {
			manifest = ensurePlanApprovalRequested(manifest, tasks);
		}
		if (manifest.planApproval?.status === "cancelled") {
			tasks = cancelPlanTasks(tasks, "Plan approval was cancelled.");
			await saveRunTasksAsync(manifest, tasks);
			saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			manifest = updateRunStatus(manifest, "cancelled", "Plan approval was cancelled.");
			return { manifest, tasks };
		}
		await saveRunTasksAsync(manifest, tasks);
		saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
		const completedBatch = tasks.filter((t) => batchTasks.some((bt) => bt.id === t.id));
		const batchArtifact = writeArtifact(manifest.artifactsRoot, {
			kind: "summary",
			relativePath: `batches/${batchTasks.map((task) => task.id).join("+")}.md`,
			producer: "team-runner",
			content: aggregateTaskOutputs(completedBatch, manifest),
		});
		const groupDelivery = deliverGroupJoin({ manifest, mode: resolveGroupJoinMode(input.runtimeConfig), batch: batchTasks, allTasks: tasks });
		manifest = { ...manifest, artifacts: mergeArtifacts([...manifest.artifacts, batchArtifact, ...(groupDelivery?.artifact ? [groupDelivery.artifact] : [])]) };
		manifest = writeProgress(manifest, tasks, "team-runner", input.executeWorkers, input.runtimeConfig);
		await saveRunManifestAsync(manifest);
	}

	const failed = tasks.find((task) => task.status === "failed");
	const waiting = tasks.find((task) => task.status === "waiting");
	const running = tasks.find((task) => task.status === "running");
	manifest = applyPolicy(manifest, tasks, input.limits);
	const effectiveness = evaluateRunEffectiveness({ manifest, tasks, executeWorkers: input.executeWorkers, runtimeConfig: input.runtimeConfig });
	const effectivenessDecision = effectivenessPolicyDecision(effectiveness);
	if (effectivenessDecision) {
		manifest = { ...manifest, policyDecisions: [...(manifest.policyDecisions ?? []), effectivenessDecision], updatedAt: new Date().toISOString() };
		await appendEventAsync(manifest.eventsPath, { type: "run.effectiveness", runId: manifest.runId, message: effectivenessDecision.message, data: { effectiveness, policyDecision: effectivenessDecision } });
	}
	const blockingDecision = manifest.policyDecisions?.find((item) => item.action === "block" || item.action === "escalate");
	if (failed) {
		manifest = updateRunStatus(manifest, "failed", `Failed at task '${failed.id}'.`);
	} else if (waiting) {
		manifest = updateRunStatus(manifest, "blocked", `Waiting for response to task '${waiting.id}'.`);
	} else if (running) {
		manifest = updateRunStatus(manifest, "blocked", `Task '${running.id}' is still running.`);
	} else if (effectiveness.severity === "failed") {
		manifest = updateRunStatus(manifest, "failed", effectivenessDecision?.message ?? "Run effectiveness guard failed.");
	} else if (effectiveness.severity === "blocked") {
		manifest = updateRunStatus(manifest, "blocked", effectivenessDecision?.message ?? "Run effectiveness guard blocked completion.");
	} else if (blockingDecision) {
		manifest = updateRunStatus(manifest, "blocked", blockingDecision.message);
	} else {
		manifest = updateRunStatus(manifest, "completed", input.executeWorkers ? "Team workflow completed." : "Team workflow scaffold completed without launching child workers.");
	}
	manifest = writeProgress(manifest, tasks, "team-runner", input.executeWorkers, input.runtimeConfig);
	await saveRunManifestAsync(manifest);
	const usage = aggregateUsage(tasks);
	const summaryArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "summary",
		relativePath: "summary.md",
		producer: "team-runner",
		content: [
			`# pi-crew run ${manifest.runId}`,
			"",
			`Status: ${manifest.status}`,
			`Team: ${manifest.team}`,
			`Workflow: ${manifest.workflow ?? "(none)"}`,
			`Goal: ${manifest.goal}`,
			`Usage: ${formatUsage(usage)}`,
			"",
			"## Tasks",
			...tasks.map(formatTaskProgress),
			"",
			"## Effectiveness",
			...runEffectivenessLines(manifest, tasks, input.executeWorkers, input.runtimeConfig),
			"",
			"## Policy decisions",
			...(manifest.policyDecisions?.length ? summarizePolicyDecisions(manifest.policyDecisions) : ["- (none)"]),
			"",
		].join("\n"),
	});
	// Build the complete manifest BEFORE acquiring the lock so the artifacts array
	// is already incorporated into the manifest object that will be atomically written.
	// This prevents crash-between-mutation-and-lock from leaving inconsistent state.
	const finalManifest = { ...manifest, updatedAt: new Date().toISOString(), artifacts: [...manifest.artifacts, summaryArtifact] };
	// Joint atomic save: wrap manifest + tasks in a single run lock so they are
	// written together or not at all. Crash between separate saveRunManifestAsync
	// and saveRunTasksAsync calls could leave manifest/tasks.json out of sync.
	await withRunLock(finalManifest, async () => {
		await saveRunManifestAsync(finalManifest);
		await saveRunTasksAsync(finalManifest, tasks);
	});
	manifest = finalManifest;
	// Save health snapshot on run completion.
	// BUG A (pts/2 hang investigation 2026-06-16): stateRoot = `<crewRoot>/state/runs/<runId>`,
	// so the crew root is THREE dirnames up, not two. Two dirnames gave `<crewRoot>/state`
	// (the state dir), and HealthStore then joined HEALTH_DIR (`.crew/state/health`)
	// onto it → `<crewRoot>/state/.crew/state/health` — a double-joined BOGUS path.
	// That wrote health snapshots to a nonexistent subtree (silently breaking the
	// health feature) AND created junk dirs that the recursive state watcher then
	// attached extra inotify watches to. Fix: compute the real crew root (3 up)
	// and make HEALTH_DIR relative to it.
	const crewRoot = path.dirname(path.dirname(path.dirname(finalManifest.stateRoot)));
	const healthStore = new HealthStore(crewRoot);
	healthStore.saveSnapshot({
		runId: finalManifest.runId,
		tasks: tasks.map((t) => ({ id: t.id, status: t.status })),
		createdAt: finalManifest.createdAt,
	});
	return { manifest, tasks };
}
