import { loadConfig } from "../../config/config.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { appendEvent, readEvents } from "../../state/event-log.ts";
import { readDeliveryState, readMailbox } from "../../state/mailbox.ts";
import { loadRunManifestById, updateRunStatus, saveRunTasks } from "../../state/state-store.ts";
import { aggregateUsage, formatUsage, formatCost } from "../../state/usage.ts";
import { applyAttentionState, formatActivityAge, resolveCrewControlConfig } from "../../runtime/agent-control.ts";
import { readCrewAgents } from "../../runtime/crew-agent-records.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../../runtime/process-status.ts";
import { formatTaskGraphLines, waitingReason } from "../../runtime/task-display.ts";
import { computePhaseProgress } from "../../runtime/phase-progress.ts";
import { formatDuration } from "../../ui/tool-render.ts";
import { verifyTaskCompletion } from "../../runtime/completion-guard.ts";
import { evaluateRunEffectiveness } from "../../runtime/effectiveness.ts";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { locateRunCwd } from "../team-tool.ts";
import { result, type TeamContext } from "./context.ts";
import { RUN_NOT_FOUND_HINT } from "./run-not-found.ts";

export function handleStatus(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Status requires runId.", { action: "status", status: "error" }, true);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "status", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "status", status: "error" }, true);
	let { manifest, tasks } = loaded;
	// DX (Round 16 F3): compact status mode. Default = full (backward compatible).
	// details=false gives a tight summary (status, goal, counts, failed/attention
	// errors) for quick checks without 40 lines of dense key=value noise.
	const fullDetails = params.details !== false;
	let asyncLivenessLine: string | undefined;
	if (manifest.async) {
		const asyncState = manifest.async;
		const liveness = checkProcessLiveness(asyncState.pid);
		asyncLivenessLine = `Async: pid=${asyncState.pid ?? "unknown"} alive=${liveness.alive ? "true" : "false"} detail=${liveness.detail} log=${asyncState.logPath} spawnedAt=${asyncState.spawnedAt}`;
		if (!liveness.alive && isActiveRunStatus(manifest.status)) {
			manifest = updateRunStatus(manifest, "failed", `Async process stale: ${liveness.detail}`);
			tasks = tasks.map((task) => task.status === "running" ? { ...task, status: "cancelled" as const, finishedAt: new Date().toISOString(), error: "Async process died; task was not completed." } : task);
			saveRunTasks(manifest, tasks);
			appendEvent(manifest.eventsPath, { type: "async.stale", runId: manifest.runId, message: liveness.detail, data: { pid: asyncState.pid } });
		}
	}
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const phaseProgress = computePhaseProgress(tasks);
	const allEvents = readEvents(manifest.eventsPath);
	const events = allEvents.slice(-8);
	const attentionByTask = new Map(allEvents.filter((event) => event.type === "task.attention" && event.taskId).map((event) => [event.taskId!, event]));
	const controlConfig = resolveCrewControlConfig(loadConfig(ctx.cwd).config);
	const crewAgents = readCrewAgents(manifest).map((agent) => applyAttentionState(manifest, agent, controlConfig));
	const artifactLines = manifest.artifacts.slice(-10).map((artifact) => `- ${artifact.kind}: ${artifact.path}${artifact.sizeBytes !== undefined ? ` (${artifact.sizeBytes} bytes)` : ""}`);
	const deliveryState = readDeliveryState(manifest);
	const ackTimeoutMs = loadConfig(ctx.cwd).config.runtime?.groupJoinAckTimeoutMs;
	const groupJoinLines: string[] = [];
	for (const message of readMailbox(manifest, "outbox").filter((m) => m.data?.kind === "group_join").slice(-5)) {
		const ack = deliveryState.messages[message.id] === "acknowledged" ? "acknowledged" : "pending";
		const ageMs = Date.now() - new Date(message.createdAt).getTime();
		const requestId = String(message.data?.requestId ?? "unknown");
		const timedOut = ack === "pending" && ackTimeoutMs !== undefined && Number.isFinite(ageMs) && ageMs > ackTimeoutMs;
		if (timedOut && !allEvents.some((event) => event.type === "agent.group_join.ack_timeout" && event.data?.requestId === requestId)) {
			appendEvent(manifest.eventsPath, { type: "agent.group_join.ack_timeout", runId: manifest.runId, message: "Group join delivery ack timed out; mailbox delivery remains the fallback.", data: { requestId, messageId: message.id, batchId: message.data?.batchId, partial: message.data?.partial, ageMs, ackTimeoutMs } });
		}
		groupJoinLines.push(`- ${String(message.data?.partial) === "true" ? "partial" : "completed"} request=${requestId} message=${message.id} ack=${timedOut ? "timeout" : ack}`);
	}
	const totalUsage = aggregateUsage(tasks);
	const completedTasks = tasks.filter((task) => task.status === "completed");
	const effectiveness = evaluateRunEffectiveness({ manifest, tasks, executeWorkers: manifest.runtimeResolution?.kind !== "scaffold", runtimeConfig: loadConfig(ctx.cwd).config.runtime });
	const noObservedWorkTasks = effectiveness.noObservedWorkTaskIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is typeof tasks[number] => task !== undefined);
	const attentionTasks = effectiveness.needsAttentionTaskIds.map((id) => tasks.find((task) => task.id === id)).filter((task): task is typeof tasks[number] => task !== undefined);
	const activeAgents = crewAgents.filter((agent) => agent.status === "running");
	const completedAgents = crewAgents.filter((agent) => agent.status !== "running");
	const waitingTasks = tasks.filter((task) => task.status === "queued" || task.status === "waiting");
	const agentLine = (agent: typeof crewAgents[number]): string => `- ${agent.id} [${agent.status}] ${agent.role} -> ${agent.agent} runtime=${agent.runtime}${agent.model ? ` model=${agent.model}` : ""}${agent.usage ? ` usage=${formatUsage(agent.usage)}` : ""}${agent.usage?.cost ? ` cost=${formatCost(agent.usage.cost)}` : ""}${agent.progress?.activityState ? ` activityState=${agent.progress.activityState}` : ""}${formatActivityAge(agent) ? ` activity=${formatActivityAge(agent)}` : ""}${agent.progress?.currentTool ? ` tool=${agent.progress.currentTool}` : ""}${agent.toolUses ? ` tools=${agent.toolUses}` : ""}${!agent.usage && agent.progress?.tokens ? ` tokens=${agent.progress.tokens}` : ""}${agent.progress?.turns ? ` turns=${agent.progress.turns}` : ""}${agent.jsonEvents !== undefined ? ` jsonEvents=${agent.jsonEvents}` : ""}${agent.outputPath ? ` output=${agent.outputPath}` : ""}${agent.transcriptPath ? ` transcript=${agent.transcriptPath}` : ""}${agent.statusPath ? ` status=${agent.statusPath}` : ""}${agent.error ? ` error=${agent.error}` : ""}`;
	const lines = [
		`Run: ${manifest.runId}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`Status: ${manifest.status}`,
		`Progress: ${phaseProgress.overallPercentage}% (~${formatDuration(phaseProgress.estimatedRemainingMs)} remaining)`,
		`Workspace mode: ${manifest.workspaceMode}`,
		...(manifest.runtimeResolution ? [`Runtime: ${manifest.runtimeResolution.kind}`, `Runtime safety: ${manifest.runtimeResolution.safety}`, `Runtime requested: ${manifest.runtimeResolution.requestedMode}${manifest.runtimeResolution.reason ? ` (${manifest.runtimeResolution.reason})` : ""}`] : []),
		`Goal: ${manifest.goal}`,
		`Created: ${manifest.createdAt}`,
		`Updated: ${manifest.updatedAt}`,
		`State: ${manifest.stateRoot}`,
		`Artifacts: ${manifest.artifactsRoot}`,
		...(asyncLivenessLine ? [asyncLivenessLine] : []),
		"Task graph:",
		...formatTaskGraphLines(tasks),
		"Tasks:",
		...(tasks.length ? tasks.map((task) => `- ${task.id} [${task.status}] ${task.role} -> ${task.agent}${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.modelAttempts?.length ? ` attempts=${task.modelAttempts.length}` : ""}${task.modelRouting ? ` modelRouting=${task.modelRouting.requested ? `${task.modelRouting.requested}->` : ""}${task.modelRouting.resolved}${task.modelRouting.usedAttempt ? ` attempt=${task.modelRouting.usedAttempt + 1}` : ""}` : ""}${task.agentProgress?.activityState ? ` activityState=${task.agentProgress.activityState}` : ""}${attentionByTask.get(task.id)?.data?.reason ? ` attention=${String(attentionByTask.get(task.id)?.data?.reason)}` : ""}${task.jsonEvents !== undefined ? ` jsonEvents=${task.jsonEvents}` : ""}${task.usage ? ` usage=${JSON.stringify(task.usage)}` : ""}${task.resultArtifact ? ` result=${task.resultArtifact.path}` : ""}${task.transcriptArtifact ? ` transcript=${task.transcriptArtifact.path}` : ""}${task.worktree ? ` worktree=${task.worktree.path}` : ""}${task.error ? ` error=${task.error}` : ""}`) : ["- (none)"]),
		`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
		"Effectiveness:",
		`- observable=${effectiveness.observable}/${Math.max(1, effectiveness.completed)} completed tasks`,
		`- workerExecution=${effectiveness.workerExecution} guard=${effectiveness.guardMode} severity=${effectiveness.severity}`,
		`- noObservedWork=${effectiveness.noObservedWorkTaskIds.length ? effectiveness.noObservedWorkTaskIds.join(",") : "none"}`,
		`- needsAttention=${effectiveness.needsAttentionTaskIds.length ? effectiveness.needsAttentionTaskIds.join(",") : "none"}`,
		"Completion verification",
		...(tasks.filter((t) => t.status === "completed").length ? tasks.filter((t) => t.status === "completed").map((t) => {
			const guard = verifyTaskCompletion(t, manifest);
			return `- ${t.id} green=${guard.greenLevel}/3${guard.warnings.length ? ` warnings=[${guard.warnings.join(", ")}]` : ""}`;
		}) : ["- (no completed tasks)"]),
		"Active agents:",
		...(activeAgents.length ? activeAgents.map(agentLine) : ["- (none)"]),
		"Waiting tasks:",
		...(waitingTasks.length ? waitingTasks.map((task) => `- ${task.id} [queued] ${task.role} -> ${task.agent} ${waitingReason(task, tasks) ?? "waiting"}`) : ["- (none)"]),
		"Completed agents:",
		...(completedAgents.length ? completedAgents.map(agentLine) : ["- (none)"]),
		"Policy decisions:",
		...(manifest.policyDecisions?.length ? manifest.policyDecisions.map((item) => `- ${item.action} (${item.reason})${item.taskId ? ` ${item.taskId}` : ""}: ${item.message}`) : ["- (none)"]),
		`Total usage: ${formatUsage(totalUsage)}`,
		"Group joins:",
		...(groupJoinLines.length ? groupJoinLines : ["- (none)"]),
		"",
		"Recent artifacts:",
		...(artifactLines.length ? artifactLines : ["- (none)"]),
		"",
		"Recent events:",
		...(events.length ? events.map((event) => `- ${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? `: ${event.message}` : ""}`) : ["- (none)"]),
	];
	if (!fullDetails) {
		return result(
			buildCompactStatus(manifest, tasks, counts, asyncLivenessLine, phaseProgress).join("\n"),
			{ action: "status", status: "ok", runId: manifest.runId, artifactsRoot: manifest.artifactsRoot, intent: `status ${manifest.runId}: ${manifest.status} (compact)` },
		);
	}
	return result(lines.join("\n"), { action: "status", status: "ok", runId: manifest.runId, artifactsRoot: manifest.artifactsRoot, intent: `status ${manifest.runId}: ${manifest.status}` });
}

