import { readCrewAgents, recordFromTask, saveCrewAgents } from "../../runtime/crew-agent-records.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { withRunLockSync } from "../../state/coordination/locks.ts";
import { appendMailboxMessage, updateMailboxMessageReply } from "../../state/coordination/mailbox.ts";
import { appendEvent } from "../../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../../state/stores/state-store.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { locateRunCwd } from "../team-tool.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { result, type TeamContext } from "./context.ts";
import { paramRequired } from "./param-error.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

/**
 * Handle `respond` action: send a message to a waiting (interactive) task.
 * The task must be in "waiting" status. The message is stored in the task's
 * mailbox and the task is re-queued for durable scheduler resume.
 */
export function handleRespond(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId)
		return result(
			paramRequired("respond", "runId", "{ action: 'respond', runId: 'team_...', message: '...' }"),
			{ action: "respond", status: "error" },
			true,
		);
	if (!params.message && !params.taskId)
		return result(
			paramRequired(
				"respond",
				"taskId and/or message",
				"{ action: 'respond', runId: 'team_...', taskId: '01_agent', message: '...' }",
			),
			{ action: "respond", status: "error" },
			true,
		);

	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true);

	return withRunLockSync(loaded.manifest, () => {
		const fresh = loadRunManifestById(loaded.manifest.cwd, params.runId!); // NOTE: inside withRunLockSync - consistent read
		if (!fresh) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "respond", status: "error" }, true);
		const foreignRun = typeof fresh.manifest.ownerSessionId === "string" && fresh.manifest.ownerSessionId !== ctx.sessionId;
		if (foreignRun && !params.force)
			return result(
				`Run ${fresh.manifest.runId} belongs to another session. Use force: true to override.`,
				{
					action: "respond",
					status: "error",
					runId: fresh.manifest.runId,
				},
				true,
			);

		const taskId = params.taskId;
		const message = params.message ?? "";

		const targetTasks = taskId
			? fresh.tasks.filter((t) => t.id === taskId && t.status === "waiting")
			: fresh.tasks.filter((t) => t.status === "waiting");

		if (targetTasks.length === 0) {
			const existing = taskId ? fresh.tasks.find((t) => t.id === taskId) : undefined;
			const hint =
				" Use api operation=follow-up-agent for continuation prompts or api operation=steer-agent to interrupt active work.";
			return result(
				(taskId
					? existing
						? `Task '${taskId}' is ${existing.status}, not waiting.`
						: `Task '${taskId}' not found.`
					: `No waiting tasks in run ${fresh.manifest.runId}.`) + hint,
				{
					action: "respond",
					status: "error",
					runId: fresh.manifest.runId,
				},
				true,
			);
		}

		const resumed = new Set(targetTasks.map((t) => t.id));
		const mailboxIds: string[] = [];
		for (const task of targetTasks) {
			const mailbox = appendMailboxMessage(fresh.manifest, {
				direction: "inbox",
				from: "leader",
				to: task.id,
				taskId: task.id,
				body: message || "(resume)",
				kind: "response",
				priority: "normal",
				deliveryMode: "next_turn",
				data: { action: "respond", kind: "response" },
				replyTo: params.replyTo,
				replyFrom: params.replyFrom,
				replyDeadline: params.replyDeadline,
			});
			mailboxIds.push(mailbox.id);
		}

		// If this respond includes a replyTo, update the original message with reply metadata.
		if (params.replyTo) {
			updateMailboxMessageReply(fresh.manifest, params.replyTo, message || "(resume)");
		}

		// Re-queue waiting tasks so durable scheduler/resume can pick them up again.
		const updatedTasks = fresh.tasks.map((task) => {
			if (!resumed.has(task.id)) return task;
			return {
				...task,
				status: "queued" as const,
				startedAt: undefined,
				finishedAt: undefined,
				error: undefined,
				adaptive: {
					...task.adaptive,
					phase: "resumed",
					task: message || task.adaptive?.task || "",
				},
			};
		});

		saveRunTasks(fresh.manifest, updatedTasks);
		let manifest = fresh.manifest;
		if (
			manifest.status === "blocked" ||
			manifest.status === "completed" ||
			manifest.status === "failed" ||
			manifest.status === "cancelled"
		) {
			manifest = updateRunStatus(manifest, "running", `Resumed ${resumed.size} waiting task(s).`);
		}
		for (const taskId of resumed) {
			appendEvent(manifest.eventsPath, {
				type: "task.resumed",
				runId: manifest.runId,
				taskId,
				message: message || "Task re-queued after respond.",
				data: { mailboxIds },
			});
		}
		try {
			const existingRuntimes = new Map(readCrewAgents(fresh.manifest).map((a) => [a.taskId, a.runtime]));
			saveCrewAgents(
				fresh.manifest,
				updatedTasks.map((task) => recordFromTask(fresh.manifest, task, existingRuntimes.get(task.id) ?? "child-process")),
			);
		} catch (error) {
			logInternalError("team-tool.handleRespond.crewAgents", error, `runId=${fresh.manifest.runId}`);
		}

		const resumedIds = targetTasks.map((t) => t.id);
		return result(`Resumed ${resumedIds.length} waiting task(s): ${resumedIds.join(", ")}. Message: ${message || "(no message)"}`, {
			action: "respond",
			status: "ok",
			runId: fresh.manifest.runId,
			resumedIds,
			mailboxIds,
			intent: `responding to ${resumedIds.join(", ")} in ${fresh.manifest.runId}`,
		});
	});
}
