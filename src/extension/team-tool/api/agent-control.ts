/**
 * Extracted `api` operation handlers — live-agent control group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

import { readCrewAgents } from "../../../runtime/crew-agent-records.ts";
import { appendLiveAgentControlRequest } from "../../../runtime/live-session/live-agent-control.ts";
import {
	followUpLiveAgent,
	getLiveAgent,
	listActiveLiveAgents,
	resumeLiveAgent,
	steerLiveAgent,
	stopLiveAgent,
} from "../../../runtime/live-session/live-agent-manager.ts";
import { liveControlRealtimeMessage, publishLiveControlRealtime } from "../../../runtime/live-session/live-control-realtime.ts";
import {
	appendFollowUpMessage,
	appendFollowUpMessageAsync,
	appendSteeringMessage,
	appendSteeringMessageAsync,
} from "../../../state/coordination/mailbox.ts";
import { appendEvent } from "../../../state/event-log/event-log.ts";
import type { ApiOperationHandler } from "./handler-context.ts";

export const handleNudgeAgent: ApiOperationHandler = (hctx) => {
	const { cfg, loaded, result, paramRequired, ctx } = hctx;
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
	if (!agent)
		return result(
			paramRequired(
				"API nudge-agent",
				"config.agentId matching an agent id or task id",
				"{ action: 'api', runId: 'team_...', config: { operation: 'nudge-agent', agentId: 'agent-1' } }",
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const messageText =
		typeof cfg.message === "string" && cfg.message.trim()
			? cfg.message.trim()
			: "Please report your current status, blocker, or smallest next step.";
	const message = appendSteeringMessage(loaded.manifest, {
		taskId: agent.taskId,
		to: agent.taskId,
		body: messageText,
		priority: "normal",
		data: { source: "nudge-agent" },
	});
	appendEvent(loaded.manifest.eventsPath, {
		type: "agent.nudged",
		runId: loaded.manifest.runId,
		taskId: agent.taskId,
		message: messageText,
		data: { agentId: agent.id, mailboxMessageId: message.id },
	});
	ctx.events?.emit?.("crew.mailbox.message", {
		runId: loaded.manifest.runId,
		id: message.id,
		direction: message.direction,
		from: message.from,
		to: message.to,
		taskId: message.taskId,
		source: "nudge-agent",
	});
	return result(JSON.stringify({ agentId: agent.id, mailboxMessage: message }, null, 2), {
		action: "api",
		status: "ok",
		runId: loaded.manifest.runId,
		artifactsRoot: loaded.manifest.artifactsRoot,
	});
};

export const handleListLiveAgents: ApiOperationHandler = (hctx) => {
	const { loaded, result } = hctx;
	return result(
		JSON.stringify(
			listActiveLiveAgents().filter((agent) => agent.runId === loaded.manifest.runId),
			null,
			2,
		),
		{
			action: "api",
			status: "ok",
			runId: loaded.manifest.runId,
			artifactsRoot: loaded.manifest.artifactsRoot,
		},
	);
};

/**
 * Handles steer-agent / follow-up-agent / stop-agent / resume-agent /
 * interrupt-agent — the live-agent control cluster (shared body in the
 * original handleApi; interrupt falls through to stop).
 */
