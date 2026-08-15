/**
 * Extracted `api` operation handlers — heartbeat group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

import { touchWorkerHeartbeat } from "../../../runtime/heartbeat/worker-heartbeat.ts";
import { isTerminalTaskStatus } from "../../../state/contracts.ts";
import { withRunLockSync } from "../../../state/coordination/locks.ts";
import { appendEvent } from "../../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks } from "../../../state/stores/state-store.ts";
import { RUN_NOT_FOUND_HINT } from "../run-not-found.ts";
import type { ApiOperationHandler } from "./handler-context.ts";

export const handleWriteHeartbeat: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired } = hctx;
	const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
	const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
	if (!task)
		return result(
			paramRequired(
				"API write-heartbeat",
				"config.taskId matching a task id or step id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'write-heartbeat', taskId: '01_01-agent' } }",
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
			// R13-S1: fresh re-read INSIDE the lock (respond.ts:43 canonical pattern).
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
			const freshTask = fresh.tasks.find((item) => item.id === taskId || item.stepId === taskId);
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
			// R13-S1: never resurrect a task that became terminal on disk — a completed/
			// failed task must not be flipped back to running by a stale heartbeat.
			if (isTerminalTaskStatus(freshTask.status))
				return result(
					`Cannot write heartbeat for task '${freshTask.id}': task is in terminal state '${freshTask.status}'.`,
					{
						action: "api",
						status: "error",
						runId: fresh.manifest.runId,
					},
					true,
				);
			const heartbeat = touchWorkerHeartbeat(
				freshTask.heartbeat ?? {
					workerId: freshTask.id,
					lastSeenAt: new Date().toISOString(),
				},
				{
					alive: typeof cfg.alive === "boolean" ? cfg.alive : undefined,
				},
			);
			const tasks = fresh.tasks.map((item) => (item.id === freshTask.id ? { ...item, heartbeat } : item));
			saveRunTasks(fresh.manifest, tasks);
			appendEvent(fresh.manifest.eventsPath, {
				type: "worker.heartbeat",
				runId: fresh.manifest.runId,
				taskId: freshTask.id,
				data: { ...heartbeat },
			});
			return result(JSON.stringify(heartbeat, null, 2), {
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

/** Dispatcher map for the heartbeat group. Consumed by handleApi. */
export const HEARTBEAT_OPERATIONS: Record<string, ApiOperationHandler> = {
	"write-heartbeat": handleWriteHeartbeat,
};
