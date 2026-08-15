/**
 * Per-task run budget enforcement for the team-run scheduler loop.
 *
 * Extracted from team-runner.ts (2026-08, Phase 2.6 maintainability split —
 * CORE-4 extraction 7 + the RT-NEW-2 terminaliseRunWithDrain/drainPendingUnits
 * cluster it depends on). Pure code motion: checkPerTaskBudget /
 * PerTaskBudgetCheckResult / DrainOutcome / drainPendingUnits /
 * terminaliseRunWithDrain / enforceRunBudget moved verbatim.
 *
 * drainPendingUnits + terminaliseRunWithDrain land here (not a separate
 * shared file) so budget-enforcement.ts stays self-contained and the
 * team-runner.ts ↔ budget-enforcement.ts import direction stays one-way
 * (team-runner imports from here; this module never imports from
 * team-runner.ts — checkPerTaskBudget was moved here for exactly that
 * reason: enforceRunBudget calls it, and importing it back from
 * team-runner.ts would create a cycle).
 */
import { flushPendingAtomicWrites } from "../state/atomic-write.ts";
import { withRunLock } from "../state/coordination/locks.ts";
import { appendEventAsync } from "../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasksAsync, updateRunStatus } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { aggregateUsage, formatTokens } from "../state/usage.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { saveCrewAgents } from "./crew-agent-records.ts";
import { cancelNonTerminalTasks, markBlocked } from "./dispatch-batch.ts";
import { isNonTerminalTaskStatus, mergeTaskUpdatesPreservingTerminal } from "./merge-gate.ts";
import type { SchedulerContext, SchedulerDecision } from "./scheduler-context.ts";
import { recordsForMaterializedTasks } from "./task-display.ts";
import { mergeArtifacts } from "./team-runner-artifacts.ts";

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
export async function terminaliseRunWithDrain(
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
export async function enforceRunBudget(ctx: SchedulerContext): Promise<SchedulerDecision | null> {
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
			// ROUND 12: console → logInternalError with explicit "warn" severity
			// (run-termination event — operator channel; default "debug" is gated).
			logInternalError("team-runner.budget-abort", new Error(message), `runId=${manifest.runId}`, "warn");
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
			// ROUND 12: console → logInternalError, explicit "warn" severity.
			logInternalError("team-runner.budget-warning", new Error(message), `runId=${manifest.runId}`, "warn");
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
			// ROUND 12: console → logInternalError, explicit "warn" severity.
			logInternalError("team-runner.fair-share", new Error(message), `runId=${manifest.runId} taskId=${violatorId}`, "warn");
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
