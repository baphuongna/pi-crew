/**
 * Extracted `api` operation handlers for task-claim lifecycle (H3 phase 1).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10 to prove the
 * per-group extraction pattern described in improvement-plan-2026-08-10 H3.
 * The three operations here (claim-task, release-task-claim,
 * transition-task-status) are a cohesive group: all mutate task state under
 * the run lock and emit a corresponding event. Each is a thin wrapper around
 * the shared `task-claims.ts` coordination primitives.
 *
 * Behaviour is byte-identical to the inline `if` blocks they replace — the
 * extraction is mechanical (move + re-indent + pass ctx). The existing
 * `test/unit/extension/core/api-claim.test.ts` suite guards against drift.
 */

import { canTransitionTaskStatus, isTeamTaskStatus } from "../../../state/contracts.ts";
import { withRunLockSync } from "../../../state/coordination/locks.ts";
import { claimTask, releaseTaskClaim, transitionClaimedTaskStatus } from "../../../state/coordination/task-claims.ts";
import { appendEvent } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks } from "../../../state/stores/state-store.ts";
import type { TeamTaskState } from "../../../state/types.ts";
import { RUN_NOT_FOUND_HINT } from "../run-not-found.ts";
import type { ApiHandlerContext, ApiOperationHandler } from "./handler-context.ts";

/** Find a task by id OR stepId — the convention used by every claim op. */
function findTaskByIdOrStepId(tasks: TeamTaskState[], taskId: string | undefined) {
	if (!taskId) return undefined;
	return tasks.find((item) => item.id === taskId || item.stepId === taskId);
}

/**
 * R13-S1: fresh re-read INSIDE the lock (respond.ts:43 canonical pattern).
 * `loaded.manifest` passed to withRunLockSync is used ONLY for lock-path
 * derivation (locks.ts:596-598 — the lock does NOT re-read); the DATA
 * (tasks, status) must always come from this fresh read.
 */
