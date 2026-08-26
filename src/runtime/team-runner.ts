import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { CrewLimitsConfig, CrewReliabilityConfig, CrewRuntimeConfig } from "../config/config.ts";
import { appendHookEvent, executeHook } from "../hooks/registry.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { atomicWriteFile } from "../state/atomic-write.ts";
import { canTransitionRunStatus } from "../state/contracts.ts";
import { appendEvent, appendEventAsync, flushEventLogBuffer } from "../state/event-log/event-log.ts";
import { hashArtifactContent as hashContent, writeArtifact } from "../state/stores/artifact-store.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import { drainPendingUnits, enforceRunBudget, terminaliseRunWithDrain } from "./budget-enforcement.ts";
import { readCrewAgents, saveCrewAgents, saveCrewAgentsCoalesced } from "./crew-agent-records.ts";
import type { CrewRuntimeKind } from "./crew-agent-runtime.ts";
import { crewHooks } from "./crew-hooks.ts";
import { cancelNonTerminalTasks, dispatchBatch, markBlocked, selectDispatchBatch } from "./dispatch-batch.ts";
import { finalizeRun, lastProgressContentHash, writeProgress } from "./finalize-run.ts";
import { applyGoalAchievement, assessGoalAchievement } from "./goal-workflow/goal-achievement.ts";
import { deliverGroupJoin, resolveGroupJoinMode } from "./group-join.ts";
import { terminateLiveAgentsForRun } from "./live-session/live-agent-manager.ts";
import { isRunTerminalPreserved, mergeUnitResult } from "./merge-loop.ts";
import { resolveTaskRuntimeKind } from "./model/runtime-policy.ts";
import type { CrewRuntimeCapabilities } from "./model/runtime-resolver.ts";
import { ensurePlanApprovalRequested, isMutatingTask, isPlanApprovalDenied, requiresPlanApproval } from "./plan-approval.ts";
import { buildSyntheticTerminalEvidence, cancellationReasonFromSignal } from "./process/cancellation.ts";
import { shouldRerunFailedTask } from "./recovery/recovery-recipes.ts";
import { registerRunPromise, rejectRunPromise, resolveRunPromise } from "./run-tracker.ts";
import type { PendingUnit, SchedulerContext, SchedulerDecision } from "./scheduler-context.ts";
import { buildTaskGraphIndex, refreshTaskGraphQueues } from "./scheduling/task-graph-scheduler.ts";
import { recordsForMaterializedTasks } from "./task-display.ts";
import { aggregateTaskOutputs, createResultArtifactReadCache } from "./task-output-context.ts";
import { clearStablePrefixCache } from "./task-runner/prompt-builder.ts";
import { mergeArtifacts } from "./team-runner-artifacts.ts";
import { clearTrackedTaskUsage } from "./usage-tracker.ts";
import { advanceWorkflowPhases } from "./workflow-phase-advance.ts";
import { createWorkflowStateMachine, type PhaseState } from "./workflow-state.ts";

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

function startPerfSampler(manifest: TeamRunManifest, team: TeamConfig, signal?: AbortSignal): void {
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
			{ detached: true, stdio: ["ignore", "ignore", "pipe"], signal },
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
		// R11-4 (LOW, §ROUND 11): sampler linger-orphan hardening — pass the run
		// AbortSignal so the detached sampler dies on run teardown, not just on
		// parent death. ROUND 12: console → logInternalError, explicit "warn"
		// severity (default "debug" would be PI_TEAMS_DEBUG-gated and hide this).
		logInternalError("team-runner.perf-sampler.spawn-failed", err, `runId=${manifest.runId}`, "warn");
	}
}

