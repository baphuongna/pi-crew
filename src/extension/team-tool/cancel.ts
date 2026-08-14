import { appendHookEvent, executeHook } from "../../hooks/registry.ts";
import { killProcessPid } from "../../runtime/child-pi/child-pi.ts";
import { recordFromTask, saveCrewAgents } from "../../runtime/crew-agent-records.ts";
import { writeForegroundInterruptRequest } from "../../runtime/foreground-control.ts";
import { terminateLiveAgentsForRun } from "../../runtime/live-session/live-agent-manager.ts";
import {
	buildSyntheticTerminalEvidence,
	type CancellationReason,
	cancellationReasonFromUnknown,
} from "../../runtime/process/cancellation.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLockSync } from "../../state/coordination/locks.ts";
import { appendEvent, appendEventAsync } from "../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../../state/stores/state-store.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { type CacheControlDeps, invalidateSnapshot } from "./cache-control.ts";
import { result, type TeamContext } from "./context.ts";
import { enforceDestructiveIntent, intentFromConfig } from "./intent-policy.ts";
import { paramRequired } from "./param-error.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

/** Retryable terminal statuses (a task in one of these can be re-queued). */
const RETRYABLE_STATUSES: ReadonlySet<string> = new Set(["failed", "cancelled"]);

/**
 * Decision for `action='retry'`: a run whose manifest status is "completed"
 * (terminal success) and has no retryable tasks has nothing to retry. Returns
 * true so the caller short-circuits with a clear message instead of retrying.
 *
 * R13-3 fold: the caller MUST evaluate this on FRESH state read INSIDE the
 * run lock — a pre-lock decision on a best-effort snapshot could wrongly
 * refuse a run that was re-queued/failed on disk (finding #4,
 * real-test-2026-08-10-full-9-tier). Kept as a short-circuit so a completed
 * async run does not surface a misleading "run.lock is locked by another
 * operation" error from a stale lock file left behind by that run.
 *
 * Exported for unit testing (handleRetry itself needs filesystem state).
 */
export function retryShortCircuitsCompleted(
	runStatus: string,
	tasks: ReadonlyArray<{ id: string; status: string }>,
	targetTaskId?: string,
): boolean {
	if (runStatus !== "completed") return false;
	return !tasks.some((task) => (targetTaskId ? task.id === targetTaskId : true) && RETRYABLE_STATUSES.has(task.status));
}

export interface AbortOwnedResult {
	abortedIds: string[];
	missingIds: string[];
	foreignIds: string[];
}

/**
 * Classify task IDs by ownership.
 * - Tasks with status "queued" or "running" that belong to the current session → abortedIds
 * - Task IDs not found in the run → missingIds
 * - Tasks with status "queued" or "running" that belong to a different session → foreignIds
 * - Tasks already completed/failed/cancelled → neither (not included in any list)
 *
 * Currently, task ownership is determined by the manifest's run-level ownership.
 * Since tasks in a single run are all owned by the session that created the run,
 * the ownerSessionId comes from the context. Foreign detection compares
 * the requesting session against the run's creating session.
 */
export function abortOwned(runId: string, taskIds: string[] | undefined, ctx: TeamContext, force?: boolean): AbortOwnedResult {
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd) return { abortedIds: [], missingIds: taskIds ?? [], foreignIds: [] };
	const loaded = loadRunManifestById(runCwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return { abortedIds: [], missingIds: taskIds ?? [], foreignIds: [] };

	const result: AbortOwnedResult = {
		abortedIds: [],
		missingIds: [],
		foreignIds: [],
	};
	const taskMap = new Map(loaded.tasks.map((t) => [t.id, t] as const));
	const targetIds = taskIds ?? loaded.tasks.map((t) => t.id);
	const foreignRun = typeof loaded.manifest.ownerSessionId === "string" && loaded.manifest.ownerSessionId !== ctx.sessionId;

	for (const id of targetIds) {
		const task = taskMap.get(id);
		if (!task) {
			result.missingIds.push(id);
			continue;
		}
		if (task.status !== "queued" && task.status !== "running" && task.status !== "waiting") continue;
		if (foreignRun && force !== true) {
			result.foreignIds.push(id);
			continue;
		}
		result.abortedIds.push(id);
	}

	return result;
}