function freshRunOrMissing(
	loaded: ApiHandlerContext["loaded"],
	result: ApiHandlerContext["result"],
): { manifest: import("../../../state/types.ts").TeamRunManifest; tasks: TeamTaskState[] } | ReturnType<ApiHandlerContext["result"]> {
	const fresh = loadRunManifestById(loaded.manifest.cwd, loaded.manifest.runId);
	if (!fresh)
		return result(
			`Run '${loaded.manifest.runId}' not found.${RUN_NOT_FOUND_HINT}`,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	return fresh;
}

/** handleApi operation: `claim-task`. */
export const handleClaimTask: ApiOperationHandler = (ctx) => {
	const { cfg, loaded, result, paramRequired } = ctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const owner = typeof cfg.owner === "string" ? cfg.owner : "api";
	const task = findTaskByIdOrStepId(loaded.tasks, taskId);
	if (!task)
		return result(
			paramRequired(
				"API claim-task",
				"config.taskId matching a task id or step id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'claim-task', taskId: '01_01-agent' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return withRunLockSync(loaded.manifest, () => {
			const fresh = freshRunOrMissing(loaded, result);
			if (!("tasks" in fresh)) return fresh;
			const freshTask = findTaskByIdOrStepId(fresh.tasks, taskId);
			if (!freshTask)
				return result(
					`Task '${taskId}' not found in run '${fresh.manifest.runId}'.`,
					{
						action: "api",
						status: "error",
						runId: fresh.manifest.runId,
					},
					true,
				);
			// R13-S1: claim operates on the FRESH task — a task that became terminal on
			// disk keeps its terminal status (no resurrection via the stale array).
			const updatedTask = claimTask(freshTask, owner);
			const tasks = fresh.tasks.map((item) => (item.id === freshTask.id ? updatedTask : item));
			saveRunTasks(fresh.manifest, tasks);
			appendEvent(fresh.manifest.eventsPath, {
				type: "task.claimed",
				runId: fresh.manifest.runId,
				taskId: freshTask.id,
				data: {
					owner,
					token: "[REDACTED]",
					leasedUntil: updatedTask.claim?.leasedUntil,
				},
			});
			return result(JSON.stringify(updatedTask.claim, null, 2), {
				action: "api",
				status: "ok",
				runId: fresh.manifest.runId,
				artifactsRoot: fresh.manifest.artifactsRoot,
			});
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(
			message,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	}
};

/** handleApi operation: `release-task-claim`. */
export const handleReleaseTaskClaim: ApiOperationHandler = (ctx) => {
	const { cfg, loaded, result, paramRequired } = ctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const owner = typeof cfg.owner === "string" ? cfg.owner : undefined;
	const token = typeof cfg.token === "string" ? cfg.token : undefined;
	const task = findTaskByIdOrStepId(loaded.tasks, taskId);
	if (!task || !owner || !token)
		return result(
			paramRequired(
				"API release-task-claim",
				"config.taskId, config.owner, and config.token",
				"{ action: 'api', runId: 'team_...', config: { operation: 'release-task-claim', taskId: '01_01-agent', owner: 'worker-1', token: 'tok-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return withRunLockSync(loaded.manifest, () => {
			const fresh = freshRunOrMissing(loaded, result);
			if (!("tasks" in fresh)) return fresh;
			const freshTask = findTaskByIdOrStepId(fresh.tasks, taskId);
			if (!freshTask)
				return result(
					`Task '${taskId}' not found in run '${fresh.manifest.runId}'.`,
					{
						action: "api",
						status: "error",
						runId: fresh.manifest.runId,
					},
					true,
				);
			const updatedTask = releaseTaskClaim(freshTask, owner, token);
			const tasks = fresh.tasks.map((item) => (item.id === freshTask.id ? updatedTask : item));
			saveRunTasks(fresh.manifest, tasks);
			appendEvent(fresh.manifest.eventsPath, {
				type: "task.claim_released",
				runId: fresh.manifest.runId,
				taskId: freshTask.id,
				data: { owner },
			});
			return result(JSON.stringify(updatedTask, null, 2), {
				action: "api",
				status: "ok",
				runId: fresh.manifest.runId,
				artifactsRoot: fresh.manifest.artifactsRoot,
			});
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(
			message,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	}
};

/** handleApi operation: `transition-task-status`. */
export const handleTransitionTaskStatus: ApiOperationHandler = (ctx) => {
	const { cfg, loaded, result, paramRequired } = ctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const owner = typeof cfg.owner === "string" ? cfg.owner : undefined;
	const token = typeof cfg.token === "string" ? cfg.token : undefined;
	const to = cfg.status;
	const task = findTaskByIdOrStepId(loaded.tasks, taskId);
	if (!task || !owner || !token || !isTeamTaskStatus(to))
		return result(
			paramRequired(
				"API transition-task-status",
				"config.taskId, config.owner, config.token, and valid config.status",
				"{ action: 'api', runId: 'team_...', config: { operation: 'transition-task-status', taskId: '01_01-agent', owner: 'worker-1', token: 'tok-1', status: 'done' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return withRunLockSync(loaded.manifest, () => {
			const fresh = freshRunOrMissing(loaded, result);
			if (!("tasks" in fresh)) return fresh;
			const freshTask = findTaskByIdOrStepId(fresh.tasks, taskId);
			if (!freshTask)
				return result(
					`Task '${taskId}' not found in run '${fresh.manifest.runId}'.`,
					{
						action: "api",
						status: "error",
						runId: fresh.manifest.runId,
					},
					true,
				);
			// R13-S1: validate the transition against FRESH task status — a task that
			// became terminal on disk must be rejected (no terminal flip / no resurrection).
			if (!canTransitionTaskStatus(freshTask.status, to))
				return result(
					`Invalid task status transition: ${freshTask.status} -> ${to}`,
					{
						action: "api",
						status: "error",
						runId: fresh.manifest.runId,
					},
					true,
				);
			const updatedTask = transitionClaimedTaskStatus(freshTask, owner, token, to);
			const tasks = fresh.tasks.map((item) => (item.id === freshTask.id ? updatedTask : item));
			saveRunTasks(fresh.manifest, tasks);
			appendEvent(fresh.manifest.eventsPath, {
				type: "task.status_transitioned",
				runId: fresh.manifest.runId,
				taskId: freshTask.id,
				data: { owner, status: to },
			});
			return result(JSON.stringify(updatedTask, null, 2), {
				action: "api",
				status: "ok",
				runId: fresh.manifest.runId,
				artifactsRoot: fresh.manifest.artifactsRoot,
			});
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(
			message,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	}
};

/** Dispatcher map for the task-claim group. Consumed by handleApi. */
export const TASK_CLAIM_OPERATIONS: Record<string, ApiOperationHandler> = {
	"claim-task": handleClaimTask,
	"release-task-claim": handleReleaseTaskClaim,
	"transition-task-status": handleTransitionTaskStatus,
};
