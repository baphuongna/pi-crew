import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewReliabilityConfig, CrewRuntimeConfig } from "../config/config.ts";
import { CrewError, ErrorCode } from "../errors.ts";
import { appendHookEvent, executeHook } from "../hooks/registry.ts";
import { childCorrelation, withCorrelation } from "../observability/correlation.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { atomicWriteFile, flushPendingAtomicWrites } from "../state/atomic-write.ts";
import { canTransitionRunStatus, TEAM_TASK_STATUSES, TEAM_TERMINAL_TASK_STATUSES, type TeamTaskStatus } from "../state/contracts.ts";
import { withRunLock } from "../state/coordination/locks.ts";
import {
	appendEvent,
	appendEventAsync,
	appendEventBuffered,
	appendEventFireAndForget,
	flushEventLogBuffer,
} from "../state/event-log/event-log.ts";
import { hashArtifactContent as hashContent, writeArtifact } from "../state/stores/artifact-store.ts";
import { HealthStore } from "../state/stores/health-store.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { ArtifactDescriptor, PolicyDecision, TaskAttemptState, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { aggregateUsage, formatTokens, formatUsage } from "../state/usage.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { WorkflowConfig, WorkflowStep } from "../workflows/workflow-config.ts";
import { checkBranchFreshness } from "../worktree/branch-freshness.ts";
import { readCrewAgents, saveCrewAgents, saveCrewAgentsCoalesced } from "./crew-agent-records.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { crewHooks } from "./crew-hooks.ts";
import { appendDeadletter } from "./deadletter.ts";
import { effectivenessPolicyDecision, evaluateRunEffectiveness, formatRunEffectivenessLines } from "./effectiveness.ts";
import { applyGoalAchievement, assessGoalAchievement } from "./goal-workflow/goal-achievement.ts";
import { deliverGroupJoin, resolveGroupJoinMode } from "./group-join.ts";
import { terminateLiveAgentsForRun } from "./live-session/live-agent-manager.ts";
import { resolveTaskRuntimeKind } from "./model/runtime-policy.ts";
import type { CrewRuntimeCapabilities } from "./model/runtime-resolver.ts";
import { filterReadyByWriteOverlap } from "./path-overlap.ts";
import { evaluateCrewPolicy, summarizePolicyDecisions } from "./policy-engine.ts";
import { buildSyntheticTerminalEvidence, CrewCancellationError, cancellationReasonFromSignal } from "./process/cancellation.ts";
import { buildRecoveryLedger, shouldRerunFailedTask } from "./recovery/recovery-recipes.ts";
import { DEFAULT_RETRY_POLICY, executeWithRetry, type RetryPolicy } from "./recovery/retry-executor.ts";
import { permissionForRole } from "./role-permission.ts";
import { registerRunPromise, rejectRunPromise, resolveRunPromise } from "./run-tracker.ts";
import { buildDispatchUnits, type DispatchUnit, planCoalescedGroups } from "./scheduling/coalesce-tasks.ts";
import { type BatchConcurrencyDecision, resolveBatchConcurrency } from "./scheduling/concurrency.ts";
import { runCoalescedTaskGroup } from "./scheduling/run-coalesced-task-group.ts";
import { buildExecutionPlan as buildDagExecutionPlan, getReadyTasks as getDagReadyTasks, type TaskNode } from "./scheduling/task-graph.ts";
import {
	buildTaskGraphIndex,
	refreshTaskGraphQueues,
	type TaskGraphIndex,
	type TaskGraphSchedulerSnapshot,
	taskGraphSnapshot,
} from "./scheduling/task-graph-scheduler.ts";
import { recordsForMaterializedTasks } from "./task-display.ts";
import { aggregateTaskOutputs } from "./task-output-context.ts";
import { clearStablePrefixCache, computeStablePrefixComponents } from "./task-runner/prompt-builder.ts";
import { runTeamTask, type SpawnBudget } from "./task-runner.ts";
import { mergeArtifacts } from "./team-runner-artifacts.ts";
import { clearTrackedTaskUsage } from "./usage-tracker.ts";
import {
	createWorkflowStateMachine,
	type PhaseGuardContext,
	type PhaseState,
	transitionPhase,
	validatePhasePreconditions,
	type WorkflowStateMachine,
} from "./workflow-state.ts";

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
			atomicWriteFile(
				heartbeatPath,
				JSON.stringify({
					pid: process.pid,
					at: Date.now(),
					runId,
					kind: "team-runner",
					lastTaskUpdateAt: now,
				}),
				{ mode: 0o600 },
			);
		} catch {
			// best-effort
		}
	};
	writeHeartbeat();
	// NOTE: This interval is deliberately NOT unref'd. Unlike background-runner's
	// heartbeat and interrupt guard (both unref'd), the team heartbeat must keep
	// the event loop alive so the stale reconciler does not cancel long-running
	// team runs (>5 min) as "stale" while they are actively executing.
	// P13 (perf): tick every 60s instead of 30s. The stale-reconciler threshold
	// is 5min (300_000ms in crash-recovery.ts), so a 60s heartbeat still leaves
	// 5 ticks of slack before a run is misidentified as stale. Cuts the per-run
	// heartbeat.syscall count in half (1 write/30s → 1 write/60s) with no
	// behavioral change.
	const interval = setInterval(writeHeartbeat, 60_000);
	return () => clearInterval(interval);
}

// ─── Perf observability (auto-attach, toggle per team) ─────────────────────
// "Bộ đo luôn hoạt động khi pi-crew chạy": unless the team frontmatter says
// `observability: false`, every run spawns the external resource sampler
// (scripts/resource-sampler.mjs --watch-run — auto-resolves the runner PID
// from state and auto-stops when the runner dies) and, after completion,
// runs analyze-run to emit the perf report. Both are detached child
// processes so a failure in the tooling never affects the run itself.
const OBSERVABILITY_INTERVAL_MS = 2000;
const OBSERVABILITY_ANALYZE_DELAY_MS = 3000;

function perfScriptPath(scriptName: string): string | undefined {
	try {
		// Two layouts: dev (src/runtime/team-runner.ts → ../../scripts) and
		// bundled (dist/index.mjs → ../scripts). Try both, use whichever exists.
		const candidates = [
			fileURLToPath(new URL(`../../scripts/${scriptName}`, import.meta.url)),
			fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url)),
		];
		return candidates.find((p) => fs.existsSync(p));
	} catch {
		return undefined;
	}
}

function startPerfSampler(manifest: TeamRunManifest, team: TeamConfig): void {
	// DIRECT fs marker (console may be swallowed by the host) — every branch
	// writes artifacts/<runId>/perf-obs.log with the exact reason.
	const marker = (msg: string): void => {
		try {
			fs.appendFileSync(path.join(manifest.artifactsRoot, "perf-obs.log"), `[${new Date().toISOString()}] ${msg}\n`);
		} catch {
			/* best-effort */
		}
	};
	marker(`startPerfSampler entered (team=${team.name} observability=${String(team.observability)} importMetaUrl=${import.meta.url})`);
	// Strict true: parsed team files default observability to true (parseTeamFile),
	// while direct-object TeamConfig fixtures (unit tests) stay undefined and
	// therefore do NOT spawn the sampler — keeps test isolation.
	if (team.observability !== true) {
		marker(`SKIP: observability=${String(team.observability)} !== true`);
		return;
	}
	const samplerPath = perfScriptPath("resource-sampler.mjs");
	if (!samplerPath) {
		marker(`SKIP: resource-sampler.mjs not found (importMetaUrl=${import.meta.url})`);
		return;
	}
	marker(`spawning sampler from ${samplerPath}`);
	const crewRoot = path.dirname(path.dirname(path.dirname(manifest.stateRoot)));
	const outPath = path.join(manifest.artifactsRoot, "resources.jsonl");
	const logPath = path.join(manifest.artifactsRoot, "perf-obs.log");
	try {
		const child = spawn(
			process.execPath,
			[
				"--experimental-strip-types",
				samplerPath,
				"--watch-run",
				manifest.runId,
				"--crew-root",
				crewRoot,
				"--interval",
				String(OBSERVABILITY_INTERVAL_MS),
				"--out",
				outPath,
			],
			{ detached: true, stdio: ["ignore", "ignore", "pipe"] },
		);
		// diagnostics: sampler stderr → perf-obs.log (best-effort; never affects the run)
		child.stderr?.on("data", (d: Buffer) => {
			try {
				fs.appendFileSync(logPath, String(d));
			} catch {
				/* best-effort */
			}
		});
		child.unref();
	} catch (err) {
		console.warn(`[perf-obs] sampler spawn failed for ${manifest.runId}: ${String(err)}`);
	}
}

function schedulePerfAnalyze(manifest: TeamRunManifest, team: TeamConfig): void {
	// Strict true — same test-isolation rationale as startPerfSampler.
	if (team.observability !== true) return;
	const analyzePath = perfScriptPath("analyze-run.mjs");
	const resourcesPath = path.join(manifest.artifactsRoot, "resources.jsonl");
	// Only analyze when the sampler actually produced data (sampler may have
	// been skipped/failed to spawn) AND the scripts exist.
	if (!analyzePath || !fs.existsSync(resourcesPath)) return;
	const crewRoot = path.dirname(path.dirname(path.dirname(manifest.stateRoot)));
	// Delay so child-worker transcripts are fully flushed before analyze reads them.
	const timer = setTimeout(() => {
		try {
			const child = spawn(
				process.execPath,
				["--experimental-strip-types", analyzePath, manifest.runId, "--crew-root", crewRoot, "--resources", resourcesPath],
				{ detached: true, stdio: "ignore" },
			);
			child.unref();
		} catch (err) {
			console.warn(`[perf-obs] analyze spawn failed for ${manifest.runId}: ${String(err)}`);
		}
	}, OBSERVABILITY_ANALYZE_DELAY_MS);
	timer.unref();
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
	/** Total token budget for the run. When set, enables per-task budget enforcement. */
	budgetTotal?: number;
	/** Budget warning threshold as a fraction (0-1). Default: 0.8 (80%). */
	budgetWarning?: number;
	/** Budget abort threshold as a fraction (0-1). Default: 0.95 (95%). */
	budgetAbort?: number;
	/** When true, skip budget enforcement entirely. */
	budgetUnlimited?: boolean;
}

