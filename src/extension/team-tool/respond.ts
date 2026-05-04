import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLockSync } from "../../state/locks.ts";
import { loadRunManifestById, saveRunTasks } from "../../state/state-store.ts";
import { saveCrewAgents, recordFromTask } from "../../runtime/crew-agent-records.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";

/**
 * Handle `respond` action: send a message to a waiting (interactive) task.
 * The task must be in "waiting" status. The message is stored in the task's
 * mailbox and the task is transitioned back to "running".
 */
export function handleRespond(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Respond requires runId.", { action: "respond", status: "error" }, true);
	if (!params.message && !params.taskId) return result("Respond requires taskId and/or message.", { action: "respond", status: "error" }, true);

	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "respond", status: "error" }, true);

	return withRunLockSync(loaded.manifest, () => {
		const taskId = params.taskId;
		const message = params.message ?? "";

		// Find the waiting task(s)
		const targetTasks = taskId
			? loaded.tasks.filter((t) => t.id === taskId)
			: loaded.tasks.filter((t) => t.status === "waiting");

		if (targetTasks.length === 0) {
			return result(
				taskId ? `Task '${taskId}' not found or not in waiting state.` : `No waiting tasks in run ${loaded.manifest.runId}.`,
				{ action: "respond", status: "error" },
				true,
			);
		}

		// Transition waiting tasks back to running
		const updatedTasks = loaded.tasks.map((task) => {
			if (task.status !== "waiting") return task;
			if (taskId && task.id !== taskId) return task;
			return {
				...task,
				status: "running" as const,
				// Store the response in the task's adaptive field
				adaptive: {
					...task.adaptive,
					phase: "resumed",
					task: message || task.adaptive?.task || "",
				},
			};
		});

		saveRunTasks(loaded.manifest, updatedTasks);
		try {
			saveCrewAgents(loaded.manifest, updatedTasks.map((task) => recordFromTask(loaded.manifest, task, "child-process")));
		} catch (error) {
			logInternalError("team-tool.handleRespond.crewAgents", error, `runId=${loaded.manifest.runId}`);
		}

		const resumedIds = targetTasks.map((t) => t.id);
		return result(
			`Resumed ${resumedIds.length} task(s): ${resumedIds.join(", ")}. Message: ${message || "(no message)"}`,
			{ action: "respond", status: "ok", runId: loaded.manifest.runId, resumedIds },
		);
	});
}