function configFromParams(params: TeamToolParamsValue): Record<string, unknown> | undefined {
	return params.config && typeof params.config === "object" && !Array.isArray(params.config) ? params.config : undefined;
}

function cancelReasonFromParams(params: TeamToolParamsValue): CancellationReason {
	const config = configFromParams(params);
	const rawReason = config?.reason ?? config?.cancelReason;
	const reason =
		rawReason === undefined
			? {
					code: "caller_cancelled" as const,
					message: "Run cancelled by user request.",
				}
			: cancellationReasonFromUnknown(rawReason);
	return { code: reason.code, message: reason.message };
}

export async function handleRetry(params: TeamToolParamsValue, ctx: TeamContext, deps?: CacheControlDeps): Promise<PiTeamsToolResult> {
	if (!params.runId)
		return result(
			paramRequired("retry", "runId", "{ action: 'retry', runId: 'team_...' }"),
			{ action: "retry", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "retry", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "retry", status: "error" }, true);

	// Pre-lock ownership check: reject foreign-owned runs unless force is set
	const foreignRun = typeof loaded.manifest.ownerSessionId === "string" && loaded.manifest.ownerSessionId !== ctx.sessionId;
	if (foreignRun && params.force !== true) {
		return result(
			`Run ${loaded.manifest.runId} belongs to another session. Use force: true to override.`,
			{ action: "retry", status: "error", runId: loaded.manifest.runId },
			true,
		);
	}

	// Execute before_retry hook after ownership confirmed, before mutation lock
	const hookReport = await executeHook("before_retry", {
		runId: loaded.manifest.runId,
		cwd: ctx.cwd,
	});
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		return result(
			`Retry blocked by hook: ${hookReport.reason ?? "before_retry hook blocked the operation."}`,
			{ action: "retry", status: "error", runId: loaded.manifest.runId },
			true,
		);
	}

	const targetTaskId = typeof params.taskId === "string" ? params.taskId : undefined;

	return withRunLockSync(loaded.manifest, () => {
		// R13-1 (2026-08-14): fresh re-read INSIDE the lock. `loaded` was captured
		// lock-free BEFORE the unbounded before_retry hook gap; a concurrent writer
		// may have completed the run or re-queued tasks on disk. All decisions and
		// writes below derive from `fresh` — never from the stale `loaded` snapshot.
		const fresh = loadRunManifestById(loaded.manifest.cwd, params.runId!); // NOTE: inside withRunLockSync - consistent read
		if (!fresh) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "retry", status: "error" }, true);

		// Terminal-status check on FRESH in-lock state (R13-3 fold): a completed
		// run has nothing to retry. Short-circuit with a clear message instead of
		// surfacing a misleading "run.lock is locked by another operation" error
		// from a stale lock file left by a completed async run (finding #4 in
		// real-test-2026-08-10-full-9-tier).
		if (retryShortCircuitsCompleted(fresh.manifest.status, fresh.tasks, targetTaskId)) {
			return result(
				`Run ${fresh.manifest.runId} is already completed; retry only applies to failed/cancelled runs.`,
				{ action: "retry", status: "error", runId: fresh.manifest.runId },
				true,
			);
		}

		const retryableStatuses: ReadonlySet<string> = new Set(["failed", "cancelled"]);

		const matchingTasks = fresh.tasks.filter((task) => {
			if (targetTaskId && task.id !== targetTaskId) return false;
			return retryableStatuses.has(task.status);
		});

		if (matchingTasks.length === 0) {
			return result(
				targetTaskId ? `Task '${targetTaskId}' is not failed/cancelled; nothing to retry.` : "No failed/cancelled tasks to retry.",
				{
					action: "retry",
					status: "error",
					runId: fresh.manifest.runId,
				},
				true,
			);
		}

		const retriedIds = new Set(matchingTasks.map((t) => t.id));
		const tasks = fresh.tasks.map((task) => {
			if (!retriedIds.has(task.id)) return task;
			const { error: _error, finishedAt: _finishedAt, terminalEvidence: _terminalEvidence, ...rest } = task;
			return { ...rest, status: "queued" as const };
		});
		saveRunTasks(fresh.manifest, tasks);
		try {
			saveCrewAgents(
				fresh.manifest,
				tasks.map((task) => recordFromTask(fresh.manifest, task, "child-process")),
			);
		} catch (error) {
			logInternalError("team-tool.handleRetry.crewAgents", error, `runId=${fresh.manifest.runId}`);
		}

		const retriedTaskIds = [...retriedIds];
		for (const taskId of retriedTaskIds) {
			// H1 (2026-08-10): inside a sync run-lock callback — cannot await;
			// fire-and-forget async. task.retried is informational; the queued
			// status is the authoritative record in tasks.json.
			void appendEventAsync(fresh.manifest.eventsPath, {
				type: "task.retried",
				runId: fresh.manifest.runId,
				taskId,
				message: `Task ${taskId} queued for retry.`,
			}).catch((error) =>
				logInternalError(
					"cancel.retry-event",
					error instanceof Error ? error : new Error(String(error)),
					`runId=${fresh.manifest.runId}`,
				),
			);
		}

		if (deps) invalidateSnapshot(fresh.manifest.runId, runCwd, deps);
		return result(`Retried ${retriedTaskIds.length} task(s) in run ${fresh.manifest.runId}.`, {
			action: "retry",
			status: "ok",
			runId: fresh.manifest.runId,
			retriedTaskIds: retriedTaskIds,
			intent: `retrying ${retriedTaskIds.length} task(s) in ${fresh.manifest.runId}`,
		});
	});
}