/**
 * Result of a per-task budget check against cumulative run usage.
 */
export interface PerTaskBudgetCheckResult {
	/** Whether the abort threshold was exceeded. */
	abort: boolean;
	/** Whether the warning threshold was exceeded. */
	warning: boolean;
	/** IDs of tasks that exceeded their fair share (>50% of remaining budget). */
	fairShareViolators: string[];
	/** Total tokens used so far. */
	totalUsed: number;
}

/**
 * Check cumulative token usage against per-task budget thresholds.
 * Returns a structured result — callers decide how to act (warn vs abort).
 *
 * Exported for unit testing.
 */
export function checkPerTaskBudget(
	tasks: TeamTaskState[],
	budgetTotal: number,
	budgetWarning: number,
	budgetAbort: number,
	fairShareFraction = 0.5,
): PerTaskBudgetCheckResult {
	const usage = aggregateUsage(tasks);
	const totalUsed = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
	const abort = totalUsed >= budgetAbort * budgetTotal;
	const warning = !abort && totalUsed >= budgetWarning * budgetTotal;
	// Fair share threshold based on TOTAL budget, not remaining budget.
	// This ensures a task that consumed 60% of total budget is flagged even
	// if only 40% remains (40% * 50% = 20% threshold would miss the 60% usage).
	const fairShareThreshold = budgetTotal * fairShareFraction;
	const fairShareViolators: string[] = [];
	for (const task of tasks) {
		if (!task.usage) continue;
		const taskTotal = (task.usage.input ?? 0) + (task.usage.output ?? 0) + (task.usage.cacheWrite ?? 0);
		// Only flag tasks that individually consumed a significant portion of the
		// budget (>10% of total) AND exceeded the fair share threshold.
		if (fairShareThreshold > 0 && taskTotal > fairShareThreshold && taskTotal > budgetTotal * 0.1) {
			fairShareViolators.push(task.id);
		}
	}
	return { abort, warning, fairShareViolators, totalUsed };
}

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