function schedulePerfAnalyze(manifest: TeamRunManifest, team: TeamConfig, signal?: AbortSignal): void {
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
				{ detached: true, stdio: "ignore", signal },
			);
			child.unref();
		} catch (err) {
			// R11-4 (LOW, §ROUND 11): same abort-kill hardening as the sampler.
			// ROUND 12: console → logInternalError, explicit "warn" severity.
			logInternalError("team-runner.perf-analyze.spawn-failed", err, `runId=${manifest.runId}`, "warn");
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

// checkPerTaskBudget / PerTaskBudgetCheckResult moved to ./budget-enforcement.ts
// (2026-08 Phase 2.6) — re-exported below so existing test imports still resolve.

// isNonTerminalTaskStatus, safeFinishedAt, isMalformedFinishedAtReplacement,
// statusMergeKey, REJECTED_STATUS_MERGE_TRANSITIONS, shouldMergeTaskUpdate,
// __test__shouldMergeTaskUpdate, mergeTaskUpdatesPreservingTerminal,
// __test__mergeTaskUpdates — moved to ./merge-gate.ts (2026-08-10
// improvement-plan Tier 2 team-runner split, self-contained portion).
// Re-imported below to preserve all in-file callers.
// findStep / findAgent / markBlocked / cancelNonTerminalTasks moved to
// ./dispatch-batch.ts (2026-08 Phase 2.6) — re-imported above.

// 2.8: adaptive-plan parsing/repair/injection moved to src/runtime/goal-workflow/adaptive-plan.ts.
// Re-export the test-only helpers so existing test imports still resolve.
export {
	__test__parseAdaptivePlan,
	__test__repairAdaptivePlan,
} from "./goal-workflow/adaptive-plan.ts";

// Merge-gate extracted to ./merge-gate.ts (2026-08-10 improvement-plan Tier 2).
// Re-export the test-only helpers so existing test imports still resolve.
export { __test__mergeTaskUpdates, __test__shouldMergeTaskUpdate } from "./merge-gate.ts";

import { getActiveBrokerRevoker } from "./broker/broker-issuer.ts";
import { injectAdaptivePlanIfReady, isAdaptiveWorkflow } from "./goal-workflow/adaptive-plan.ts";
// MuxSurface A1 (spec §7 D3 + §8.3): run-scoped surface-degrade controller —
// child-pi layer notifies spawn/exit/degrade through the registry keyed by
// runId; this runner owns policy (lockout), persistence (manifest.surface) and
// the headless re-dispatch of degraded units.
import {
	clearSurfaceRuntimeController,
	createSurfaceRuntimeController,
	normalizeSurfaceState,
	planHeadlessRedeplays,
	registerSurfaceRuntimeController,
} from "./surface/degrade.ts";

// formatTaskProgress / runEffectivenessLines / scratchpadSummaryLines /
// lastProgressContentHash / writeProgress moved to ./finalize-run.ts (2026-08
// Phase 2.6) — re-imported above for the core-loop progress writes; seams
// re-exported below so existing test imports still resolve.

/** @internal RT-7 test export — verify cache is keyed on runId (stable string). */
/** @internal RT-7 test export — exercise writeProgress directly. */
export { __test__lastProgressContentHash, __test__writeProgress } from "./finalize-run.ts";
/** @internal RT-14 test export — verify cancelPlanTasks preserves graph mutation after consolidation. */
export const __test__cancelPlanTasks = cancelPlanTasks;

// Budget-enforcement family moved to ./budget-enforcement.ts (2026-08 Phase 2.6).
// Re-export the public + test-only helpers so existing test imports still resolve.
export { checkPerTaskBudget, type DrainOutcome, drainPendingUnits, type PerTaskBudgetCheckResult } from "./budget-enforcement.ts";
/** @internal 1.9(b) test export — exercise selectDispatchBatch directly. */
export { __test__selectDispatchBatch } from "./dispatch-batch.ts";
/** @internal R15-1 test export — exercise finalizeRun directly (disk-terminal preservation). */
export { __test__finalizeRun } from "./finalize-run.ts";
/** @internal 1.9(b) test export — exercise mergeUnitResult directly. */
export { __test__mergeUnitResult } from "./merge-loop.ts";
// 1.9(b): characterization test seams for the Phase 2.6 extraction targets
// (selectDispatchBatch / mergeUnitResult / advanceWorkflowPhases /
// requiresPlanApproval / ensurePlanApprovalRequested). These functions are
// module-private today; re-exporting them lets tests pin CURRENT behavior
// BEFORE the CORE-4 extraction moves them into scheduler/ modules.
// Plan-approval family extracted to ./plan-approval.ts (2026-08 Phase 2.6).
// Re-export the test-only helpers so existing test imports still resolve.
export { __test__ensurePlanApprovalRequested, __test__requiresPlanApproval } from "./plan-approval.ts";
/** @internal 1.9(b) test export — exercise advanceWorkflowPhases directly. */
export { __test__advanceWorkflowPhases } from "./workflow-phase-advance.ts";

// applyPolicy moved to ./finalize-run.ts (2026-08 Phase 2.6) — it is only
// used by finalizeRun, which also moved there.

// shouldUseRetry / failedTaskFrom / retryPolicyFromConfig moved to
// ./dispatch-batch.ts (2026-08 Phase 2.6) — shouldUseRetry re-exported
// below so existing test imports still resolve.
export { shouldUseRetry } from "./dispatch-batch.ts";

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

// drainPendingUnits / DrainOutcome moved to ./budget-enforcement.ts (2026-08
// Phase 2.6) — re-exported below so existing test imports still resolve.

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
	// auto-stops when the runner dies, so no explicit cleanup needed. R11-4:
	// input.signal is threaded so run teardown/cancel also kills the sampler.
	startPerfSampler(manifest, input.team, input.signal);

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
		// child transcripts are flushed). Never affects run outcome. R11-4: thread
		// input.signal so the analyze child dies on run teardown too.
		schedulePerfAnalyze(manifest, input.team, input.signal);
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
		} catch (error) {
			// H8 (2026-08-10): surface the silent failure. This is the
			// unhandled-error recovery branch — if the state save ALSO fails
			// (disk full, run-dir gone, permissions), the manifest stays in
			// its pre-failure state (possibly still "running") and crash
			// recovery will treat it as stale. Previously the failure was
			// swallowed with no signal; now it lands in the internal-error
			// channel so operators can see when recovery itself failed.
			// We do NOT re-throw — the run must still be reported as failed
			// to the caller (rejectRunPromise below) regardless of state-save
			// outcome.
			logInternalError(
				"team-runner.recovery-save-failed",
				error instanceof Error ? error : new Error(String(error)),
				`runId=${manifest.runId} — state may be inconsistent; crash-recovery will reconcile on next launch`,
			);
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
// Moved to ./scheduler-context.ts (2026-08 Phase 2.6) — SchedulerContext,
// SettledUnit, PendingUnit, SchedulerDecision now live there and are
// re-imported above. This comment marks the extraction boundary in the
// scheduler loop below.

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
// terminaliseRunWithDrain moved to ./budget-enforcement.ts (2026-08 Phase 2.6)
// — handleFailedTask imports it from there.

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

// mergeUnitResult / isRunTerminalPreserved moved to ./merge-loop.ts (2026-08
// Phase 2.6) — re-imported above for the core-loop merge + terminal break.

// enforceRunBudget moved to ./budget-enforcement.ts (2026-08 Phase 2.6) — the
// scheduler loop imports it from there.

// finalizeRun moved to ./finalize-run.ts (2026-08 Phase 2.6) — the scheduler
// loop imports it from there; __test__finalizeRun is re-exported above.

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
	const canInjectAdaptivePlan = isAdaptiveWorkflow(workflow);
	let adaptivePlanInjected = false;
	let adaptivePlanMissing = false;
	const attemptAdaptivePlan = async () => {
		if (!canInjectAdaptivePlan || adaptivePlanInjected || adaptivePlanMissing) return { injected: false, missing: false };
		const adaptivePlan = await injectAdaptivePlanIfReady({
			manifest,
			tasks,
			workflow,
			team: input.team,
			executeWorkers: input.executeWorkers,
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
	if (isPlanApprovalDenied(manifest)) {
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
	// R6-F2 (W2): store the listener reference so the finally block can
	// removeEventListener() it — { once: true } alone only auto-removes when the
	// listener FIRES; when the run finishes before the caller's signal aborts,
	// the listener would otherwise stay attached to input.signal (long-lived
	// session signal → leak accumulates per run). Mirrors child-executor.ts.
	let externalAbortListener: (() => void) | undefined;
	if (input.signal) {
		if (input.signal.aborted) runController.abort();
		else {
			externalAbortListener = () => runController.abort();
			input.signal.addEventListener("abort", externalAbortListener, { once: true });
		}
	}

	// R10-1: per-run result-artifact read cache. The batch closeout below
	// aggregates every settled batch TWICE (batch-summary artifact + group-join
	// delivery) — the second aggregation re-reads each `results/<taskId>.txt`
	// from disk for no benefit. Keyed by artifact path + descriptor identity
	// (sizeBytes|contentHash), so a retry that rewrites the artifact misses and
	// re-reads. Passed to both closeout call sites AND (via SchedulerContext →
	// baseInput) to collectDependencyOutputContext's dep reads; see
	// task-output-context.ts.
	const resultReadCache = createResultArtifactReadCache();

	// ── MuxSurface A1 (spec §7 D3): per-run degrade controller ─────────────
	// Owned here because only this runner may mutate manifest/tasks/events; the
	// child-pi surface branch reaches it through the registry keyed by runId.
	// Broker token revocation resolves lazily AT degrade time (the broker can
	// start mid-run on the first credential request).
	const surfaceController = createSurfaceRuntimeController({
		runId: manifest.runId,
		eventsPath: manifest.eventsPath,
		revoke: (taskId) => getActiveBrokerRevoker()?.(taskId),
	});
	registerSurfaceRuntimeController(surfaceController);
	// Re-dispatch-once guard: a degraded task is replayed headless exactly once
	// per run — repeated loss lands in needs_attention for a human instead of a
	// mux-flap respawn loop (spec §7 anti-flap).
	const surfaceLossHandled = new Set<string>();
	// Pure merge of the controller snapshot onto ANY manifest view (callers pass
	// either the closure local or ctx.manifest so the freshest state wins).
	const attachSurfaceSnapshot = (target: TeamRunManifest): TeamRunManifest => ({
		...target,
		surface: normalizeSurfaceState(surfaceController.snapshot()),
	});

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
		resultReadCache,
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
			// R15-2: a terminal status observed after the merge (the DISK manifest
			// went terminal during the batch — external cancel/reconciler/finalizer
			// write) must stop dispatching and route to finalizeRun so the disk
			// terminal becomes the final status (run stops dispatching; final status
			// = disk terminal). The CANCEL-2 block below handles worker-reported
			// cancel / signal abort (where the merge forces "running" from a
			// non-terminal disk) and is UNCHANGED; this only fires when the merged
			// manifest carries a preserved disk-terminal status.
			if (isRunTerminalPreserved(manifest.status)) {
				break;
			}
			// Re-derive the merge outcome locals for the post-merge inline logic
			// (cancel-during-exec check + batch summary artifact).
			const { taskIds: settledTaskIds, result: resultToMerge } = ctx.settledMerge!;

			// ── MuxSurface A1 (spec §7 steps 4–5): drain degrades → re-dispatch
			// headless. Runs BEFORE phase advance so a degraded task is `queued`
			// again while the scheduler still sees this tick's state, and before
			// handleFailedTask can ever observe needs_attention leftovers.
			const surfaceDegraded = surfaceController.takeDegraded();
			if (surfaceDegraded.length > 0) {
				const replay = planHeadlessRedeplays({
					tasks: ctx.tasks,
					degraded: surfaceDegraded,
					handledTaskIds: surfaceLossHandled,
				});
				ctx.tasks = replay.tasks;
				tasks = ctx.tasks;
				if (replay.requeuedTaskIds.length > 0) {
					await appendEventAsync(manifest.eventsPath, {
						type: "surface.requeued",
						runId: manifest.runId,
						message: `Re-dispatched ${replay.requeuedTaskIds.length} surface-degraded task(s) headless: ${replay.requeuedTaskIds.join(", ")}`,
						data: {
							taskIds: replay.requeuedTaskIds,
							skipped: replay.skipped,
							resumeComponents: ["rendered-prompt", "scratchpad-restore", "pendingSteers-replay", "resume-note"],
						},
					});
				}
			}

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
			if (isPlanApprovalDenied(manifest)) {
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
				content: aggregateTaskOutputs(completedBatch, manifest, resultReadCache),
			});
			const groupDelivery = deliverGroupJoin({
				manifest,
				mode: resolveGroupJoinMode(input.runtimeConfig),
				batch: completedBatch,
				allTasks: tasks,
				// R10-1: reuse the batch-summary reads for the group-join body
				// (same settled batch → same artifacts → cache hits, zero disk ops).
				cache: resultReadCache,
			});
			manifest = {
				...manifest,
				artifacts: mergeArtifacts([
					...manifest.artifacts,
					batchArtifact,
					...(groupDelivery?.artifact ? [groupDelivery.artifact] : []),
				]),
			};
			// MuxSurface A1 (§8.3): persist the run-scoped pane/pid/lockout snapshot
			// with the batch manifest write — panes recorded this tick become
			// visible to doctor/zombie-sweep and a crash mid-run leaves at most
			// one tick of stale pane records.
			manifest = attachSurfaceSnapshot(manifest);
			manifest = writeProgress(manifest, tasks, "team-runner", input.executeWorkers, input.runtimeConfig);
			await saveRunManifestAsync(manifest);
		}

		// CORE-4 extraction 8: finalization. Sync ctx; finalizeRun computes the
		// final run status (failed/blocked/completed), writes the summary artifact
		// + health snapshot, performs the joint atomic manifest+tasks save, and
		// returns the terminal { manifest, tasks } result. Sync the locals back
		// from ctx so the finally block observes consistent state.
		// Last degrade drain: a pane that died during the closeout still gets its
		// headless replay attempt if any scheduler work remains, else it stays
		// needs_attention for resume — never silently dropped from the manifest.
		const finalDegraded = surfaceController.takeDegraded();
		if (finalDegraded.length > 0) {
			const finalReplay = planHeadlessRedeplays({
				tasks: ctx.tasks,
				degraded: finalDegraded,
				handledTaskIds: surfaceLossHandled,
			});
			ctx.tasks = finalReplay.tasks;
		}
		ctx.manifest = attachSurfaceSnapshot(ctx.manifest);
		const finalResult = await finalizeRun(ctx);
		manifest = ctx.manifest;
		tasks = ctx.tasks;
		return finalResult;
	} finally {
		// MuxSurface A1: drop the run's registry entry FIRST — no in-flight
		// notify after teardown may resurrect policy state into the next run.
		clearSurfaceRuntimeController(manifest.runId);
		// #3: drainPendingUnits returns settled outcomes, but the finally block
		// only needs the drain side-effect (abort + await + clear); the return
		// value is intentionally unused here.
		await drainPendingUnits(pendingUnits, runController);
		// R6-F2 (W2): release the caller-signal listener on every exit path.
		// Removed AFTER the drain so caller-signal aborts during teardown still
		// propagate to runController (exact pre-fix semantics); once the run is
		// fully drained the listener is dead weight — { once: true } never
		// auto-removes it when the signal never fired (child-executor.ts pattern).
		if (externalAbortListener && input.signal) {
			input.signal.removeEventListener("abort", externalAbortListener);
		}
	}
}
