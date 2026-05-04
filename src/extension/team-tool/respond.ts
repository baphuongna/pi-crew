import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLockSync } from "../../state/locks.ts";
import { loadRunManifestById, saveRunTasks } from "../../state/state-store.ts";
import { appendMailboxMessage } from "../../state/mailbox.ts";
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

		const targetTasks = taskId
			? loaded.tasks.filter((t) => t.id === taskId && t.status === "waiting")
			: loaded.tasks.filter((t) => t.status === "waiting");

		if (targetTasks.length === 0) {
			const existing = taskId ? loaded.tasks.find((t) => t.id === taskId) : undefined;
			return result(
				taskId
					? existing
						? `Task '${taskId}' is ${existing.status}, not waiting.`
						: `Task '${taskId}' not found.`
					: `No waiting tasks in run ${loaded.manifest.runId}.`,
				{ action: "respond", status: "error", runId: loaded.manifest.runId },
				true,
			);
		}

		const resumed = new Set(targetTasks.map((t) => t.id));
		const mailboxIds: string[] = [];
		for (const task of targetTasks) {
			const mailbox = appendMailboxMessage(loaded.manifest, {
				direction: "inbox",
				from: "leader",
				to: task.id,
				taskId: task.id,
				body: message || "(resume)",
				data: { action: "respond" },
			});
			mailboxIds.push(mailbox.id);
		}

		// Transition waiting tasks back to running
		const updatedTasks = loaded.tasks.map((task) => {
			if (!resumed.has(task.id)) return task;
			return {
				...task,
				status: "running" as const,
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
			`Resumed ${resumedIds.length} waiting task(s): ${resumedIds.join(", ")}. Message: ${message || "(no message)"}`,
			{ action: "respond", status: "ok", runId: loaded.manifest.runId, resumedIds, mailboxIds } as never,
		);
	});
}