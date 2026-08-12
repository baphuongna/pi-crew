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
import { saveRunTasks } from "../../../state/stores/state-store.ts";
import type { ApiHandlerContext, ApiOperationHandler } from "./handler-context.ts";

/** Find a task by id OR stepId — the convention used by every claim op. */
function findTaskByIdOrStepId(ctx: ApiHandlerContext, taskId: string | undefined) {
	if (!taskId) return undefined;
	return ctx.loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
}

/** handleApi operation: `claim-task`. */
export const handleClaimTask: ApiOperationHandler = (ctx) => {
	const { cfg, loaded, result, paramRequired } = ctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const owner = typeof cfg.owner === "string" ? cfg.owner : "api";
	const task = findTaskByIdOrStepId(ctx, taskId);
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
			const updatedTask = claimTask(task, owner);
			const tasks = loaded.tasks.map((item) => (item.id === task.id ? updatedTask : item));
			saveRunTasks(loaded.manifest, tasks);
			appendEvent(loaded.manifest.eventsPath, {
				type: "task.claimed",
				runId: loaded.manifest.runId,
				taskId: task.id,
				data: {
					owner,
					token: "[REDACTED]",
					leasedUntil: updatedTask.claim?.leasedUntil,
				},
			});
			return result(JSON.stringify(updatedTask.claim, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
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
	const task = findTaskByIdOrStepId(ctx, taskId);
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
			const updatedTask = releaseTaskClaim(task, owner, token);
			const tasks = loaded.tasks.map((item) => (item.id === task.id ? updatedTask : item));
			saveRunTasks(loaded.manifest, tasks);
			appendEvent(loaded.manifest.eventsPath, {
				type: "task.claim_released",
				runId: loaded.manifest.runId,
				taskId: task.id,
				data: { owner },
			});
			return result(JSON.stringify(updatedTask, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
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
	const task = findTaskByIdOrStepId(ctx, taskId);
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
	if (!canTransitionTaskStatus(task.status, to))
		return result(
			`Invalid task status transition: ${task.status} -> ${to}`,
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	try {
		return withRunLockSync(loaded.manifest, () => {
			const updatedTask = transitionClaimedTaskStatus(task, owner, token, to);
			const tasks = loaded.tasks.map((item) => (item.id === task.id ? updatedTask : item));
			saveRunTasks(loaded.manifest, tasks);
			appendEvent(loaded.manifest.eventsPath, {
				type: "task.status_transitioned",
				runId: loaded.manifest.runId,
				taskId: task.id,
				data: { owner, status: to },
			});
			return result(JSON.stringify(updatedTask, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
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