export const handleLiveAgentControl: ApiOperationHandler = async (hctx) => {
	const { cfg, loaded, result, paramRequired, ctx } = hctx;
	const operation = typeof cfg.operation === "string" ? cfg.operation : "";
	const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
	if (!agentId)
		return result(
			paramRequired(
				`API ${operation}`,
				"config.agentId",
				`{ action: 'api', runId: 'team_...', config: { operation: '${operation}', agentId: 'agent-1' } }`,
			),
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
	const message = typeof cfg.message === "string" && cfg.message.trim() ? cfg.message.trim() : undefined;
	const prompt = typeof cfg.prompt === "string" && cfg.prompt.trim() ? cfg.prompt.trim() : message;
	try {
		const live = getLiveAgent(agentId);
		if (live && live.runId !== loaded.manifest.runId)
			return result(
				`Live agent '${agentId}' does not belong to run ${loaded.manifest.runId}.`,
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		if (live && live.workspaceId !== loaded.manifest.cwd)
			return result(
				`Live agent '${agentId}' does not belong to workspace ${loaded.manifest.cwd}.`,
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		if (!live && (operation === "steer-agent" || operation === "follow-up-agent"))
			throw new Error(`Live agent '${agentId}' not found.`);
		const liveTaskId = live?.taskId;
		if ((operation === "steer-agent" || operation === "follow-up-agent") && !liveTaskId)
			throw new Error(`Live agent '${agentId}' not found.`);
		const targetTaskId = liveTaskId ?? agentId;
		if (operation === "steer-agent") {
			const text = message ?? "Please report current status and wrap up if possible.";
			const realtime = await steerLiveAgent(agentId, text);
			const mailboxMessage = await appendSteeringMessageAsync(loaded.manifest, {
				taskId: targetTaskId,
				body: text,
				status: "delivered",
				data: { source: "steer-agent", realtime: true },
			});
			return result(JSON.stringify({ realtime, mailboxMessage }, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
			});
		}
		if (operation === "follow-up-agent") {
			if (!prompt)
				return result(
					paramRequired(
						"API follow-up-agent",
						"config.prompt or config.message",
						"{ action: 'api', runId: 'team_...', config: { operation: 'follow-up-agent', agentId: 'agent-1', prompt: '<next step>' } }",
					),
					{
						action: "api",
						status: "error",
						runId: loaded.manifest.runId,
					},
					true,
				);
			const realtime = await followUpLiveAgent(agentId, prompt);
			const mailboxMessage = await appendFollowUpMessageAsync(loaded.manifest, {
				taskId: targetTaskId,
				body: prompt,
				status: "delivered",
				data: { source: "follow-up-agent", realtime: true },
			});
			return result(JSON.stringify({ realtime, mailboxMessage }, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
			});
		}
		if (operation === "resume-agent") {
			if (!prompt)
				return result(
					paramRequired(
						"API resume-agent",
						"config.prompt or config.message",
						"{ action: 'api', runId: 'team_...', config: { operation: 'resume-agent', agentId: 'agent-1', prompt: '<resume instruction>' } }",
					),
					{
						action: "api",
						status: "error",
						runId: loaded.manifest.runId,
					},
					true,
				);
			return result(JSON.stringify(await resumeLiveAgent(agentId, prompt), null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
			});
		}
		return result(JSON.stringify(await stopLiveAgent(agentId), null, 2), {
			action: "api",
			status: "ok",
			runId: loaded.manifest.runId,
			artifactsRoot: loaded.manifest.artifactsRoot,
		});
	} catch (error) {
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) {
			const err = error instanceof Error ? error.message : String(error);
			return result(
				err,
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		}
		const task = loaded.tasks.find((item) => item.id === agent.taskId);
		if (!task)
			return result(
				`API ${operation} agent '${agentId}' does not match a run task.`,
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		if (operation === "resume-agent" && !prompt)
			return result(
				paramRequired(
					"API resume-agent",
					"config.prompt or config.message",
					"{ action: 'api', runId: 'team_...', config: { operation: 'resume-agent', agentId: 'agent-1', prompt: '<resume instruction>' } }",
				),
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		if (operation === "follow-up-agent" && !prompt)
			return result(
				paramRequired(
					"API follow-up-agent",
					"config.prompt or config.message",
					"{ action: 'api', runId: 'team_...', config: { operation: 'follow-up-agent', agentId: 'agent-1', prompt: '<next step>' } }",
				),
				{
					action: "api",
					status: "error",
					runId: loaded.manifest.runId,
				},
				true,
			);
		try {
			const request = appendLiveAgentControlRequest(loaded.manifest, {
				taskId: task.id,
				agentId: agent.id,
				operation:
					operation === "resume-agent"
						? "resume"
						: operation === "follow-up-agent"
							? "follow-up"
							: operation === "steer-agent"
								? "steer"
								: "stop",
				message: operation === "resume-agent" || operation === "follow-up-agent" ? prompt : message,
			});
			const mailboxMessage =
				operation === "steer-agent"
					? appendSteeringMessage(loaded.manifest, {
							taskId: task.id,
							to: agent.id,
							body: message ?? "Please report current status and wrap up if possible.",
							status: "delivered",
							data: {
								source: "steer-agent",
								liveControlRequestId: request.id,
							},
						})
					: operation === "follow-up-agent" && prompt
						? appendFollowUpMessage(loaded.manifest, {
								taskId: task.id,
								to: agent.id,
								body: prompt,
								status: "delivered",
								data: {
									source: "follow-up-agent",
									liveControlRequestId: request.id,
								},
							})
						: undefined;
			publishLiveControlRealtime(request);
			ctx.events?.emit?.("pi-crew:live-control", liveControlRealtimeMessage(request));
			appendEvent(loaded.manifest.eventsPath, {
				type: "agent.control.queued",
				runId: loaded.manifest.runId,
				taskId: agent.taskId,
				message: `Queued ${request.operation} control request for live agent.`,
				data: {
					request,
					mailboxMessageId: mailboxMessage?.id,
					realtime: true,
				},
			});
			return result(JSON.stringify({ queued: true, request, mailboxMessage }, null, 2), {
				action: "api",
				status: "ok",
				runId: loaded.manifest.runId,
				artifactsRoot: loaded.manifest.artifactsRoot,
			});
		} catch (queueError) {
			const message = queueError instanceof Error ? queueError.message : String(queueError);
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
	}
};

/** Dispatcher map for the live-agent control group. Consumed by handleApi. */
export const AGENT_CONTROL_OPERATIONS: Record<string, ApiOperationHandler> = {
	"nudge-agent": handleNudgeAgent,
	"list-live-agents": handleListLiveAgents,
	"steer-agent": handleLiveAgentControl,
	"follow-up-agent": handleLiveAgentControl,
	"stop-agent": handleLiveAgentControl,
	"resume-agent": handleLiveAgentControl,
	"interrupt-agent": handleLiveAgentControl,
};
