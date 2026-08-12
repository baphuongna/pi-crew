/**
 * Extracted `api` operation handlers — heartbeat group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

import { touchWorkerHeartbeat } from "../../../runtime/heartbeat/worker-heartbeat.ts";
import { withRunLockSync } from "../../../state/coordination/locks.ts";
import { appendEventAsync } from "../../../state/event-log/event-log.ts";
import { saveRunTasks } from "../../../state/stores/state-store.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
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
			const heartbeat = touchWorkerHeartbeat(
				task.heartbeat ?? {
					workerId: task.id,
					lastSeenAt: new Date().toISOString(),
				},
				{
					alive: typeof cfg.alive === "boolean" ? cfg.alive : undefined,
				},
			);
			const tasks = loaded.tasks.map((item) => (item.id === task.id ? { ...item, heartbeat } : item));
			saveRunTasks(loaded.manifest, tasks);
			void appendEventAsync(loaded.manifest.eventsPath, {
				type: "worker.heartbeat",
				runId: loaded.manifest.runId,
				taskId: task.id,
				data: { ...heartbeat },
			}).catch((error) =>
				logInternalError(
					"api.worker-heartbeat-event",
					error instanceof Error ? error : new Error(String(error)),
					`runId=${loaded.manifest.runId}`,
				),
			);
			return result(JSON.stringify(heartbeat, null, 2), {
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

/** Dispatcher map for the heartbeat group. Consumed by handleApi. */
export const HEARTBEAT_OPERATIONS: Record<string, ApiOperationHandler> = {
	"write-heartbeat": handleWriteHeartbeat,
};