export async function handleCancel(params: TeamToolParamsValue, ctx: TeamContext, deps?: CacheControlDeps): Promise<PiTeamsToolResult> {
	const intentError = enforceDestructiveIntent("cancel", params, ctx.config);
	if (intentError) return intentError;
	if (!params.runId)
		return result(
			paramRequired("cancel", "runId", "{ action: 'cancel', runId: 'team_...' }"),
			{ action: "cancel", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "cancel", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "cancel", status: "error" }, true);

	// Pre-lock ownership check: reject foreign-owned runs unless force is set
	const preCheck = abortOwned(loaded.manifest.runId, undefined, ctx, params.force);
	if (preCheck.abortedIds.length === 0 && preCheck.foreignIds.length > 0 && params.force !== true) {
		return result(
			`Run ${loaded.manifest.runId} belongs to another session. Use force: true to override.`,
			{
				action: "cancel",
				status: "error",
				runId: loaded.manifest.runId,
				foreignIds: preCheck.foreignIds,
			},
			true,
		);
	}

	// Execute before_cancel hook after ownership confirmed, before mutation lock
	const hookReport = await executeHook("before_cancel", {
		runId: loaded.manifest.runId,
		cwd: ctx.cwd,
	});
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		return result(
			`Cancel blocked by hook: ${hookReport.reason ?? "before_cancel hook blocked the operation."}`,
			{ action: "cancel", status: "error", runId: loaded.manifest.runId },
			true,
		);
	}
	await terminateLiveAgentsForRun(loaded.manifest.runId, "cancelled", appendEvent, loaded.manifest.eventsPath);

	// Best-effort: kill the async background runner process so it doesn't
	// overwrite the cancelled state while we hold the run lock.
	const asyncPid = loaded.manifest.async?.pid;
	if (asyncPid !== undefined && asyncPid > 0) {
		try {
			killProcessPid(asyncPid);
			// H1 (2026-08-10): informational event in async context — await the
			// async lock path (non-blocking event loop, ~1ms vs ~14ms sync).
			await appendEventAsync(loaded.manifest.eventsPath, {
				type: "async.kill_requested",
				runId: loaded.manifest.runId,
				message: "Sent SIGTERM to background runner process.",
				data: { pid: asyncPid },
			});
		} catch (error) {
			logInternalError("team-tool.handleCancel.killAsync", error, `runId=${loaded.manifest.runId},pid=${asyncPid}`);
		}
	}

	return withRunLockSync(loaded.manifest, () => {
		// R13-2 (2026-08-14): fresh re-read INSIDE the lock. `loaded` was captured
		// lock-free BEFORE the before_cancel hook + live-agent termination gap; a
		// concurrent writer may have completed the run on disk. The terminal-status
		// short-circuit and ALL writes below derive from `fresh` — never flip a
		// terminal status (completed → cancelled) from the stale `loaded` snapshot.
		const fresh = loadRunManifestById(loaded.manifest.cwd, loaded.manifest.runId); // NOTE: inside withRunLockSync - consistent read
		if (!fresh)
			return result(`Run '${loaded.manifest.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "cancel", status: "error" }, true);

		if ((fresh.manifest.status === "completed" || fresh.manifest.status === "cancelled") && params.force !== true)
			return result(
				`Run ${fresh.manifest.runId} is already ${fresh.manifest.status}; nothing to cancel. Use force: true to mark it cancelled anyway.`,
				{
					action: "cancel",
					status: "ok",
					runId: fresh.manifest.runId,
					artifactsRoot: fresh.manifest.artifactsRoot,
				},
			);

		// Classify tasks for foreign-aware cancellation
		const abortResult = abortOwned(fresh.manifest.runId, undefined, ctx, params.force);
		if (abortResult.abortedIds.length === 0 && abortResult.foreignIds.length > 0 && params.force !== true) {
			return result(
				`Run ${fresh.manifest.runId} belongs to another session. Use force: true to override.`,
				{
					action: "cancel",
					status: "error",
					runId: fresh.manifest.runId,
					foreignIds: abortResult.foreignIds,
				},
				true,
			);
		}
		const cancellableIds = new Set(abortResult.abortedIds);
		const cancelReason = cancelReasonFromParams(params);
		const cancelIntent = intentFromConfig(params.config);
		const cancelData = cancelIntent ? { reason: cancelReason.code, intent: cancelIntent } : { reason: cancelReason.code };
		const cancelMessage = `${cancelReason.message} (${cancelReason.code})`;

		const tasks = fresh.tasks.map((task) => {
			if (cancellableIds.has(task.id) && (task.status === "queued" || task.status === "running" || task.status === "waiting")) {
				const base = {
					...task,
					status: "cancelled" as const,
					finishedAt: new Date().toISOString(),
					error: cancelMessage,
				};
				if (task.status === "running") {
					return {
						...base,
						terminalEvidence: [
							...(task.terminalEvidence ?? []),
							buildSyntheticTerminalEvidence("worker", cancelReason, task.startedAt),
						],
					};
				}
				return base;
			}
			return task;
		});
		saveRunTasks(fresh.manifest, tasks);
		try {
			saveCrewAgents(
				fresh.manifest,
				tasks.map((task) => recordFromTask(fresh.manifest, task, fresh.manifest.runtimeResolution?.kind ?? "child-process")),
			);
		} catch (error) {
			logInternalError("team-tool.handleCancel.crewAgents", error, `runId=${fresh.manifest.runId}`);
		}
		try {
			writeForegroundInterruptRequest(fresh.manifest, cancelMessage);
		} catch (error) {
			logInternalError("team-tool.handleCancel.interruptRequest", error, `runId=${fresh.manifest.runId}`);
		}
		ctx.abortForegroundRun?.(fresh.manifest.runId);
		for (const taskId of abortResult.abortedIds) {
			appendEvent(fresh.manifest.eventsPath, {
				type: "task.cancelled",
				runId: fresh.manifest.runId,
				taskId,
				message: cancelMessage,
				data: cancelData,
			});
		}
		const updated = updateRunStatus(
			fresh.manifest,
			"cancelled",
			`${cancelMessage} Already-finished worker processes are not retroactively changed.`,
			{ data: cancelData },
		);

		// Build descriptive message including foreign/missing info
		const parts = [`Cancelled run ${updated.runId}.`];
		if (abortResult.foreignIds.length > 0)
			parts.push(
				` ${abortResult.foreignIds.length} task(s) belong to another session and were not cancelled: ${abortResult.foreignIds.join(", ")}.`,
			);
		if (abortResult.missingIds.length > 0)
			parts.push(` ${abortResult.missingIds.length} task ID(s) not found: ${abortResult.missingIds.join(", ")}.`);

		if (deps) invalidateSnapshot(updated.runId, runCwd, deps);
		return result(parts.join(""), {
			action: "cancel",
			status: "ok",
			runId: updated.runId,
			artifactsRoot: updated.artifactsRoot,
			abortedIds: abortResult.abortedIds,
			missingIds: abortResult.missingIds,
			foreignIds: abortResult.foreignIds,
			intent: cancelIntent,
		});
	});
}