/**
 * Compact status builder (DX: Round 16 F3). A tight summary for quick checks:
 * identity, status, goal, task counts, and ONLY failed / attention task
 * errors — not the 40-line dense dump. Invoked when params.details === false.
 *
 * Exported for unit testing.
 */
export function buildCompactStatus(
	manifest: { runId: string; team: string; workflow?: string; status: string; goal: string; workspaceMode?: string },
	tasks: Array<{ id: string; status: string; role: string; agent: string; error?: string }>,
	counts: Map<string, number>,
	asyncLivenessLine?: string,
	progress?: { overallPercentage: number; estimatedRemainingMs: number },
): string[] {
	const failedOrAttention = tasks.filter(
		(t) =>
			t.status === "failed" ||
			t.status === "needs_attention" ||
			t.status === "cancelled",
	);
	const lines = [
		`Run: ${manifest.runId}`,
		`Team: ${manifest.team}${manifest.workflow ? ` (${manifest.workflow})` : ""}`,
		`Status: ${manifest.status}`,
		...(progress ? [`Progress: ${progress.overallPercentage}% (~${formatDuration(progress.estimatedRemainingMs)} remaining)`] : []),
		`Goal: ${manifest.goal}`,
		...(asyncLivenessLine ? [asyncLivenessLine] : []),
		`Tasks: ${[...counts.entries()].map(([s, c]) => `${s}=${c}`).join(", ") || "none"}`,
	];
	if (failedOrAttention.length > 0) {
		lines.push("Issues:");
		for (const t of failedOrAttention) {
			lines.push(`- ${t.id} [${t.status}] ${t.role}: ${t.error ?? "(no error detail)"}`);
		}
	}
	lines.push("Tip: pass details=true for full output (task graph, agents, effectiveness, events).");
	return lines;
}
