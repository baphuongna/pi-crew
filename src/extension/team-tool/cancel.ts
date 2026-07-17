import { appendHookEvent, executeHook } from "../../hooks/registry.ts";
import { buildSyntheticTerminalEvidence, type CancellationReason, cancellationReasonFromUnknown } from "../../runtime/cancellation.ts";
import { killProcessPid } from "../../runtime/child-pi.ts";
import { recordFromTask, saveCrewAgents } from "../../runtime/crew-agent-records.ts";
import { writeForegroundInterruptRequest } from "../../runtime/foreground-control.ts";
import { terminateLiveAgentsForRun } from "../../runtime/live-agent-manager.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { appendEvent } from "../../state/event-log.ts";
import { withRunLockSync } from "../../state/locks.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../../state/state-store.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { type CacheControlDeps, invalidateSnapshot } from "./cache-control.ts";
import { result, type TeamContext } from "./context.ts";
import { enforceDestructiveIntent, intentFromConfig } from "./intent-policy.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

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
	if (!params.runId) return result("Retry requires runId.", { action: "retry", status: "error" }, true);
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
		const retryableStatuses: ReadonlySet<string> = new Set(["failed", "cancelled"]);

		const matchingTasks = loaded.tasks.filter((task) => {
			if (targetTaskId && task.id !== targetTaskId) return false;
			return retryableStatuses.has(task.status);
		});

		if (matchingTasks.length === 0) {
			return result(
				targetTaskId ? `Task '${targetTaskId}' is not failed/cancelled; nothing to retry.` : "No failed/cancelled tasks to retry.",
				{
					action: "retry",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		}

		const retriedIds = new Set(matchingTasks.map((t) => t.id));
		const tasks = loaded.tasks.map((task) => {
			if (!retriedIds.has(task.id)) return task;
			const { error: _error, finishedAt: _finishedAt, terminalEvidence: _terminalEvidence, ...rest } = task;
			return { ...rest, status: "queued" as const };
		});
		saveRunTasks(loaded.manifest, tasks);
		try {
			saveCrewAgents(
				loaded.manifest,
				tasks.map((task) => recordFromTask(loaded.manifest, task, "child-process")),
			);
		} catch (error) {
			logInternalError("team-tool.handleRetry.crewAgents", error, `runId=${loaded.manifest.runId}`);
		}

		const retriedTaskIds = [...retriedIds];
		for (const taskId of retriedTaskIds) {
			appendEvent(loaded.manifest.eventsPath, {
				type: "task.retried",
				runId: loaded.manifest.runId,
				taskId,
				message: `Task ${taskId} queued for retry.`,
			});
		}

		if (deps) invalidateSnapshot(loaded.manifest.runId, runCwd, deps);
		return result(`Retried ${retriedTaskIds.length} task(s) in run ${loaded.manifest.runId}.`, {
			action: "retry",
			status: "ok",
			runId: loaded.manifest.runId,
			retriedTaskIds: retriedTaskIds,
			intent: `retrying ${retriedTaskIds.length} task(s) in ${loaded.manifest.runId}`,
		});
	});
}

export async function handleCancel(params: TeamToolParamsValue, ctx: TeamContext, deps?: CacheControlDeps): Promise<PiTeamsToolResult> {
	const intentError = enforceDestructiveIntent("cancel", params, ctx.config);
	if (intentError) return intentError;
	if (!params.runId) return result("Cancel requires runId.", { action: "cancel", status: "error" }, true);
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
			appendEvent(loaded.manifest.eventsPath, {
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
		if ((loaded.manifest.status === "completed" || loaded.manifest.status === "cancelled") && params.force !== true)
			return result(
				`Run ${loaded.manifest.runId} is already ${loaded.manifest.status}; nothing to cancel. Use force: true to mark it cancelled anyway.`,
				{
					action: "cancel",
					status: "ok",
					runId: loaded.manifest.runId,
					artifactsRoot: loaded.manifest.artifactsRoot,
				},
			);

		// Classify tasks for foreign-aware cancellation
		const abortResult = abortOwned(loaded.manifest.runId, undefined, ctx, params.force);
		if (abortResult.abortedIds.length === 0 && abortResult.foreignIds.length > 0 && params.force !== true) {
			return result(
				`Run ${loaded.manifest.runId} belongs to another session. Use force: true to override.`,
				{
					action: "cancel",
					status: "error",
					runId: loaded.manifest.runId,
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

		const tasks = loaded.tasks.map((task) => {
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
		saveRunTasks(loaded.manifest, tasks);
		try {
			saveCrewAgents(
				loaded.manifest,
				tasks.map((task) => recordFromTask(loaded.manifest, task, loaded.manifest.runtimeResolution?.kind ?? "child-process")),
			);
		} catch (error) {
			logInternalError("team-tool.handleCancel.crewAgents", error, `runId=${loaded.manifest.runId}`);
		}
		try {
			writeForegroundInterruptRequest(loaded.manifest, cancelMessage);
		} catch (error) {
			logInternalError("team-tool.handleCancel.interruptRequest", error, `runId=${loaded.manifest.runId}`);
		}
		ctx.abortForegroundRun?.(loaded.manifest.runId);
		for (const taskId of abortResult.abortedIds) {
			appendEvent(loaded.manifest.eventsPath, {
				type: "task.cancelled",
				runId: loaded.manifest.runId,
				taskId,
				message: cancelMessage,
				data: cancelData,
			});
		}
		const updated = updateRunStatus(
			loaded.manifest,
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
