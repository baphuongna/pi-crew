/**
 * Extracted `api` operation handlers — live-agent control group (H3 phase 2).
 *
 * Extracted from `src/extension/team-tool/api.ts` on 2026-08-10. Behaviour is
 * byte-identical to the inline `if` blocks they replace.
 */

import { getCrewEnv } from "../../../config/env-vars.ts";
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
import { currentCrewRole, permissionForRole } from "../../../runtime/role-permission.ts";
import {
	appendFollowUpMessage,
	appendFollowUpMessageAsync,
	appendSteeringMessage,
	appendSteeringMessageAsync,
} from "../../../state/coordination/mailbox.ts";
import { appendEvent, appendEventBuffered } from "../../../state/event-log/event-log.ts";
import { logInternalError } from "../../../utils/internal-error.ts";
import type { ApiOperationHandler } from "./handler-context.ts";

// ── W1b deferred residual (w9-r1): role gate on the live-agent control cluster ──
// Every operation dispatched to handleLiveAgentControl (steer-agent,
// follow-up-agent, stop-agent, resume-agent, interrupt-agent) mutates run
// state — mailbox writes, live-control request files, session stop/resume —
// so the whole shared handler is gated with the canMutateTaskClaims pattern
// (task-claims.ts): read_only-tier roles (explorer/analyst/reviewer/critic/
// planner/security-reviewer + default-deny unknowns) are denied; write-tier
// workers and role-less root-session callers stay allowed. handleListLiveAgents
// is a pure read and stays open. NOTE: the separately named `foreground-interrupt`
// operation lives in read.ts (outside this file's ownership) — see the w9-r1
// fix record for the ownership-handoff note.

/** Role-tier gate for live-agent control mutations (canApprovePlan pattern). */
function canControlLiveAgents(): { allowed: boolean; reason?: string } {
	const role = currentCrewRole();
	if (!role) return { allowed: true };
	if (permissionForRole(role) === "read_only")
		return {
			allowed: false,
			reason: `Role '${role}' is read-only and cannot steer, stop, resume, or interrupt agents.`,
		};
	return { allowed: true };
}

/** Caller identity fields for the audit trail (w1b callerAuditFields pattern). */
function callerAuditFields(): { callerRole?: string; callerTaskId?: string } {
	const callerRole = currentCrewRole();
	const callerTaskId = getCrewEnv("PI_CREW_TASK_ID")?.trim() || undefined;
	return {
		...(callerRole ? { callerRole } : {}),
		...(callerTaskId ? { callerTaskId } : {}),
	};
}

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
	// Read-your-writes (CI 2026-09-11, phase8 integration): the nudge caller
	// reads events.jsonl synchronously right after dispatch — sync appendEvent.
	try {
		appendEvent(loaded.manifest.eventsPath, {
			type: "agent.nudged",
			runId: loaded.manifest.runId,
			taskId: agent.taskId,
			message: messageText,
			data: { agentId: agent.id, mailboxMessageId: message.id },
		});
	} catch (e) {
		logInternalError("api.agent-control.append", e, "type=agent.nudged");
	}
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
	const gate = canControlLiveAgents();
	if (!gate.allowed)
		return result(
			gate.reason ?? "agent control is not allowed in this context.",
			{
				action: "api",
				status: "error",
				runId: loaded.manifest.runId,
			},
			true,
		);
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
			appendEventBuffered(loaded.manifest.eventsPath, {
				type: "agent.control.queued",
				runId: loaded.manifest.runId,
				taskId: agent.taskId,
				message: `Queued ${request.operation} control request for live agent.`,
				data: {
					request,
					mailboxMessageId: mailboxMessage?.id,
					realtime: true,
					// W1b residual: record the verified caller identity on the audit trail.
					...callerAuditFields(),
				},
			}).catch((e) => logInternalError("api.agent-control.buffered", e, "type=agent.control.queued"));
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