function markBlocked(tasks: TeamTaskState[], reason: string): TeamTaskState[] {
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

function isNonTerminalTaskStatus(status: TeamTaskState["status"]): boolean {
	return status === "queued" || status === "running" || status === "waiting";
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

/**
 * RT-16: status-level gate for shouldMergeTaskUpdate. Returns the stable
 * "from->to" key used by REJECTED_STATUS_MERGE_TRANSITIONS.
 */
function statusMergeKey(from: TeamTaskStatus, to: TeamTaskStatus): string {
	return `${from}->${to}`;
}

/**
 * RT-16 — derived merge-gate transition table.
 *
 * The set of old->new status pairs that shouldMergeTaskUpdate must REJECT based
 * solely on the status transition (before any field-level comparison). It
 * replaces the former 13 hand-written status guards that hand-duplicated the
 * lifecycle table. Built once from the single source-of-truth table
 * (TEAM_TASK_STATUSES + TEAM_TERMINAL_TASK_STATUSES — the terminal half of
 * TEAM_TASK_STATUS_TRANSITIONS) plus two merge-specific policies that are
 * STRICTER than the lifecycle table on the parallel-merge path:
 *
 *  P1 Terminal preservation — every terminal->non-terminal pair is rejected.
 *    The lifecycle table permits retries (e.g. completed->queued), but a stale
 *    worker snapshot must never resurrect a settled task.
 *  P2 Completed integrity — five terminal->terminal flips that touch the
 *    "completed" success terminal are rejected: completed->failed,
 *    completed->needs_attention, failed->completed, cancelled->completed,
 *    needs_attention->completed. (completed may still move to
 *    cancelled/skipped; that is intentionally allowed, so these are NOT simply
 *    "every illegal terminal->terminal flip".)
 *  P3 waiting->running regression — the single stale-snapshot case.
 *
 * The decision for every old->new pair is byte-for-byte identical to the former
 * 7 status guards (verified exhaustively in
 * test/unit/team-runner-should-merge-table.test.ts).
 */
const REJECTED_STATUS_MERGE_TRANSITIONS: ReadonlySet<string> = (() => {
	const rejected = new Set<string>();
	// P1 — terminal preservation: reject every terminal->non-terminal pair.
	for (const from of TEAM_TASK_STATUSES) {
		if (!TEAM_TERMINAL_TASK_STATUSES.has(from)) continue;
		for (const to of TEAM_TASK_STATUSES) {
			if (!TEAM_TERMINAL_TASK_STATUSES.has(to)) rejected.add(statusMergeKey(from, to));
		}
	}
	// P3 — waiting->running stale-snapshot regression.
	rejected.add(statusMergeKey("waiting", "running"));
	// P2 — completed integrity flips (bespoke terminal->terminal policy).
	const completedIntegrityFlips: ReadonlyArray<[TeamTaskStatus, TeamTaskStatus]> = [
		["completed", "failed"],
		["completed", "needs_attention"],
		["failed", "completed"],
		["cancelled", "completed"],
		["needs_attention", "completed"],
	];
	for (const [from, to] of completedIntegrityFlips) rejected.add(statusMergeKey(from, to));
	return rejected;
})();

function shouldMergeTaskUpdate(current: TeamTaskState, updated: TeamTaskState): boolean {
	// RT-16: status-level gate — reject stale/dangerous transitions via the
	// derived transition table (REJECTED_STATUS_MERGE_TRANSITIONS) instead of
	// hand-written guards. Parallel workers receive the same input snapshot; a
	// later result may still carry stale copies. The table encodes three
	// merge-specific policies stricter than the lifecycle table: terminal
	// preservation (no terminal->non-terminal resurrection), completed integrity
	// (no flipping the "completed" success terminal to/from failed or
	// needs_attention), and the waiting->running stale-snapshot regression.
	if (REJECTED_STATUS_MERGE_TRANSITIONS.has(statusMergeKey(current.status, updated.status))) return false;
	// Guard: when current is "running" but has resultArtifact (another worker already
	// completed it), a stale updated with status="running" and no resultArtifact
	// must not overwrite the actual completed state.
	if (current.status === updated.status && updated.status === "running" && current.resultArtifact && !updated.resultArtifact)
		return false;
	// Guard: when current is "completed" and has resultArtifact but updated is also
	// "completed" without resultArtifact, block the stale update from overwriting
	// a task that successfully produced output.
	if (current.status === updated.status && current.status === "completed" && current.resultArtifact && !updated.resultArtifact)
		return false;
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
/** Exposed for the exhaustive status-merge table test (RT-16). */
export const __test__shouldMergeTaskUpdate = shouldMergeTaskUpdate;

// H4 fix: rename to descriptive name. Kept __test__ as alias for backward
// compat test imports.
// FIX (perf P10): replace O(N×M) .find() + .map() inside nested loops with a
// single-pass Map-based merge. Build an index of `merged` once, then for each
// incoming updated task do O(1) lookup; the final pass reassembles `merged`
// preserving original order. For a 20-task run × 5-batch merger with
// ~10 updates per result, this reduces from O(50×20) = 1000 ops to O(120).
// Behavior is unchanged: skipped updates (shouldMergeTaskUpdate=false) still
// leave the existing task in place.
export function mergeTaskUpdatesPreservingTerminal(base: TeamTaskState[], results: Array<{ tasks: TeamTaskState[] }>): TeamTaskState[] {
	// Index current merged state by id for O(1) lookup during the merge pass.
	const indexById = new Map<string, TeamTaskState>();
	for (const task of base) indexById.set(task.id, task);

	let skipped = 0;
	for (const result of results) {
		for (const updated of result.tasks) {
			const current = indexById.get(updated.id);
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
				skipped += 1;
				continue;
			}
			indexById.set(updated.id, updated);
		}
	}
	// Reassemble in original `base` order so downstream snapshots stay stable.
	const merged = base.map((task) => indexById.get(task.id) ?? task);
	// `skipped` is intentional visibility — currently no caller reads it but
	// we'd rather leave the count available for future instrumentation than
	// remove the cumulative silent-rejection signal it provides.
	void skipped;
	return refreshTaskGraphQueues(merged);
}
/** @deprecated Use mergeTaskUpdatesPreservingTerminal. Kept for backward test import compat. */
export const __test__mergeTaskUpdates = mergeTaskUpdatesPreservingTerminal;

// 2.8: adaptive-plan parsing/repair/injection moved to src/runtime/goal-workflow/adaptive-plan.ts.
// Re-export the test-only helpers so existing test imports still resolve.
export {
	__test__parseAdaptivePlan,
	__test__repairAdaptivePlan,
} from "./goal-workflow/adaptive-plan.ts";

import { injectAdaptivePlanIfReady } from "./goal-workflow/adaptive-plan.ts";

function formatTaskProgress(task: TeamTaskState): string {
	return `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.error ? ` - ${task.error}` : ""}`;
}

function runEffectivenessLines(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	executeWorkers: boolean,
	runtimeConfig?: CrewRuntimeConfig,
): string[] {
	return formatRunEffectivenessLines(
		evaluateRunEffectiveness({
			manifest,
			tasks,
			executeWorkers,
			runtimeConfig,
		}),
	);
}

// P6 (perf): Cache the last-rendered progress content so we can skip the
// artifact write + redaction + atomic write + size/hash read when nothing
// material changed (rare between batches, but happens between idle heartbeats).
// The dedup filter also moved from O(N²) findIndex inside .filter(...)
// (the previous implementation ran 2 redundant passes on every batch) to
// a single-pass Map-based replacement: remove the existing entry by path, then
// append the new one. Net complexity: O(N) build + O(1) replace per write.
// RT-7: key on manifest.runId (stable string) instead of object identity
// (WeakMap). Every writeProgress mutator returns a NEW manifest object via
// spread, so object-identity keying meant the cache NEVER hit. Using runId
// makes back-to-back calls (same millisecond) actually dedup.
const lastProgressContentHash = new Map<string, string>();

function writeProgress(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	producer: string,
	executeWorkers = true,
	runtimeConfig?: CrewRuntimeConfig,
): TeamRunManifest {
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const queue = taskGraphSnapshot(tasks);
	const updatedAt = new Date().toISOString();
	const content = [
		`# pi-crew progress ${manifest.runId}`,
		"",
		`Status: ${manifest.status}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`Updated: ${updatedAt}`,
		`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
		`Queue: ready=${queue.ready.length}, blocked=${queue.blocked.length}, running=${queue.running.length}, done=${queue.done.length}, failed=${queue.failed.length}, cancelled=${queue.cancelled.length}`,
		"",
		"## Tasks",
		...tasks.map(formatTaskProgress),
		"",
		"## Effectiveness",
		...runEffectivenessLines(manifest, tasks, executeWorkers, runtimeConfig),
		"",
	].join("\n");

	// P6 content-cache: even with identical status / counts / queue, the
	// `Updated:` timestamp ticks on every call so the content rarely matches
	// byte-for-byte. We DO compare against the previous rendered byte-stream
	// (which used the previous timestamp) — so this only hits on the
	// back-to-back writeProgress calls during the applyPolicy phase, where
	// both calls happen within the same millisecond. It's a minor win but
	// matches the audit recommendation (skip artifact write when nothing
	// material changed).
	// RT-7: compute the content hash ONCE (was hashed twice per call: once
	// for the canSkip comparison and again for the cache .set). Key the cache
	// on manifest.runId (stable) instead of object identity (never hit).
	const contentHash = hashContent(content);
	const prevHash = lastProgressContentHash.get(manifest.runId);
	// Cheap pre-check: avoid the redaction + atomicWrite + readback roundtrip
	// when both the timestamp and the input args are identical to last time.
	const canSkip = prevHash === contentHash;

	const progress = canSkip
		? (() => {
				// Reuse the previous artifact rather than rebuilding one via
				// writeArtifact. This skips mkdirSync, resolveRealContainedPath,
				// redactSecrets, atomicWriteFile, and the post-write readFileSync +
				// statSync.
				const existing = manifest.artifacts.find((a) => a.kind === "progress");
				if (existing) {
					// RT-7a: return a FRESH descriptor with a refreshed createdAt
					// instead of reusing the stale existing reference. The existing
					// descriptor's createdAt reflects the FIRST write time, not this
					// skip-write; refreshing it matches the non-skip path (writeArtifact
					// stamps createdAt with the actual write time) so the manifest
					// always carries a descriptor whose createdAt reflects the current
					// write. Content is identical (that's why we skipped), so path /
					// sizeBytes / contentHash / retention are unchanged.
					return { ...existing, createdAt: new Date().toISOString() };
				}
				// No prior progress artifact (rare; first call from a stale manifest
				// view). Fall through to the normal write.
				return writeArtifact(manifest.artifactsRoot, {
					kind: "progress",
					relativePath: "progress.md",
					producer,
					content,
				});
			})()
		: writeArtifact(manifest.artifactsRoot, {
				kind: "progress",
				relativePath: "progress.md",
				producer,
				content,
			});
	lastProgressContentHash.set(manifest.runId, contentHash);

	// P6 dedup: replace by path in a single Map pass instead of
	//   .filter(...)  // O(N) to remove the old entry
	//   .filter((_, i, self) => self.findIndex(...) === i)  // O(N²) for dedup
	// For an artifact list of size 30+ across a long run, this was the
	// dominant cost of writeProgress between batches.
	const byPath = new Map<string, ArtifactDescriptor>();
	for (const artifact of manifest.artifacts) {
		if (artifact.kind === "progress" && artifact.path === progress.path) continue;
		byPath.set(artifact.path, artifact);
	}
	byPath.set(progress.path, progress);
	const deduped = [...byPath.values()];

	return {
		...manifest,
		updatedAt,
		artifacts: deduped,
	};
}

/** @internal RT-7 test export — verify cache is keyed on runId (stable string). */
export const __test__lastProgressContentHash = lastProgressContentHash;
/** @internal RT-7 test export — exercise writeProgress directly. */
export const __test__writeProgress = writeProgress;
/** @internal RT-14 test export — verify cancelPlanTasks preserves graph mutation after consolidation. */
export const __test__cancelPlanTasks = cancelPlanTasks;

function applyPolicy(manifest: TeamRunManifest, tasks: TeamTaskState[], limits?: CrewLimitsConfig): TeamRunManifest {
	const branchFreshness = checkBranchFreshness(manifest.cwd);
	const branchArtifact = writeArtifact(manifest.artifactsRoot, {
		kind: "metadata",
		relativePath: "metadata/branch-freshness.json",
		producer: "branch-freshness",
		content: `${JSON.stringify(branchFreshness, null, 2)}\n`,
	});
	let decisions: PolicyDecision[] = evaluateCrewPolicy({
		manifest,
		tasks,
		limits,
	});
	if (branchFreshness.status === "stale" || branchFreshness.status === "diverged") {
		const branchDecision: PolicyDecision = {
			action: "notify",
			reason: "branch_stale",
			message: branchFreshness.message,
			createdAt: new Date().toISOString(),
		};
		decisions = [...decisions, branchDecision];
		appendEvent(manifest.eventsPath, {
			type: "branch.stale",
			runId: manifest.runId,
			message: branchFreshness.message,
			data: { branchFreshness },
		});
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
	for (const item of decisions)
		appendEvent(manifest.eventsPath, {
			type: item.action === "escalate" ? "policy.escalated" : "policy.action",
			runId: manifest.runId,
			taskId: item.taskId,
			message: item.message,
			data: { action: item.action, reason: item.reason },
		});
	for (const item of recoveryLedger.entries)
		appendEvent(manifest.eventsPath, {
			type: item.state === "escalation_required" ? "recovery.escalated" : "recovery.attempted",
			runId: manifest.runId,
			taskId: item.taskId,
			message: item.message,
			data: {
				scenario: item.scenario,
				steps: item.steps,
				attempt: item.attempt,
				state: item.state,
			},
		});
	return {
		...manifest,
		updatedAt: new Date().toISOString(),
		policyDecisions: decisions,
		artifacts: [
			...manifest.artifacts.filter(
				(artifact) =>
					!(
						artifact.kind === "metadata" &&
						(artifact.path.endsWith("policy-decisions.json") ||
							artifact.path.endsWith("recovery-ledger.json") ||
							artifact.path.endsWith("branch-freshness.json"))
					),
			),
			branchArtifact,
			policyArtifact,
			recoveryArtifact,
		],
	};
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

async function ensurePlanApprovalRequested(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<TeamRunManifest> {
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
	await saveRunManifestAsync(updated);
	appendEvent(updated.eventsPath, {
		type: "plan.approval_required",
		runId: updated.runId,
		taskId: planTask?.id,
		message: "Plan requires explicit approval before mutating tasks run. Use: team api op=approve-plan runId=...",
		data: { planArtifactPath: planTask?.resultArtifact?.path },
	});
	return updated;
}

function cancelPlanTasks(tasks: TeamTaskState[], reason: string): TeamTaskState[] {
	// RT-14: delegate to the shared cancelNonTerminalTasks helper. The
	// non-terminal gate (queued/running/waiting) is identical to the helper's
	// default filter (isNonTerminalTaskStatus). The only site-specific logic is
	// the graph mutation (move the task graph to the "done" queue), passed via
	// the `transform` hook so every cancel site uses the single shared path.
	return cancelNonTerminalTasks(tasks, "cancelled", reason, undefined, (task, terminalised) => ({
		...terminalised,
		graph: task.graph ? { ...task.graph, queue: "done" } : undefined,
	}));
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

/** RT-12: result shape from a settled dispatch unit (pre-created wrapper). */
type SettledUnit = {
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
type PendingUnit = {
	taskIds: string[];
	promise: Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }>;
	wrapped: Promise<SettledUnit>;
};

/**
 * Drain in-flight dispatch units (pendingUnits) by aborting the run-scoped
 * controller and awaiting all settled promises before clearing the map.
 *
 * CORE-1 fix: without this, every early-return path inside the main while
 * loop would abandon pendingUnits — leaving zombie child processes running
 * with no one listening for their results.
 *
 * Exported so unit tests can exercise it directly.
 */
/** Settled outcome of a single in-flight dispatch unit promise (returned by drainPendingUnits). */
export type DrainOutcome = PromiseSettledResult<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }>;

export async function drainPendingUnits<
	T extends { taskIds: string[]; promise: Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> },
>(pendingUnits: Map<string, T>, controller?: AbortController): Promise<DrainOutcome[]> {
	if (pendingUnits.size === 0) return [];
	controller?.abort();
	const outcomes = await Promise.allSettled([...pendingUnits.values()].map((p) => p.promise));
	pendingUnits.clear();
	return outcomes;
}

export async function executeTeamRun(input: ExecuteTeamRunInput): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	const workflow = input.workflow;

	// DEFENSE-IN-DEPTH (advisory-only since v0.9.15): re-validate topology here in
	// case a caller bypassed the extension-layer handleRun guard. The extension
	// layer logs an advisory note and proceeds; this defense-in-depth does the same
	// for direct API callers (CLI, tests, scheduler). Never blocks.
	// Skip for synthetic direct-agent workflows (filePath="<generated>").
	if (workflow.filePath !== "<generated>") {
		// LAZY: defer preflight-validator import until the defense-in-depth guard actually runs.
		const { validateWorkflowUsage } = await import("../workflows/preflight-validator.ts");
		const preflight = validateWorkflowUsage(workflow, {
			force: input.reliability?.forcePreflight === true,
		});
		if (preflight.level === "warn" || preflight.level === "note" || preflight.level === "info") {
			const icon = preflight.level === "warn" ? "⚠️ " : preflight.level === "note" ? "✅ " : "ℹ️  ";
			console.warn(
				`${icon}[team-runner.preflight] ${preflight.level.toUpperCase()}: ${preflight.message} (workflow=${workflow.name})`,
			);
			if (preflight.suggestion) {
				console.warn(`[team-runner.preflight] → ${preflight.suggestion}`);
			}
		}
	}

	let manifest = updateRunStatus(
		input.manifest,
		"running",
		input.executeWorkers ? "Executing team workflow." : "Creating workflow prompts and placeholder results.",
	);

	// Persist budget fields on the manifest so all subsequent saveRunManifest
	// calls (there are many in executeTeamRunCore) preserve the budget config.
	// Without this, the spread in updateRunStatus and other transformations
	// can drop budget fields before they reach the persistence layer.
	if (input.budgetTotal !== undefined) manifest.budgetTotal = input.budgetTotal;
	if (input.budgetWarning !== undefined) manifest.budgetWarning = input.budgetWarning;
	if (input.budgetAbort !== undefined) manifest.budgetAbort = input.budgetAbort;
	if (input.budgetUnlimited !== undefined) manifest.budgetUnlimited = input.budgetUnlimited;
	if (manifest.budgetTotal !== undefined && manifest.budgetTotal > 0 && !manifest.budgetUnlimited) {
		await saveRunManifestAsync(manifest);
	}

	void registerRunPromise(manifest.runId);

	// FIX (Round 15, regression): Start a team-level heartbeat so the stale
	// reconciler does not cancel long-running team runs after 5 minutes
	// (NO_PID_HEARTBEAT_STALE_MS). Previously only sub-task runners wrote
	// heartbeats; the team-level run had no heartbeat, so any multi-phase
	// workflow lasting >5min was marked stale and cancelled.
	const stopTeamHeartbeat = startTeamRunHeartbeat(manifest.stateRoot, manifest.runId);
	// Perf observability: auto-attach the resource sampler for this run (toggle:
	// team frontmatter `observability: false`). Detached + unref'd — the sampler
	// auto-stops when the runner dies, so no explicit cleanup needed.
	startPerfSampler(manifest, input.team);

	const cleanupUsage = (): void => {
		for (const task of input.tasks) clearTrackedTaskUsage(task.id);
	};

	try {
		const result = await executeTeamRunCore(input, manifest, workflow);
		// #2 (assessment): goal-achievement detection — kill the silent false-green.
		// A code-mutating run that "completed" but left the git working tree clean
		// (and/or had a failed task) is a false-green. We expose goalAchieved on the
		// manifest + emit an event so the lie is never silent, and downgrade status
		// to "failed" only when a failed task corroborates it (conservative).
		const gaAssessment = assessGoalAchievement(result.manifest, result.tasks, workflow);
		const gaApplied = applyGoalAchievement(result.manifest, gaAssessment);
		if (gaApplied.manifest !== result.manifest) {
			result.manifest = gaApplied.manifest;
			try {
				await saveRunManifestAsync(result.manifest);
			} catch (persistError) {
				logInternalError(
					"team-runner.goalAchievement.persist",
					persistError instanceof Error ? persistError : new Error(String(persistError)),
					`runId=${manifest.runId}`,
				);
			}
		}
		appendEvent(manifest.eventsPath, {
			type: "run.goal_achievement",
			runId: manifest.runId,
			message: gaApplied.manifest.goalAchievementNote ?? "",
			data: {
				achieved: gaAssessment.achieved,
				downgraded: gaApplied.downgraded,
				reason: gaAssessment.reason,
				signals: gaAssessment.signals,
			},
		});
		if (gaApplied.downgraded)
			logInternalError(
				"team-runner.goalAchievement.falseGreen",
				new Error(gaApplied.manifest.goalAchievementNote ?? "false-green detected"),
				`runId=${manifest.runId}`,
				"error",
			);
		stopTeamHeartbeat();
		resolveRunPromise(manifest.runId, result);
		// Terminate live agents for this run — agents are done when the run ends.
		void terminateLiveAgentsForRun(manifest.runId, "completed", appendEvent, manifest.eventsPath).catch((error) =>
			logInternalError("team-runner.completed.terminate", error, `runId=${manifest.runId}`),
		);

		// Emit run completion hook (100% reliable, fire-and-forget)
		crewHooks.emit({
			type: "run_completed",
			timestamp: new Date().toISOString(),
			runId: manifest.runId,
			data: {
				status: result.manifest.status,
				taskCount: result.tasks.length,
			},
		});

		// Execute after_run_complete lifecycle hook (non-blocking)
		const afterRunReport = await executeHook("after_run_complete", {
			runId: manifest.runId,
			cwd: manifest.cwd,
			status: result.manifest.status,
		});
		appendHookEvent(manifest, afterRunReport);
		if (afterRunReport.outcome === "block") {
			logInternalError(
				"team-runner.after_run_complete.blocked",
				new Error(afterRunReport.reason ?? "after_run_complete hook blocked"),
				`runId=${manifest.runId}`,
			);
		}

		// M7: flush buffered task.progress events so the final state is durable
		// before the run returns. Buffered producer wins on latency (p95≈0µs);
		// this single flush at run-end coalesces any pending progress bursts
		// before manifest updates are observed by readers.
		await flushEventLogBuffer();
		// Perf observability: emit the post-run perf report (detached, delayed so
		// child transcripts are flushed). Never affects run outcome.
		schedulePerfAnalyze(manifest, input.team);
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
		// Re-read the latest persisted state from disk instead of trusting
		// input.tasks (the ORIGINAL start snapshot, still all "queued" — it is never
		// mutated by executeTeamRunCore). A late failure during closeout would
		// otherwise map every task to "failed", overwriting tasks that already
		// completed during the run. loadRunManifestById is the established
		// fresh-read pattern in this file (see ~line 1269); it is best-effort with
		// no lock, consistent with the lock-drop decision below. If the disk read
		// fails, fall back to input.tasks so the run is still marked terminal.
		const fresh = loadRunManifestById(manifest.cwd, manifest.runId);
		const freshManifest = fresh?.manifest ?? manifest;
		const freshTasks = refreshTaskGraphQueues(fresh?.tasks ?? input.tasks);
		const tasks = cancelNonTerminalTasks(freshTasks, "failed", message);
		manifest = freshManifest;
		try {
			await terminateLiveAgentsForRun(manifest.runId, "failed", appendEvent, manifest.eventsPath);
			await saveRunTasksAsync(manifest, tasks);
			const existingRuntimeByTask = new Map(readCrewAgents(manifest).map((agent) => [agent.taskId, agent.runtime]));
			const globalRuntime = input.runtime?.kind ?? "child-process";
			const taskById = new Map(tasks.map((item) => [item.id, item] as const));
			const runtimeForAgent = (agent: ReturnType<typeof recordsForMaterializedTasks>[number]): CrewRuntimeKind => {
				const task = taskById.get(agent.taskId);
				return (
					existingRuntimeByTask.get(agent.taskId) ??
					resolveTaskRuntimeKind(globalRuntime, task?.role ?? agent.role, input.runtimeConfig?.isolationPolicy)
				);
			};
			saveCrewAgents(
				manifest,
				recordsForMaterializedTasks(manifest, tasks, globalRuntime).map((agent) => ({ ...agent, runtime: runtimeForAgent(agent) })),
			);
			manifest = updateRunStatus(manifest, "failed", `Unhandled error in team runner: ${message}`);
			await saveRunManifestAsync(manifest);
		} catch {
			// Best-effort — state write may also fail
		}
		const result = { manifest, tasks };
		rejectRunPromise(manifest.runId, error instanceof Error ? error : new Error(message));
		crewHooks.emit({
			type: "run_failed",
			timestamp: new Date().toISOString(),
			runId: manifest.runId,
			data: { status: manifest.status, error: message },
		});
		// M7: flush buffered events before returning on the error path so the
		// final buffered progress events are durable alongside the failure state.
		await flushEventLogBuffer();
		return result;
	} finally {
		// M7+follow-up (v0.9.24): drain buffer on the success path too.
		// Previously only the catch path flushed; under --test-force-exit the
		// success path left pending appendEventAsync promises that the test
		// runner detected as 'Promise resolution is still pending'. The catch
		// still has its own flush for M7 backward compat — flushEventLogBuffer
		// is idempotent on an empty queue.
		await flushEventLogBuffer();
		// A2-F1: clear tracked usage for this run's tasks. Consolidated in finally
		// (previously duplicated on the success + error paths) so cleanup is
		// guaranteed on EVERY exit path — a future throw in the success tail or
		// error handler can no longer leak entries. Safe to run last: nothing in
		// team-runner reads usage after the run resolves, and the TUI widget reads
		// live usage only while a task is running (before this point).
		cleanupUsage();
		// NEW-M1: clear the stable-prefix cache (keyed by runId) so it does not
		// grow unbounded across runs in a long-lived session.
		clearStablePrefixCache();
		// RT-7b: clear the progress-content cache entry for this run so the
		// module-level lastProgressContentHash Map (keyed by runId) does not grow
		// unbounded across runs in a long-lived session. The finally block is the
		// single guaranteed exit point (success, failure, and re-throw), so this
		// runs on every run completion. Mirrors clearStablePrefixCache() above.
		lastProgressContentHash.delete(manifest.runId);
	}
}

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
interface SchedulerContext {
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
}

/**
 * Discriminated union representing a scheduler sub-function's decision.
 *
 * - `continue`: proceed to the next phase of the loop body.
 * - `return`: short-circuit the loop and return the given result.
 * - `skip-dispatch`: skip the dispatch phase this iteration (reserved for
 *   future extractions).
 */
type SchedulerDecision =
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

/**
 * RT-13: Safely normalize the manifest status to "running" so a subsequent
 * terminal transition (e.g. → cancelled) goes through updateRunStatus legally.
 *
 * Replaces the former inline status-rewrite hack
 * `manifest = { ...manifest, status: "running" }` which bypassed
 * updateRunStatus entirely. Unlike the raw spread, this validates the
 * transition via canTransitionRunStatus. Does NOT call updateRunStatus —
 * no event is emitted, no persistence — preserving the exact observable
 * behavior of the former hack. If the transition is somehow illegal, the
 * manifest is returned unchanged (safe fallback, no throw introduced).
 *
 * All non-terminal statuses and the terminal statuses failed/cancelled/
 * completed can legally reach "running" per TEAM_RUN_STATUS_TRANSITIONS, so
 * in practice the validation always passes.
 */
export function setRunStatusRunning(manifest: TeamRunManifest): TeamRunManifest {
	if (canTransitionRunStatus(manifest.status, "running")) {
		return { ...manifest, status: "running" };
	}
	return manifest;
}

/**
 * RT-17: compute a bounded batch-summary filename slug from coalesced task IDs.
 *
 * The unbounded join of coalesced task IDs (e.g. "01+02+…+20") can exceed
 * NAME_MAX (255) on ext4 with ~20 members. For short joins (common case: ≤180
 * chars) use the raw IDs to preserve readability + uniqueness; for long joins,
 * hash to a fixed-length slug (SHA-256 hex = 64 chars) with a member-count
 * prefix for human scannability.
 */
export function batchSummarySlug(taskIds: string[]): string {
	const joined = taskIds.join("+");
	return joined.length <= 180 ? joined : `coalesced-${taskIds.length}-${hashContent(joined)}`;
}

/**
 * CORE-4 extraction 1: handle a pre-aborted signal at the top of the
 * scheduler loop.
 *
 * If the run's input signal is aborted, cancel all non-terminal tasks,
 * persist the cancellation, emit run.cancelled + per-task task.cancelled
 * events, and return a `return` decision so the caller short-circuits.
 *
 * Returns `null` when the signal is NOT aborted (no decision — continue).
 *
 * @param ctx  The scheduler context; `ctx.tasks` and `ctx.manifest` are
 *             mutated in-place to reflect the cancelled state.
 */
async function cancelRunFromSignal(ctx: SchedulerContext): Promise<SchedulerDecision | null> {
	if (!ctx.input.signal?.aborted) return null;

	const cancelReason = cancellationReasonFromSignal(ctx.input.signal);
	const message = `${cancelReason.message} (${cancelReason.code})`;
	const cancelledTaskIds: string[] = [];
	// RT-14: delegate to the shared cancelNonTerminalTasks helper. The
	// non-terminal gate (queued/running/waiting) is identical to the helper's
	// default filter. The site-specific logic lives in the `transform` hook:
	// (1) collect cancelledTaskIds for the run-status event payload, and
	// (2) synthesise terminalEvidence for in-flight ("running") workers so the
	// signal-abort is recorded. Both are preserved exactly — only the
	// transform frame changed, not the per-task output.
	ctx.tasks = cancelNonTerminalTasks(ctx.tasks, "cancelled", message, undefined, (task, terminalised) => {
		cancelledTaskIds.push(task.id);
		if (task.status === "running") {
			return {
				...terminalised,
				terminalEvidence: [
					...(task.terminalEvidence ?? []),
					buildSyntheticTerminalEvidence("worker", cancelReason, task.startedAt),
				],
			};
		}
		return terminalised;
	});
	await saveRunTasksAsync(ctx.manifest, ctx.tasks);
	await Promise.all(
		cancelledTaskIds.map((taskId) =>
			appendEventAsync(ctx.manifest.eventsPath, {
				type: "task.cancelled",
				runId: ctx.manifest.runId,
				taskId,
				message,
				data: { reason: cancelReason.code },
			}),
		),
	);
	ctx.manifest = updateRunStatus(ctx.manifest, "cancelled", message, {
		data: { reason: cancelReason.code, cancelledTaskIds },
	});
	return { kind: "return", result: { manifest: ctx.manifest, tasks: ctx.tasks } };
}

/**
 * CORE-4 extraction 2: handle a failed task detected at the top of the
 * scheduler loop.
 *
 * If a task has status "failed", honor `limits.maxRetriesPerTask` to decide
 * whether to re-queue it for a bounded whole-task rerun or abort the run.
 *
 * - `maxRetriesPerTask > 0` and the task is eligible → re-queue the task
 *   (mutate `ctx.tasks`), emit `recovery.rerun_task`, return `{ kind: "continue" }`
 *   so the caller re-processes the re-queued task.
 * - Otherwise → mark all queued tasks blocked, persist, mark the run failed,
 *   and return `{ kind: "return", result }` so the caller short-circuits.
 *
 * Returns `null` when no failed task exists (no decision — continue).
 *
 * @param ctx  The scheduler context; `ctx.tasks` and `ctx.manifest` are
 *             mutated in-place to reflect the rerun or abort.
 */
/**
 * RT-NEW-2: terminalise a run as "failed" while draining in-flight dispatch
 * units FIRST and merging their settled results under the run lock.
 *
 * Extracted verbatim from handleFailedTask (the FIXED reference) so every
 * abort path behaves identically: drain pendingUnits (abort controller +
 * await allSettled + clear), merge fulfilled outcomes into manifest/tasks
 * under withRunLock (flushPendingAtomicWrites + loadRunManifestById +
 * mergeArtifacts + mergeTaskUpdatesPreservingTerminal + save both), cancel
 * (not skip) non-settled in-flight tasks so team resume can re-queue them,
 * then markBlocked the remaining never-dispatched queued tasks.
 *
 * Previously enforceRunBudget skipped the drain+merge and called
 * markBlocked directly — in-flight tasks (still "queued" in ctx.tasks since
 * streaming dispatch never sets "running") were clobbered to "skipped",
 * which team resume never re-queues → permanent work loss.
 */
async function terminaliseRunWithDrain(
	ctx: SchedulerContext,
	opts: { cancelMessage: string; blockedMessage: string; failedReason: string },
): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	// Ever-dispatched tasks (monotonic set populated at dispatch). Using this
	// instead of a pendingUnits snapshot closes the RT-NEW-2 race where a task
	// whose unit settled + left pendingUnits before the abort — but whose task
	// status isn't terminal yet — would otherwise fall through to markBlocked
	// and be clobbered to "skipped" (observed CI flake: 02_b skipped on
	// team-runner-budget-abort-inflight across v0.9.59 / cfd68d06 / 12386af2).
	const inflightTaskIds = ctx.dispatchedTaskIds;
	const outcomes = await drainPendingUnits(ctx.pendingUnits, ctx.runController);
	const validResults: { manifest: TeamRunManifest; tasks: TeamTaskState[] }[] = [];
	for (const outcome of outcomes) {
		if (outcome.status === "fulfilled") validResults.push(outcome.value);
	}
	if (validResults.length > 0) {
		// Merge under the run lock — same pattern as mergeUnitResult:
		// flush pending writes, load disk state, merge artifacts + tasks,
		// save atomically.
		const mergeResult = await withRunLock(ctx.manifest, async () => {
			flushPendingAtomicWrites();
			const disk = loadRunManifestById(ctx.manifest.cwd, ctx.manifest.runId);
			const diskManifest = disk?.manifest ?? ctx.manifest;
			const reconciledArtifacts = mergeArtifacts([
				...diskManifest.artifacts,
				...validResults.flatMap((item) => item.manifest.artifacts),
			]);
			const resultManifest = updateRunStatus(
				{ ...diskManifest, artifacts: reconciledArtifacts },
				"running",
				"Merged in-flight results during failed-task abort.",
			);
			const resultTasks = mergeTaskUpdatesPreservingTerminal(disk?.tasks ?? ctx.tasks, validResults);
			await saveRunManifestAsync(resultManifest);
			await saveRunTasksAsync(resultManifest, resultTasks);
			return { resultManifest, resultTasks };
		});
		ctx.manifest = mergeResult.resultManifest;
		ctx.tasks = mergeResult.resultTasks;
	}
	// Cancel in-flight tasks that did NOT settle (e.g. rejected promises)
	// so team resume CAN re-queue them. markBlocked maps queued→skipped,
	// which resume never re-queues — work would be lost permanently. Only
	// cancel tasks that are both in-flight AND still non-terminal (settled
	// tasks with a terminal status are preserved).
	ctx.tasks = cancelNonTerminalTasks(
		ctx.tasks,
		"cancelled",
		opts.cancelMessage,
		(task) => inflightTaskIds.has(task.id) && isNonTerminalTaskStatus(task.status),
	);
	// Remaining queued tasks (never dispatched) → skipped (original behavior
	// preserved for downstream tasks not yet in-flight).
	ctx.tasks = markBlocked(ctx.tasks, opts.blockedMessage);
	await saveRunTasksAsync(ctx.manifest, ctx.tasks);
	saveCrewAgents(ctx.manifest, recordsForMaterializedTasks(ctx.manifest, ctx.tasks, ctx.runtimeKind));
	ctx.manifest = updateRunStatus(ctx.manifest, "failed", opts.failedReason);
	return { manifest: ctx.manifest, tasks: ctx.tasks };
}

async function handleFailedTask(ctx: SchedulerContext): Promise<SchedulerDecision | null> {
	const failed = ctx.tasks.find((task) => task.status === "failed");
	if (!failed) return null;

	// #4 (assessment): honor limits.maxRetriesPerTask — re-queue an eligible
	// failed task for a bounded whole-task rerun instead of immediately
	// aborting the run. Before #4, the recovery ledger recorded `rerun_task`
	// entries with state:"planned" but never executed them (decorative).
	// Default-off: maxRetriesPerTask=0 → original abort behavior preserved.
	const rerun = shouldRerunFailedTask(failed, ctx.input.limits);
	if (rerun.rerun) {
		ctx.tasks = ctx.tasks.map((item) =>
			item.id === failed.id
				? {
						...item,
						status: "queued" as const,
						policy: {
							...(item.policy ?? {}),
							retryCount: rerun.newRetryCount,
						},
						error: undefined,
						finishedAt: undefined,
					}
				: item,
		);
		await saveRunTasksAsync(ctx.manifest, ctx.tasks);
		await appendEventAsync(ctx.manifest.eventsPath, {
			type: "recovery.rerun_task",
			runId: ctx.manifest.runId,
			taskId: failed.id,
			message: `Re-queuing failed task for whole-task rerun: ${rerun.reason}`,
			data: {
				attempt: rerun.newRetryCount,
				maxRetries: ctx.input.limits?.maxRetriesPerTask ?? 0,
				scenario: "task_failed",
			},
		});
		return { kind: "continue" }; // loop re-processes the re-queued task
	}
	// RT-NEW-2: drain in-flight units + merge settled results, then cancel
	// non-settled in-flight tasks and markBlocked the rest — via the shared
	// terminaliseRunWithDrain helper (extracted from this function verbatim).
	const result = await terminaliseRunWithDrain(ctx, {
		cancelMessage: `Cancelled by failed task '${failed.id}'.`,
		blockedMessage: `Blocked by failed task '${failed.id}'.`,
		failedReason: `Failed at task '${failed.id}'.`,
	});
	return { kind: "return", result };
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
async function selectDispatchBatch(ctx: SchedulerContext): Promise<SchedulerDecision> {
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

/** Dispatch decision variant returned by selectDispatchBatch. */
type DispatchBatchDecision = Extract<SchedulerDecision, { kind: "dispatch" }>;

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
async function dispatchBatch(ctx: SchedulerContext, decision: DispatchBatchDecision): Promise<void> {
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

/**
 * CORE-4 extraction 5: wait for one in-flight dispatch unit to settle and
 * merge its result into the run state.
 *
 * Awaits Promise.race on ctx.pendingUnits; the first settled unit is merged
 * into ctx.manifest/tasks under the run lock (flushPendingAtomicWrites +
 * loadRunManifestById + mergeTaskUpdatesPreservingTerminal + save). The settled
 * unit is then deleted from ctx.pendingUnits, and the merge outcome (taskIds
 * + result object) is recorded on ctx.settledMerge for the post-merge inline
 * logic (cancel-during-exec check + batch summary).
 *
 * Returns null to continue to the phase/budget check. A `{ kind: "return" }`
 * decision is reserved for future run-complete/failure detection during merge.
 *
 * Reads ctx.pendingUnits/manifest/tasks. Mutates ctx.pendingUnits (delete),
 * ctx.manifest/tasks, ctx.settledMerge.
 *
 * @param ctx  The scheduler context.
 */
async function mergeUnitResult(ctx: SchedulerContext): Promise<SchedulerDecision | null> {
	// RT-12: race on pre-created wrapper promises (created once at dispatch
	// time) instead of rebuilding a wrapper-promise array with new async
	// closures every iteration. This reduces allocation from O(C×T) wrapper
	// promises to O(C) total (one per unit, created once at dispatch).
	const settled = await Promise.race([...ctx.pendingUnits.values()].map((u) => u.wrapped));
	const completedUnit = ctx.pendingUnits.get(settled.unitKey)!;
	ctx.pendingUnits.delete(settled.unitKey);

	// Build the single result to merge. On rejection, synthesize a failed
	// result so the run continues (mirrors the old validResults guard).
	const resultToMerge: { manifest: TeamRunManifest; tasks: TeamTaskState[] } = settled.result ?? {
		manifest: ctx.manifest,
		tasks: cancelNonTerminalTasks(ctx.tasks, "failed", settled.error!.message, (t) => completedUnit.taskIds.includes(t.id)),
	};
	const validResults = [resultToMerge];
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
	const mergeResult = await withRunLock(ctx.manifest, async () => {
		// NEW-D1: flush any pending coalesced atomic writes before reading from
		// disk. Without this, a worker's async manifest save (coalesced by
		// atomic-write) may not be committed yet, causing a lost-update on the
		// merge read. flushPendingAtomicWrites forces all queued writes to disk.
		flushPendingAtomicWrites();
		const disk = loadRunManifestById(ctx.manifest.cwd, ctx.manifest.runId);
		const diskManifest = disk?.manifest ?? ctx.manifest;
		const diskArtifacts = diskManifest.artifacts;
		const reconciledArtifacts = mergeArtifacts([...diskArtifacts, ...validResults.map((item) => item.manifest.artifacts)].flat());
		const resultManifest = updateRunStatus(
			{ ...diskManifest, artifacts: reconciledArtifacts },
			"running",
			"Merged task updates from parallel batch.",
		);
		// CANCEL-1: use the freshly-loaded disk tasks as the merge base instead
		// of the in-memory `tasks` closure variable. The in-memory tasks reflect
		// only team-runner's view; an external cancel (handleCancel, background
		// race with SIGTERM arriving after cancel wrote but before merge ran)
		// writes 'cancelled' to disk.tasks — using disk.tasks as base preserves
		// that cancellation through the merge instead of overwriting it with the
		// stale in-memory view. disk was loaded inside this lock, so it reflects
		// the freshest committed state.
		const resultTasks = mergeTaskUpdatesPreservingTerminal(disk?.tasks ?? ctx.tasks, validResults);
		await saveRunManifestAsync(resultManifest);
		await saveRunTasksAsync(resultManifest, resultTasks);
		return { resultManifest, resultTasks };
	});
	ctx.manifest = mergeResult.resultManifest;
	ctx.tasks = mergeResult.resultTasks;
	ctx.settledMerge = { taskIds: completedUnit.taskIds, result: resultToMerge };
	return null;
}

/**
 * CORE-4 extraction 6: advance workflow phases whose tasks are all in
 * terminal state.
 *
 * Iterates phases starting at `ctx.wfMachine.currentPhaseIndex`; for each phase
 * whose tasks are all terminal, determines the transition status (failed if
 * any task failed/cancelled, else completed), applies the phase transition,
 * emits `workflow.phase_completed`/`workflow.phase_failed`/
 * `workflow.phase_guard_blocked` events, and advances `currentPhaseIndex`.
 *
 * Reads `ctx.tasks`, `ctx.manifest` (read-only). Mutates `ctx.wfMachine`
 * in-place (phase status + currentPhaseIndex). The caller syncs the local
 * `wfMachine` from ctx after the call.
 *
 * @param ctx  The scheduler context.
 */
async function advanceWorkflowPhases(ctx: SchedulerContext): Promise<void> {
	let wfMachine = ctx.wfMachine;
	const tasks = ctx.tasks;
	const manifest = ctx.manifest;
	// Advance workflow phases whose tasks are all in terminal state
	const terminalStatuses = new Set(["completed", "failed", "skipped", "cancelled", "needs_attention"]);
	const phaseTaskMap = new Map<string, string[]>();
	for (const task of tasks) {
		if (!task.stepId) continue;
		const existing = phaseTaskMap.get(task.stepId) ?? [];
		existing.push(task.id);
		phaseTaskMap.set(task.stepId, existing);
	}
	// W5-4: by-id map once for the phase loop (was O(phases × phaseTasks × tasks)).
	const taskById = new Map(tasks.map((t) => [t.id, t] as const));
	for (let pi = wfMachine.currentPhaseIndex; pi < wfMachine.phases.length; pi++) {
		const phase = wfMachine.phases[pi]!;
		const phaseTaskIds = phaseTaskMap.get(phase.name) ?? [];
		if (phaseTaskIds.length === 0) continue;
		const allTerminal = phaseTaskIds.every((taskId) => {
			const task = taskById.get(taskId);
			return task ? terminalStatuses.has(task.status) : false;
		});
		if (!allTerminal) break;
		if (phase.status !== "completed" && phase.status !== "failed" && phase.status !== "skipped") {
			const completedArtifacts = manifest.artifacts.filter((a) => a.kind === "result" || a.kind === "summary").map((a) => a.path);
			const previousPhaseStatus = pi > 0 ? (wfMachine.phases[pi - 1]?.status ?? "pending") : "completed";
			const wfContext: PhaseGuardContext = {
				completedArtifacts,
				previousPhaseStatus,
				taskResults: tasks
					.filter((t) => t.status === "completed" || t.status === "needs_attention")
					.map((t) => ({
						taskId: t.id,
						status: t.status,
						outputPath: t.resultArtifact?.path,
					})),
			};
			// Determine phase transition status based on individual task outcomes
			const phaseTasks = phaseTaskIds
				.map((taskId) => taskById.get(taskId))
				.filter((t): t is NonNullable<typeof t> => t !== undefined);
			const hasFailedOrCancelled = phaseTasks.some((t) => t.status === "failed" || t.status === "cancelled");
			const phaseStatus = hasFailedOrCancelled ? "failed" : "completed";
			const transition = transitionPhase(wfMachine, pi, phaseStatus, wfContext);
			wfMachine = transition.machine;
			if (transition.guardResult && !transition.guardResult.allowed) {
				await appendEventAsync(manifest.eventsPath, {
					type: "workflow.phase_guard_blocked",
					runId: manifest.runId,
					message: `Workflow phase '${phase.name}' guard blocked: ${transition.guardResult.reason ?? "unknown"}`,
					data: {
						phaseIndex: pi,
						phaseName: phase.name,
						reason: transition.guardResult.reason,
					},
				});
				break;
			}
			await appendEventAsync(manifest.eventsPath, {
				type: phaseStatus === "failed" ? "workflow.phase_failed" : "workflow.phase_completed",
				runId: manifest.runId,
				message: `Workflow phase '${phase.name}' ${phaseStatus}.`,
				data: { phaseIndex: pi, phaseStatus },
			});
		}
		wfMachine = { ...wfMachine, currentPhaseIndex: pi + 1 };
	}
	ctx.wfMachine = wfMachine;
}

/**
 * CORE-4 extraction 7: enforce per-task run budget after each batch merge.
 *
 * When `input.budgetTotal` is set (and not unlimited), checks cumulative usage
 * against warn/abort thresholds and a fair-share heuristic. On abort, marks all
 * non-terminal tasks blocked, persists the run as failed, and returns a
 * `{ kind: "return" }` decision so the caller short-circuits the loop.
 * Otherwise emits `run.budget_warning` / `task.budget_fair_share` events and
 * returns null (continue).
 *
 * Reads `ctx.input` (budget config). Mutates `ctx.tasks` / `ctx.manifest` only
 * in the abort path. The caller syncs these locals back after the call.
 *
 * @param ctx  The scheduler context.
 * @returns    `{ kind: "return", result }` on budget abort; `null` otherwise.
 */
async function enforceRunBudget(ctx: SchedulerContext): Promise<SchedulerDecision | null> {
	const input = ctx.input;
	const tasks = ctx.tasks;
	const manifest = ctx.manifest;
	// Per-task budget enforcement: check cumulative usage after each batch merge.
	// This prevents a single task from consuming 100% of the budget before
	// abort triggers (the goal-loop only checks at turn boundaries).
	if (input.budgetTotal !== undefined && input.budgetTotal > 0 && input.budgetUnlimited !== true) {
		const warnThreshold = input.budgetWarning ?? 0.8;
		const abortThreshold = input.budgetAbort ?? 0.95;
		const budgetCheck = checkPerTaskBudget(tasks, input.budgetTotal, warnThreshold, abortThreshold);

		if (budgetCheck.abort) {
			const message = `Per-task budget abort threshold exceeded: ${formatTokens(budgetCheck.totalUsed)}/${formatTokens(input.budgetTotal)} (${Math.round((budgetCheck.totalUsed / input.budgetTotal) * 100)}%)`;
			console.warn(`[team-runner] ${message}`);
			await appendEventAsync(manifest.eventsPath, {
				type: "run.budget_abort",
				runId: manifest.runId,
				message,
				data: {
					budgetTotal: input.budgetTotal,
					budgetUsed: budgetCheck.totalUsed,
					threshold: "abort",
				},
			});
			// RT-NEW-2: drain in-flight units + merge settled results before
			// terminalising, so in-flight tasks become completed/cancelled (not
			// skipped). Same shared helper handleFailedTask uses. Run-failed
			// reason stays the budget message.
			const result = await terminaliseRunWithDrain(ctx, {
				cancelMessage: `Cancelled by budget abort: ${message}`,
				blockedMessage: `Budget abort threshold exceeded: ${message}`,
				failedReason: message,
			});
			return { kind: "return", result };
		}

		if (budgetCheck.warning) {
			const message = `Per-task budget warning threshold crossed: ${formatTokens(budgetCheck.totalUsed)}/${formatTokens(input.budgetTotal)} (${Math.round((budgetCheck.totalUsed / input.budgetTotal) * 100)}%)`;
			console.warn(`[team-runner] ${message}`);
			await appendEventAsync(manifest.eventsPath, {
				type: "run.budget_warning",
				runId: manifest.runId,
				message,
				data: {
					budgetTotal: input.budgetTotal,
					budgetUsed: budgetCheck.totalUsed,
					threshold: "warning",
				},
			});
		}

		// Fair-share warning: flag tasks that consumed >50% of remaining budget
		// without killing them mid-execution.
		const fairShareAppends: Promise<void>[] = [];
		for (const violatorId of budgetCheck.fairShareViolators) {
			const violator = tasks.find((t) => t.id === violatorId);
			if (!violator) continue;
			const taskTotal = (violator.usage?.input ?? 0) + (violator.usage?.output ?? 0) + (violator.usage?.cacheWrite ?? 0);
			const message = `Task '${violatorId}' consumed ${formatTokens(taskTotal)} (${Math.round((taskTotal / input.budgetTotal) * 100)}% of total budget) — exceeds fair share`;
			console.warn(`[team-runner.fair-share] ${message}`);
			fairShareAppends.push(
				appendEventAsync(manifest.eventsPath, {
					type: "task.budget_fair_share",
					runId: manifest.runId,
					taskId: violatorId,
					message,
					data: {
						budgetTotal: input.budgetTotal,
						taskUsage: taskTotal,
					},
				}).then(
					() => undefined,
					(error) => logInternalError("team-runner.fair-share-event", error, `taskId=${violatorId}`),
				),
			);
		}
		await Promise.all(fairShareAppends);
	}
	return null;
}

/**
 * CORE-4 extraction 8: finalize the run after the scheduler loop exits.
 *
 * Computes the final run status (failed/blocked/completed) from task states,
 * policy decisions, and effectiveness evaluation; writes the workflow output
 * deliverable warning, the `summary.md` artifact, the joint atomic manifest+tasks
 * save, and a health snapshot; then returns the terminal `{ manifest, tasks }`.
 *
 * Reads `ctx.input` (limits/workflow/executeWorkers/runtimeConfig). Mutates
 * `ctx.manifest` / `ctx.tasks` and writes them back before returning so the
 * caller stays in sync. This function is the terminal step of
 * `executeTeamRunCore` — its return value is the run result.
 *
 * @param ctx  The scheduler context.
 * @returns    The final `{ manifest, tasks }` result for the run.
 */
async function finalizeRun(ctx: SchedulerContext): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	const input = ctx.input;
	const tasks = ctx.tasks;
	let manifest = ctx.manifest;
	const failed = tasks.find((task) => task.status === "failed");
	const waiting = tasks.find((task) => task.status === "waiting");
	const running = tasks.find((task) => task.status === "running");
	manifest = applyPolicy(manifest, tasks, input.limits);

	// S02: Verify workflow-declared output files exist before marking completed
	if (input.workflow?.steps) {
		const missingOutputs: string[] = [];
		for (const step of input.workflow.steps) {
			if (step.output && typeof step.output === "string") {
				const outputPath = path.join(manifest.artifactsRoot, step.output);
				if (!fs.existsSync(outputPath)) {
					missingOutputs.push(step.output);
				}
			}
		}
		if (missingOutputs.length > 0) {
			// Emit warning event — run still completes normally to avoid hanging
			appendEventFireAndForget(manifest.eventsPath, {
				type: "run.deliverable_warning",
				runId: manifest.runId,
				message: `Missing workflow output files: ${missingOutputs.join(", ")}`,
				data: { missingFiles: missingOutputs },
			});
		}
	}

	const effectiveness = evaluateRunEffectiveness({
		manifest,
		tasks,
		executeWorkers: input.executeWorkers,
		runtimeConfig: input.runtimeConfig,
	});
	const effectivenessDecision = effectivenessPolicyDecision(effectiveness);
	if (effectivenessDecision) {
		manifest = {
			...manifest,
			policyDecisions: [...(manifest.policyDecisions ?? []), effectivenessDecision],
			updatedAt: new Date().toISOString(),
		};
		await appendEventAsync(manifest.eventsPath, {
			type: "run.effectiveness",
			runId: manifest.runId,
			message: effectivenessDecision.message,
			data: { effectiveness, policyDecision: effectivenessDecision },
		});
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
	} else if (tasks.some((task) => task.status === "queued")) {
		// F1 defense-in-depth: the loop exited with queued tasks still pending
		// (e.g. a hook skipped all ready tasks and downstream tasks never became
		// runnable). This is NOT a completed run — mark it blocked rather than
		// false-green "completed".
		manifest = updateRunStatus(manifest, "blocked", "Run exited with queued tasks still pending.");
	} else if (manifest.status === "failed" || manifest.status === "cancelled") {
		// The run was already marked failed/cancelled mid-run (e.g. handleFailedTask
		// on a coalesced-group race where the failing task's status was later
		// mutated by the group-drain, or a cancel). Preserve that terminal status —
		// do NOT force "completed" here: failed -> completed is not in
		// TEAM_RUN_STATUS_TRANSITIONS and would throw an invalid-transition error.
		// (No updateRunStatus call: from===to is a no-op, but the intent here is
		// explicitly "leave the earlier decision intact".)
	} else {
		manifest = updateRunStatus(
			manifest,
			"completed",
			input.executeWorkers ? "Team workflow completed." : "Team workflow scaffold completed without launching child workers.",
		);
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
	const finalManifest = {
		...manifest,
		updatedAt: new Date().toISOString(),
		artifacts: [...manifest.artifacts, summaryArtifact],
	};
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
	ctx.manifest = manifest;
	ctx.tasks = tasks;
	return { manifest, tasks };
}

async function executeTeamRunCore(
	input: ExecuteTeamRunInput,
	manifest: TeamRunManifest,
	workflow: WorkflowConfig,
): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }> {
	// Execute before_run_start hook (non-blocking by default)
	const beforeRunReport = await executeHook("before_run_start", {
		runId: manifest.runId,
		cwd: manifest.cwd,
	});
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
	const attemptAdaptivePlan = async () => {
		if (!canInjectAdaptivePlan || adaptivePlanInjected || adaptivePlanMissing) return { injected: false, missing: false };
		const adaptivePlan = await injectAdaptivePlanIfReady({
			manifest,
			tasks,
			workflow,
			team: input.team,
		});
		adaptivePlanInjected = adaptivePlanInjected || adaptivePlan.injected;
		adaptivePlanMissing = adaptivePlan.missingPlan;
		workflow = adaptivePlan.workflow;
		if (adaptivePlan.injected) tasks = adaptivePlan.tasks;
		return {
			injected: adaptivePlan.injected,
			missing: adaptivePlan.missingPlan,
		};
	};
	const initialAdaptive = await attemptAdaptivePlan();
	if (initialAdaptive.missing) {
		tasks = markBlocked(tasks, "Adaptive planner did not produce a valid subagent plan.");
		await saveRunTasksAsync(manifest, tasks);
		manifest = updateRunStatus(manifest, "blocked", "Adaptive planner did not produce a valid subagent plan.");
		return { manifest, tasks };
	}
	if (initialAdaptive.injected) {
		manifest = requiresPlanApproval(workflow, input.runtimeConfig) ? await ensurePlanApprovalRequested(manifest, tasks) : manifest;
		queueIndex = buildTaskGraphIndex(tasks);
	} else if (
		requiresPlanApproval(workflow, input.runtimeConfig) &&
		(hasPendingMutatingAdaptiveTask(tasks) || hasPendingMutatingTaskAtBoundary(tasks))
	) {
		manifest = await ensurePlanApprovalRequested(manifest, tasks);
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
	const workflowPhases: PhaseState[] = workflow.steps.map(
		(step): PhaseState => ({
			name: step.id,
			status: "pending",
			inputs: step.reads === false ? [] : Array.isArray(step.reads) ? step.reads : [],
			outputs: step.output === false ? [] : step.output ? [step.output] : [],
		}),
	);
	let wfMachine = createWorkflowStateMachine(workflowPhases);

	// ── OPT-01 streaming dispatch: track in-flight dispatch units so a new
	// task can be dispatched as soon as a slot frees, without waiting for
	// the entire batch to complete. Each entry maps a unit key (singleton
	// task ID or coalesced-group ID) to the in-flight promise + member IDs. ──
	const pendingUnits = new Map<string, PendingUnit>();

	// CORE-1: run-scoped AbortController linked to input.signal. Aborted by
	// drainPendingUnits() so in-flight dispatch promises are settled (and
	// their child processes torn down) on every early-return path.
	const runController = new AbortController();
	if (input.signal) {
		if (input.signal.aborted) runController.abort();
		else input.signal.addEventListener("abort", () => runController.abort(), { once: true });
	}

	// CORE-4: scheduler context — mutable state bag for extracted scheduler
	// functions. Fields are synced from closure locals at the top of each
	// loop iteration; extracted functions mutate ctx in-place.
	const ctx: SchedulerContext = {
		input,
		workflow,
		manifest,
		tasks,
		queueIndex,
		wfMachine,
		pendingUnits,
		dispatchedTaskIds: new Set(),
		runController,
		runtimeKind,
		adaptivePlanInjected,
		adaptivePlanMissing,
		settledMerge: null,
	};

	// CORE-1: single drain point — all early returns + normal exit settle pendingUnits via finally block.
	try {
		while (tasks.some((task) => task.status === "queued") || pendingUnits.size > 0) {
			// CORE-4 / RT-15: full sync of mutable closure locals → ctx at the top
			// of every iteration. This is the SINGLE forward-sync point — all
			// extracted scheduler functions (cancelRunFromSignal /
			// handleFailedTask / selectDispatchBatch / dispatchBatch /
			// mergeUnitResult / advanceWorkflowPhases / enforceRunBudget) read
			// ctx directly. The per-function redundant forward-syncs were removed
			// (RT-15) because back-syncs after each call keep locals aligned with
			// ctx, making intermediate re-syncs no-ops. The inline post-merge
			// block (adaptive plan re-injection, phase advance, queueIndex
			// rebuild) mutates these locals; without this top-of-loop sync the
			// extracted functions would read stale ctx fields — e.g. ctx.workflow
			// missing newly-injected adaptive steps → E006 step-not-found.
			ctx.tasks = tasks;
			ctx.manifest = manifest;
			ctx.workflow = workflow;
			ctx.wfMachine = wfMachine;
			ctx.queueIndex = queueIndex;
			ctx.adaptivePlanInjected = adaptivePlanInjected;
			ctx.adaptivePlanMissing = adaptivePlanMissing;
			// CORE-4 extraction 1: signal-abort cancellation. cancelRunFromSignal
			// mutates ctx in-place and returns a SchedulerDecision.
			const signalDecision = await cancelRunFromSignal(ctx);
			if (signalDecision?.kind === "return") return signalDecision.result;

			// CORE-4 extraction 2: failed-task handling. ctx is already synced
			// from the top-of-loop sync (RT-15); handleFailedTask mutates ctx
			// in-place and returns a SchedulerDecision.
			const failedDecision = await handleFailedTask(ctx);
			tasks = ctx.tasks;
			manifest = ctx.manifest;
			if (failedDecision?.kind === "return") {
				// #4 (completeness): route the failed-run short-circuit through
				// finalizeRun so the summary artifact + health snapshot + policy
				// decisions are written (previously bypassed — failed runs had no
				// closeout artifacts). handleFailedTask already set manifest status
				// to "failed" and saved tasks; finalizeRun re-derives the status
				// (still "failed" since a failed task exists — the `if (failed)`
				// branch in finalizeRun takes priority) and performs the closeout
				// writes. Policy-decision semantics are UNCHANGED — finalizeRun
				// uses identical logic for both the normal-completion and
				// failed-short-circuit paths.
				const failedResult = await finalizeRun(ctx);
				manifest = ctx.manifest;
				tasks = ctx.tasks;
				return failedResult;
			}
			if (failedDecision?.kind === "continue") continue;

			// CORE-4 extraction 3: batch selection. ctx is already synced from
			// the top-of-loop sync (RT-15); selectDispatchBatch computes the
			// ready batch and returns a dispatch decision (or return if the run
			// must block/abort). The caller syncs ctx.wfMachine back because
			// the function may advance phases.
			const dispatchDecision = await selectDispatchBatch(ctx);
			tasks = ctx.tasks;
			manifest = ctx.manifest;
			wfMachine = ctx.wfMachine;
			if (dispatchDecision.kind === "return") return dispatchDecision.result;
			if (dispatchDecision.kind !== "dispatch") continue;
			// CORE-4 extraction 4: dispatch execution. Sync mutable locals into
			// ctx; dispatchBatch runs before_task_start hooks, builds coalesced
			// dispatch units, pre-warms the stable-prefix cache, and adds each
			// unit's promise to ctx.pendingUnits (wrapped in executeWithRetry).
			// The function mutates ctx.tasks (hook skips) and ctx.manifest (hook
			// status) in-place. ctx is already synced from the top-of-loop sync.
			await dispatchBatch(ctx, dispatchDecision);
			tasks = ctx.tasks;
			manifest = ctx.manifest;

			// ── OPT-01 wait phase: if no units are in-flight (e.g. all ready tasks
			// were hook-skipped or readyBatch was empty), re-loop to re-evaluate. ──
			if (ctx.pendingUnits.size === 0) continue;

			// CORE-4 extraction 5: wait/merge. Sync ctx; mergeUnitResult awaits
			// Promise.race on the in-flight units, merges the first settled result
			// into manifest/tasks under the run lock (loadRunManifestById +
			// mergeTaskUpdatesPreservingTerminal), deletes it from
			// ctx.pendingUnits, and records the merge outcome on ctx. Returns null
			// (continue to phase/budget check) — a return decision is reserved for
			// future run-complete/failure detection.
			const mergeDecision = await mergeUnitResult(ctx);
			tasks = ctx.tasks;
			manifest = ctx.manifest;
			if (mergeDecision?.kind === "return") return mergeDecision.result;
			// Re-derive the merge outcome locals for the post-merge inline logic
			// (cancel-during-exec check + batch summary artifact).
			const { taskIds: settledTaskIds, result: resultToMerge } = ctx.settledMerge!;

			// CORE-4 extraction 6: workflow phase advance. ctx.wfMachine is
			// already synced from the top-of-loop sync (RT-15);
			// advanceWorkflowPhases advances phases whose tasks are all terminal,
			// emits phase_* events, and advances currentPhaseIndex. Mutates
			// ctx.wfMachine in-place.
			await advanceWorkflowPhases(ctx);
			wfMachine = ctx.wfMachine;

			// CORE-4 extraction 7: budget enforcement. ctx is already synced
			// from the top-of-loop sync (RT-15); enforceRunBudget checks
			// cumulative usage against warn/abort thresholds and a fair-share
			// heuristic. On abort it marks the run failed and returns
			// { kind: "return" }; otherwise emits warning events and returns
			// null (continue).
			const budgetDecision = await enforceRunBudget(ctx);
			tasks = ctx.tasks;
			manifest = ctx.manifest;
			if (budgetDecision?.kind === "return") return budgetDecision.result;

			const cancelledResult = resultToMerge.manifest.status === "cancelled" ? resultToMerge : undefined;
			if (cancelledResult || input.signal?.aborted) {
				const reason = input.signal?.aborted ? cancellationReasonFromSignal(input.signal) : undefined;
				const message = reason?.message ?? cancelledResult?.manifest.summary ?? "Run cancelled during task execution.";
				manifest = setRunStatusRunning(manifest);
				manifest = updateRunStatus(manifest, "cancelled", message);
				// CANCEL-2: re-cancel non-terminal tasks here, mirroring the batch-loop
				// cancel check at team-runner.ts:~925. A manifest cancelled mid-merge
				// (e.g. signal abort during the merge's awaits) would otherwise save
				// tasks without the cancel applied, leaving status=cancelled but tasks
				// showing completed/running -- inconsistent and breaks handleRetry's
				// filter for failed/cancelled tasks. Terminal tasks are NOT clobbered.
				const cancelMessage = reason ? `${message} (${reason.code})` : message;
				const reCancelledTasks = cancelNonTerminalTasks(tasks, "cancelled", cancelMessage);
				await saveRunTasksAsync(manifest, reCancelledTasks);
				saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, reCancelledTasks, runtimeKind));
				await saveRunManifestAsync(manifest);
				await appendEventAsync(manifest.eventsPath, {
					type: "run.cancelled",
					runId: manifest.runId,
					message,
					data: {
						reason,
						phase: "task-batch",

						cancelledResultRunId: cancelledResult?.manifest.runId,
					},
				});
				return { manifest, tasks: reCancelledTasks };
			}
			queueIndex = buildTaskGraphIndex(tasks);
			const injectedAfterBatch = await attemptAdaptivePlan();
			if (injectedAfterBatch.missing) {
				tasks = markBlocked(tasks, "Adaptive planner did not produce a valid subagent plan.");
				await saveRunTasksAsync(manifest, tasks);
				saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
				manifest = updateRunStatus(manifest, "blocked", "Adaptive planner did not produce a valid subagent plan.");
				return { manifest, tasks };
			}
			if (injectedAfterBatch.injected) {
				manifest = requiresPlanApproval(workflow, input.runtimeConfig)
					? await ensurePlanApprovalRequested(manifest, tasks)
					: manifest;
				queueIndex = buildTaskGraphIndex(tasks);
			} else if (
				requiresPlanApproval(workflow, input.runtimeConfig) &&
				(hasPendingMutatingAdaptiveTask(tasks) || hasPendingMutatingTaskAtBoundary(tasks))
			) {
				manifest = await ensurePlanApprovalRequested(manifest, tasks);
			}
			if (manifest.planApproval?.status === "cancelled") {
				tasks = cancelPlanTasks(tasks, "Plan approval was cancelled.");
				await saveRunTasksAsync(manifest, tasks);
				saveCrewAgents(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
				manifest = updateRunStatus(manifest, "cancelled", "Plan approval was cancelled.");
				return { manifest, tasks };
			}
			await saveRunTasksAsync(manifest, tasks);
			// P0-3: per-batch progress write — coalesced (best-effort, no lock) so the
			// sync spin-lock (Atomics.wait) doesn't block the event loop every batch.
			// The terminal saveCrewAgents at closeout remains durable + flushes this.
			saveCrewAgentsCoalesced(manifest, recordsForMaterializedTasks(manifest, tasks, runtimeKind));
			const completedBatch = tasks.filter((t) => settledTaskIds.includes(t.id));
			const batchArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "summary",
				relativePath: `batches/${batchSummarySlug(settledTaskIds)}.md`,
				producer: "team-runner",
				content: aggregateTaskOutputs(completedBatch, manifest),
			});
			const groupDelivery = deliverGroupJoin({
				manifest,
				mode: resolveGroupJoinMode(input.runtimeConfig),
				batch: completedBatch,
				allTasks: tasks,
			});
			manifest = {
				...manifest,
				artifacts: mergeArtifacts([
					...manifest.artifacts,
					batchArtifact,
					...(groupDelivery?.artifact ? [groupDelivery.artifact] : []),
				]),
			};
			manifest = writeProgress(manifest, tasks, "team-runner", input.executeWorkers, input.runtimeConfig);
			await saveRunManifestAsync(manifest);
		}

		// CORE-4 extraction 8: finalization. Sync ctx; finalizeRun computes the
		// final run status (failed/blocked/completed), writes the summary artifact
		// + health snapshot, performs the joint atomic manifest+tasks save, and
		// returns the terminal { manifest, tasks } result. Sync the locals back
		// from ctx so the finally block observes consistent state.
		const finalResult = await finalizeRun(ctx);
		manifest = ctx.manifest;
		tasks = ctx.tasks;
		return finalResult;
	} finally {
		// #3: drainPendingUnits returns settled outcomes, but the finally block
		// only needs the drain side-effect (abort + await + clear); the return
		// value is intentionally unused here.
		await drainPendingUnits(pendingUnits, runController);
	}
}
