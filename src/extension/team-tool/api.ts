import * as fs from "node:fs";
import { loadConfig } from "../../config/config.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { saveRunTasks, loadRunManifestById } from "../../state/state-store.ts";
import { withRunLockSync } from "../../state/locks.ts";
import { canTransitionTaskStatus, isTeamTaskStatus } from "../../state/contracts.ts";
import { claimTask, releaseTaskClaim, transitionClaimedTaskStatus } from "../../state/task-claims.ts";
import { acknowledgeMailboxMessage, appendMailboxMessage, readDeliveryState, readMailbox, validateMailbox, type MailboxDirection } from "../../state/mailbox.ts";
import { appendEvent, readEvents, readEventsCursor } from "../../state/event-log.ts";
import { resolveCrewRuntime } from "../../runtime/runtime-resolver.ts";
import { probeLiveSessionRuntime } from "../../subagents/live/session-runtime.ts";
import { touchWorkerHeartbeat } from "../../runtime/worker-heartbeat.ts";
import { agentEventsPath, agentOutputPath, readCrewAgentEvents, readCrewAgentEventsCursor, readCrewAgentStatus, readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { buildAgentDashboard, readAgentOutput } from "../../runtime/agent-observability.ts";
import { readForegroundControlStatus, writeForegroundInterruptRequest } from "../../runtime/foreground-control.ts";
import { listLiveAgents, resumeLiveAgent, steerLiveAgent, stopLiveAgent } from "../../subagents/live/manager.ts";
import { appendLiveAgentControlRequest } from "../../subagents/live/control.ts";
import { liveControlRealtimeMessage, publishLiveControlRealtime } from "../../subagents/live/realtime.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { configRecord, result, type TeamContext } from "./context.ts";

export async function handleApi(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	if (!params.runId) return result("API requires runId.", { action: "api", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "api", status: "error" }, true);
	const cfg = configRecord(params.config);
	const operation = typeof cfg.operation === "string" ? cfg.operation : "read-manifest";
	if (operation === "read-manifest") {
		return result(JSON.stringify(loaded.manifest, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "list-tasks") {
		return result(JSON.stringify(loaded.tasks, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-task") {
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
		if (!task) return result("API read-task requires config.taskId matching a task id or step id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		return result(JSON.stringify(task, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-events") {
		const sinceSeq = typeof cfg.sinceSeq === "number" ? cfg.sinceSeq : undefined;
		const limit = typeof cfg.limit === "number" ? cfg.limit : undefined;
		const payload = sinceSeq !== undefined || limit !== undefined
			? readEventsCursor(loaded.manifest.eventsPath, { sinceSeq, limit })
			: { events: readEvents(loaded.manifest.eventsPath), nextSeq: undefined, total: undefined };
		return result(JSON.stringify(payload, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "runtime-capabilities") {
		const loadedConfig = loadConfig(ctx.cwd);
		return result(JSON.stringify(await resolveCrewRuntime(loadedConfig.config), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "probe-live-session") {
		return result(JSON.stringify(await probeLiveSessionRuntime(), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "list-agents") {
		return result(JSON.stringify(readCrewAgents(loaded.manifest), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "get-agent-result") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) return result("API get-agent-result requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const task = loaded.tasks.find((item) => item.id === agent.taskId);
		const text = task?.resultArtifact && fs.existsSync(task.resultArtifact.path) ? fs.readFileSync(task.resultArtifact.path, "utf-8") : JSON.stringify(agent, null, 2);
		return result(text, { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-agent-status") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agent = agentId ? readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId) : undefined;
		const status = agent ? readCrewAgentStatus(loaded.manifest, agent.taskId) ?? agent : undefined;
		if (!status) return result("API read-agent-status requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		return result(JSON.stringify(status, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-agent-events") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agents = readCrewAgents(loaded.manifest);
		const agent = agentId ? agents.find((item) => item.id === agentId || item.taskId === agentId) : agents[0];
		if (!agent) return result("API read-agent-events requires config.agentId matching an agent id or task id, or at least one agent in the run.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const sinceSeq = typeof cfg.sinceSeq === "number" ? cfg.sinceSeq : undefined;
		const limit = typeof cfg.limit === "number" ? cfg.limit : undefined;
		const payload = sinceSeq !== undefined || limit !== undefined
			? readCrewAgentEventsCursor(loaded.manifest, agent.taskId, { sinceSeq, limit })
			: { path: agentEventsPath(loaded.manifest, agent.taskId), events: readCrewAgentEvents(loaded.manifest, agent.taskId) };
		return result(JSON.stringify(payload, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-agent-transcript") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agents = readCrewAgents(loaded.manifest);
		const agent = agentId ? agents.find((item) => item.id === agentId || item.taskId === agentId) : agents[0];
		if (!agent) return result("API read-agent-transcript requires config.agentId matching an agent id or task id, or at least one agent in the run.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const transcriptPath = agent.transcriptPath && fs.existsSync(agent.transcriptPath) ? agent.transcriptPath : agentOutputPath(loaded.manifest, agent.taskId);
		const text = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf-8") : "";
		return result(text || `(no transcript at ${transcriptPath})`, { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-agent-output") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agents = readCrewAgents(loaded.manifest);
		const agent = agentId ? agents.find((item) => item.id === agentId || item.taskId === agentId) : agents[0];
		if (!agent) return result("API read-agent-output requires config.agentId matching an agent id or task id, or at least one agent in the run.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const maxBytes = typeof cfg.maxBytes === "number" ? cfg.maxBytes : undefined;
		return result(JSON.stringify(readAgentOutput(loaded.manifest, agent.taskId, maxBytes), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "agent-dashboard") {
		return result(buildAgentDashboard(loaded.manifest).text, { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "foreground-status") {
		return result(JSON.stringify(readForegroundControlStatus(loaded.manifest, loaded.tasks), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "foreground-interrupt") {
		const reason = typeof cfg.reason === "string" && cfg.reason.trim() ? cfg.reason.trim() : undefined;
		return result(JSON.stringify(writeForegroundInterruptRequest(loaded.manifest, reason), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "nudge-agent") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) return result("API nudge-agent requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const messageText = typeof cfg.message === "string" && cfg.message.trim() ? cfg.message.trim() : "Please report your current status, blocker, or smallest next step.";
		const message = appendMailboxMessage(loaded.manifest, { direction: "inbox", from: "leader", to: agent.taskId, taskId: agent.taskId, body: messageText });
		appendEvent(loaded.manifest.eventsPath, { type: "agent.nudged", runId: loaded.manifest.runId, taskId: agent.taskId, message: messageText, data: { agentId: agent.id, mailboxMessageId: message.id } });
		ctx.events?.emit?.("crew.mailbox.message", { runId: loaded.manifest.runId, id: message.id, direction: message.direction, from: message.from, to: message.to, taskId: message.taskId, source: "nudge-agent" });
		return result(JSON.stringify({ agentId: agent.id, mailboxMessage: message }, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "list-live-agents") {
		return result(JSON.stringify(listLiveAgents().filter((agent) => agent.runId === loaded.manifest.runId), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "steer-agent" || operation === "stop-agent" || operation === "resume-agent" || operation === "interrupt-agent") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		if (!agentId) return result(`API ${operation} requires config.agentId.`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const message = typeof cfg.message === "string" && cfg.message.trim() ? cfg.message.trim() : undefined;
		const prompt = typeof cfg.prompt === "string" && cfg.prompt.trim() ? cfg.prompt.trim() : message;
		try {
			if (operation === "steer-agent") return result(JSON.stringify(await steerLiveAgent(agentId, message ?? "Please report current status and wrap up if possible."), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			if (operation === "resume-agent") {
				if (!prompt) return result("API resume-agent requires config.prompt or config.message.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
				return result(JSON.stringify(await resumeLiveAgent(agentId, prompt), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			}
			return result(JSON.stringify(await stopLiveAgent(agentId), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
		} catch (error) {
			const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
			if (!agent) {
				const err = error instanceof Error ? error.message : String(error);
				return result(err, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
			}
			if (operation === "resume-agent" && !prompt) return result("API resume-agent requires config.prompt or config.message.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
			const request = appendLiveAgentControlRequest(loaded.manifest, { taskId: agent.taskId, agentId: agent.id, operation: operation === "resume-agent" ? "resume" : operation === "steer-agent" ? "steer" : "stop", message: operation === "resume-agent" ? prompt : message });
			publishLiveControlRealtime(request);
			ctx.events?.emit?.("pi-crew:live-control", liveControlRealtimeMessage(request));
			appendEvent(loaded.manifest.eventsPath, { type: "agent.control.queued", runId: loaded.manifest.runId, taskId: agent.taskId, message: `Queued ${request.operation} control request for live agent.`, data: { request, realtime: true } });
			return result(JSON.stringify({ queued: true, request }, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
		}
	}
	if (operation === "read-mailbox") {
		const direction = cfg.direction === "inbox" || cfg.direction === "outbox" ? cfg.direction as MailboxDirection : undefined;
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		return result(JSON.stringify(readMailbox(loaded.manifest, direction, taskId), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "validate-mailbox") {
		const report = validateMailbox(loaded.manifest, { repair: cfg.repair === true });
		return result(JSON.stringify(report, null, 2), { action: "api", status: report.issues.some((issue) => issue.level === "error") && cfg.repair !== true ? "error" : "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot }, report.issues.some((issue) => issue.level === "error") && cfg.repair !== true);
	}
	if (operation === "read-delivery") {
		return result(JSON.stringify(readDeliveryState(loaded.manifest), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "send-message") {
		const direction = cfg.direction === "outbox" ? "outbox" : "inbox";
		const from = typeof cfg.from === "string" && cfg.from.trim() ? cfg.from.trim() : "api";
		const to = typeof cfg.to === "string" && cfg.to.trim() ? cfg.to.trim() : "leader";
		const body = typeof cfg.body === "string" && cfg.body.trim() ? cfg.body : undefined;
		const taskId = typeof cfg.taskId === "string" && cfg.taskId.trim() ? cfg.taskId.trim() : undefined;
		if (!body) return result("API send-message requires config.body.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		try {
			return withRunLockSync(loaded.manifest, () => {
				const message = appendMailboxMessage(loaded.manifest, { direction, from, to, body, taskId });
				appendEvent(loaded.manifest.eventsPath, { type: "mailbox.message", runId: loaded.manifest.runId, data: { id: message.id, direction, from, to } });
				ctx.events?.emit?.("crew.mailbox.message", { runId: loaded.manifest.runId, id: message.id, direction, from, to, taskId, source: "send-message" });
				return result(JSON.stringify(message, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		}
	}
	if (operation === "ack-message") {
		const messageId = typeof cfg.messageId === "string" ? cfg.messageId : undefined;
		if (!messageId) return result("API ack-message requires config.messageId.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		try {
			return withRunLockSync(loaded.manifest, () => {
				const delivery = acknowledgeMailboxMessage(loaded.manifest, messageId);
				appendEvent(loaded.manifest.eventsPath, { type: "mailbox.acknowledged", runId: loaded.manifest.runId, data: { messageId } });
				ctx.events?.emit?.("crew.mailbox.acknowledged", { runId: loaded.manifest.runId, messageId, delivery });
				return result(JSON.stringify(delivery, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		}
	}
	if (operation === "read-heartbeat") {
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
		if (!task) return result("API read-heartbeat requires config.taskId matching a task id or step id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		return result(JSON.stringify(task.heartbeat ?? null, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "claim-task") {
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		const owner = typeof cfg.owner === "string" ? cfg.owner : "api";
		const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
		if (!task) return result("API claim-task requires config.taskId matching a task id or step id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		try {
			return withRunLockSync(loaded.manifest, () => {
				const updatedTask = claimTask(task, owner);
				const tasks = loaded.tasks.map((item) => item.id === task.id ? updatedTask : item);
				saveRunTasks(loaded.manifest, tasks);
				appendEvent(loaded.manifest.eventsPath, { type: "task.claimed", runId: loaded.manifest.runId, taskId: task.id, data: { owner, token: updatedTask.claim?.token, leasedUntil: updatedTask.claim?.leasedUntil } });
				return result(JSON.stringify(updatedTask.claim, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		}
	}
	if (operation === "release-task-claim") {
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		const owner = typeof cfg.owner === "string" ? cfg.owner : undefined;
		const token = typeof cfg.token === "string" ? cfg.token : undefined;
		const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
		if (!task || !owner || !token) return result("API release-task-claim requires config.taskId, config.owner, and config.token.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		try {
			return withRunLockSync(loaded.manifest, () => {
				const updatedTask = releaseTaskClaim(task, owner, token);
				const tasks = loaded.tasks.map((item) => item.id === task.id ? updatedTask : item);
				saveRunTasks(loaded.manifest, tasks);
				appendEvent(loaded.manifest.eventsPath, { type: "task.claim_released", runId: loaded.manifest.runId, taskId: task.id, data: { owner } });
				return result(JSON.stringify(updatedTask, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		}
	}
	if (operation === "transition-task-status") {
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		const owner = typeof cfg.owner === "string" ? cfg.owner : undefined;
		const token = typeof cfg.token === "string" ? cfg.token : undefined;
		const to = cfg.status;
		const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
		if (!task || !owner || !token || !isTeamTaskStatus(to)) return result("API transition-task-status requires config.taskId, config.owner, config.token, and valid config.status.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		if (!canTransitionTaskStatus(task.status, to)) return result(`Invalid task status transition: ${task.status} -> ${to}`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		try {
			return withRunLockSync(loaded.manifest, () => {
				const updatedTask = transitionClaimedTaskStatus(task, owner, token, to);
				const tasks = loaded.tasks.map((item) => item.id === task.id ? updatedTask : item);
				saveRunTasks(loaded.manifest, tasks);
				appendEvent(loaded.manifest.eventsPath, { type: "task.status_transitioned", runId: loaded.manifest.runId, taskId: task.id, data: { owner, status: to } });
				return result(JSON.stringify(updatedTask, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		}
	}
	if (operation === "write-heartbeat") {
		const taskId = typeof cfg.taskId === "string" ? cfg.taskId : undefined;
		const task = loaded.tasks.find((item) => item.id === taskId || item.stepId === taskId);
		if (!task) return result("API write-heartbeat requires config.taskId matching a task id or step id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		try {
			return withRunLockSync(loaded.manifest, () => {
				const heartbeat = touchWorkerHeartbeat(task.heartbeat ?? { workerId: task.id, lastSeenAt: new Date().toISOString() }, { alive: typeof cfg.alive === "boolean" ? cfg.alive : undefined });
				const tasks = loaded.tasks.map((item) => item.id === task.id ? { ...item, heartbeat } : item);
				saveRunTasks(loaded.manifest, tasks);
				appendEvent(loaded.manifest.eventsPath, { type: "worker.heartbeat", runId: loaded.manifest.runId, taskId: task.id, data: { ...heartbeat } });
				return result(JSON.stringify(heartbeat, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return result(message, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		}
	}
	return result(`Unknown API operation: ${operation}`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
}
