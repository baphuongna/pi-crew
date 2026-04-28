import * as fs from "node:fs";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { loadConfig, updateAutonomousConfig, updateConfig } from "../config/config.ts";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import { withRunLock, withRunLockSync } from "../state/locks.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import { appendEvent, readEvents } from "../state/event-log.ts";
import { replayPendingMailboxMessages } from "../state/mailbox.ts";
import { cleanupRunWorktrees } from "../worktree/cleanup.ts";
import { piTeamsHelp } from "./help.ts";
import { initializeProject } from "./project-init.ts";
import { handleCreate, handleDelete, handleUpdate } from "./management.ts";
import { pruneFinishedRuns } from "./run-maintenance.ts";
import { exportRunBundle } from "./run-export.ts";
import { importRunBundle } from "./run-import.ts";
import { listImportedRuns } from "./import-index.ts";
import { listRuns } from "./run-index.ts";
import { validateWorkflowForTeam } from "../workflows/validate-workflow.ts";
import { formatValidationReport, validateResources } from "./validate-resources.ts";
import { formatRecommendation, recommendTeam } from "./team-recommendation.ts";
import type { PiTeamsToolResult } from "./tool-result.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { executeTeamRun } from "../runtime/team-runner.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../runtime/process-status.ts";
import { saveCrewAgents, readCrewAgents, recordFromTask } from "../runtime/crew-agent-records.ts";
import { resolveCrewRuntime } from "../runtime/runtime-resolver.ts";
import { applyAttentionState, formatActivityAge, resolveCrewControlConfig } from "../runtime/agent-control.ts";
import { writeForegroundInterruptRequest } from "../runtime/foreground-control.ts";
import { formatTaskGraphLines, waitingReason } from "../runtime/task-display.ts";
import { directTeamAndWorkflowFromRun } from "../runtime/direct-run.ts";
import { buildParentContext, configRecord, formatScoped, result, type TeamContext } from "./team-tool/context.ts";
import { autonomousPatchFromConfig, configPatchFromConfig, formatAutonomyStatus } from "./team-tool/config-patch.ts";
import { handleApi } from "./team-tool/api.ts";
import { handleRun } from "./team-tool/run.ts";
import { handleDoctor } from "./team-tool/doctor.ts";
import { logInternalError } from "../utils/internal-error.ts";

export type { TeamToolDetails } from "./team-tool-types.ts";
export type { TeamContext } from "./team-tool/context.ts";
export { handleRun } from "./team-tool/run.ts";
export { handleDoctor } from "./team-tool/doctor.ts";
export { handleApi } from "./team-tool/api.ts";

export function handleList(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const resource = params.resource;
	const blocks: string[] = [];
	if (!resource || resource === "team") {
		const teams = allTeams(discoverTeams(ctx.cwd));
		blocks.push("Teams:", ...(teams.length ? teams.map((team) => formatScoped(team.name, team.source, team.description)) : ["- (none)"]));
	}
	if (!resource || resource === "workflow") {
		const workflows = allWorkflows(discoverWorkflows(ctx.cwd));
		blocks.push("", "Workflows:", ...(workflows.length ? workflows.map((workflow) => formatScoped(workflow.name, workflow.source, workflow.description)) : ["- (none)"]));
	}
	if (!resource || resource === "agent") {
		const agents = allAgents(discoverAgents(ctx.cwd));
		blocks.push("", "Agents:", ...(agents.length ? agents.map((agent) => formatScoped(agent.name, agent.source, agent.description)) : ["- (none)"]));
	}
	if (!resource) {
		const runs = listRuns(ctx.cwd).slice(0, 10);
		blocks.push("", "Recent runs:", ...(runs.length ? runs.map((run) => `- ${run.runId} [${run.status}] ${run.team}/${run.workflow ?? "none"}: ${run.goal}`) : ["- (none)"]));
	}
	return result(blocks.join("\n"), { action: "list", status: "ok" });
}

export function handleGet(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (params.team) {
		const team = allTeams(discoverTeams(ctx.cwd)).find((item) => item.name === params.team);
		if (!team) return result(`Team '${params.team}' not found.`, { action: "get", status: "error" }, true);
		const lines = [
			`Team: ${team.name} (${team.source})`,
			`Path: ${team.filePath}`,
			`Description: ${team.description}`,
			`Default workflow: ${team.defaultWorkflow ?? "(none)"}`,
			`Workspace mode: ${team.workspaceMode ?? "single"}`,
			"Roles:",
			...(team.roles.length ? team.roles.map((role) => `- ${role.name} -> ${role.agent}${role.description ? `: ${role.description}` : ""}`) : ["- (none)"]),
		];
		return result(lines.join("\n"), { action: "get", status: "ok" });
	}
	if (params.workflow) {
		const workflow = allWorkflows(discoverWorkflows(ctx.cwd)).find((item) => item.name === params.workflow);
		if (!workflow) return result(`Workflow '${params.workflow}' not found.`, { action: "get", status: "error" }, true);
		const lines = [
			`Workflow: ${workflow.name} (${workflow.source})`,
			`Path: ${workflow.filePath}`,
			`Description: ${workflow.description}`,
			"Steps:",
			...(workflow.steps.length ? workflow.steps.map((step) => `- ${step.id} [${step.role}] dependsOn=${step.dependsOn?.join(",") ?? "none"}`) : ["- (none)"]),
		];
		return result(lines.join("\n"), { action: "get", status: "ok" });
	}
	if (params.agent) {
		const agent = allAgents(discoverAgents(ctx.cwd)).find((item) => item.name === params.agent);
		if (!agent) return result(`Agent '${params.agent}' not found.`, { action: "get", status: "error" }, true);
		const lines = [
			`Agent: ${agent.name} (${agent.source})`,
			`Path: ${agent.filePath}`,
			`Description: ${agent.description}`,
			agent.model ? `Model: ${agent.model}` : undefined,
			agent.skills?.length ? `Skills: ${agent.skills.join(", ")}` : undefined,
			"",
			agent.systemPrompt || "(empty system prompt)",
		].filter((line): line is string => line !== undefined);
		return result(lines.join("\n"), { action: "get", status: "ok" });
	}
	return result("Specify team, workflow, or agent for get.", { action: "get", status: "error" }, true);
}

export function handleStatus(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Status requires runId.", { action: "status", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "status", status: "error" }, true);
	let { manifest, tasks } = loaded;
	let asyncLivenessLine: string | undefined;
	if (manifest.async) {
		const asyncState = manifest.async;
		const liveness = checkProcessLiveness(asyncState.pid);
		asyncLivenessLine = `Async: pid=${asyncState.pid ?? "unknown"} alive=${liveness.alive ? "true" : "false"} detail=${liveness.detail} log=${asyncState.logPath} spawnedAt=${asyncState.spawnedAt}`;
		if (!liveness.alive && isActiveRunStatus(manifest.status)) {
			manifest = updateRunStatus(manifest, "failed", `Async process stale: ${liveness.detail}`);
			appendEvent(manifest.eventsPath, { type: "async.stale", runId: manifest.runId, message: liveness.detail, data: { pid: asyncState.pid } });
		}
	}
	const counts = new Map<string, number>();
	for (const task of tasks) counts.set(task.status, (counts.get(task.status) ?? 0) + 1);
	const events = readEvents(manifest.eventsPath).slice(-8);
	const controlConfig = resolveCrewControlConfig(loadConfig(ctx.cwd).config);
	const crewAgents = readCrewAgents(manifest).map((agent) => applyAttentionState(manifest, agent, controlConfig));
	const artifactLines = manifest.artifacts.slice(-10).map((artifact) => `- ${artifact.kind}: ${artifact.path}${artifact.sizeBytes !== undefined ? ` (${artifact.sizeBytes} bytes)` : ""}`);
	const totalUsage = aggregateUsage(tasks);
	const activeAgents = crewAgents.filter((agent) => agent.status === "running");
	const completedAgents = crewAgents.filter((agent) => agent.status !== "running");
	const waitingTasks = tasks.filter((task) => task.status === "queued");
	const agentLine = (agent: typeof crewAgents[number]): string => `- ${agent.id} [${agent.status}] ${agent.role} -> ${agent.agent} runtime=${agent.runtime}${agent.model ? ` model=${agent.model}` : ""}${agent.usage ? ` usage=${formatUsage(agent.usage)}` : ""}${agent.progress?.activityState === "needs_attention" ? " needs_attention" : ""}${formatActivityAge(agent) ? ` activity=${formatActivityAge(agent)}` : ""}${agent.progress?.currentTool ? ` tool=${agent.progress.currentTool}` : ""}${agent.toolUses ? ` tools=${agent.toolUses}` : ""}${!agent.usage && agent.progress?.tokens ? ` tokens=${agent.progress.tokens}` : ""}${agent.progress?.turns ? ` turns=${agent.progress.turns}` : ""}${agent.jsonEvents !== undefined ? ` jsonEvents=${agent.jsonEvents}` : ""}${agent.statusPath ? ` status=${agent.statusPath}` : ""}${agent.error ? ` error=${agent.error}` : ""}`;
	const lines = [
		`Run: ${manifest.runId}`,
		`Team: ${manifest.team}`,
		`Workflow: ${manifest.workflow ?? "(none)"}`,
		`Status: ${manifest.status}`,
		`Workspace mode: ${manifest.workspaceMode}`,
		`Goal: ${manifest.goal}`,
		`Created: ${manifest.createdAt}`,
		`Updated: ${manifest.updatedAt}`,
		`State: ${manifest.stateRoot}`,
		`Artifacts: ${manifest.artifactsRoot}`,
		...(asyncLivenessLine ? [asyncLivenessLine] : []),
		"Task graph:",
		...formatTaskGraphLines(tasks),
		"Tasks:",
		...(tasks.length ? tasks.map((task) => `- ${task.id} [${task.status}] ${task.role} -> ${task.agent}${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.modelAttempts?.length ? ` attempts=${task.modelAttempts.length}` : ""}${task.modelRouting ? ` modelRouting=${task.modelRouting.requested ? `${task.modelRouting.requested}->` : ""}${task.modelRouting.resolved}${task.modelRouting.usedAttempt ? ` attempt=${task.modelRouting.usedAttempt + 1}` : ""}` : ""}${task.jsonEvents !== undefined ? ` jsonEvents=${task.jsonEvents}` : ""}${task.usage ? ` usage=${JSON.stringify(task.usage)}` : ""}${task.worktree ? ` worktree=${task.worktree.path}` : ""}${task.error ? ` error=${task.error}` : ""}`) : ["- (none)"]),
		`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
		"Active agents:",
		...(activeAgents.length ? activeAgents.map(agentLine) : ["- (none)"]),
		"Waiting tasks:",
		...(waitingTasks.length ? waitingTasks.map((task) => `- ${task.id} [queued] ${task.role} -> ${task.agent} ${waitingReason(task, tasks) ?? "waiting"}`) : ["- (none)"]),
		"Completed agents:",
		...(completedAgents.length ? completedAgents.map(agentLine) : ["- (none)"]),
		"Policy decisions:",
		...(manifest.policyDecisions?.length ? manifest.policyDecisions.map((item) => `- ${item.action} (${item.reason})${item.taskId ? ` ${item.taskId}` : ""}: ${item.message}`) : ["- (none)"]),
		`Total usage: ${formatUsage(totalUsage)}`,
		"",
		"Recent artifacts:",
		...(artifactLines.length ? artifactLines : ["- (none)"]),
		"",
		"Recent events:",
		...(events.length ? events.map((event) => `- ${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? `: ${event.message}` : ""}`) : ["- (none)"]),
	];
	return result(lines.join("\n"), { action: "status", status: "ok", runId: manifest.runId, artifactsRoot: manifest.artifactsRoot });
}

export function handlePlan(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const teamName = params.team ?? "default";
	const team = allTeams(discoverTeams(ctx.cwd)).find((item) => item.name === teamName);
	if (!team) return result(`Team '${teamName}' not found.`, { action: "plan", status: "error" }, true);
	const workflowName = params.workflow ?? team.defaultWorkflow ?? "default";
	const workflow = allWorkflows(discoverWorkflows(ctx.cwd)).find((item) => item.name === workflowName);
	if (!workflow) return result(`Workflow '${workflowName}' not found.`, { action: "plan", status: "error" }, true);
	const errors = validateWorkflowForTeam(workflow, team);
	if (errors.length > 0) return result([`Workflow '${workflow.name}' is not valid for team '${team.name}':`, ...errors.map((error) => `- ${error}`)].join("\n"), { action: "plan", status: "error" }, true);
	const lines = [
		`Team plan: ${team.name}`,
		`Workflow: ${workflow.name}`,
		`Goal: ${params.goal ?? params.task ?? "(not provided)"}`,
		"",
		"Steps:",
		...workflow.steps.map((step, index) => `${index + 1}. ${step.id} [${step.role}]${step.dependsOn?.length ? ` after ${step.dependsOn.join(", ")}` : ""}`),
	];
	return result(lines.join("\n"), { action: "plan", status: "ok" });
}

export function handleCancel(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Cancel requires runId.", { action: "cancel", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "cancel", status: "error" }, true);
	return withRunLockSync(loaded.manifest, () => {
		if (loaded.manifest.status === "completed" && !params.force) {
			return result(`Run ${loaded.manifest.runId} is already completed; nothing to cancel. Use force: true to mark it cancelled anyway.`, { action: "cancel", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
		}
		const tasks = loaded.tasks.map((task) => task.status === "queued" || task.status === "running" ? { ...task, status: "cancelled" as const, finishedAt: new Date().toISOString(), error: "Run cancelled by user request." } : task);
		saveRunTasks(loaded.manifest, tasks);
		try {
			saveCrewAgents(loaded.manifest, tasks.map((task) => recordFromTask(loaded.manifest, task, "child-process")));
		} catch (error) {
			logInternalError("team-tool.handleCancel.crewAgents", error, `runId=${loaded.manifest.runId}`);
		}
		try {
			writeForegroundInterruptRequest(loaded.manifest, "Run cancelled by user request.");
		} catch (error) {
			logInternalError("team-tool.handleCancel.interruptRequest", error, `runId=${loaded.manifest.runId}`);
		}
		const updated = updateRunStatus(loaded.manifest, "cancelled", "Run cancelled by user request. Already-finished worker processes are not retroactively changed.");
		return result(`Cancelled run ${updated.runId}.`, { action: "cancel", status: "ok", runId: updated.runId, artifactsRoot: updated.artifactsRoot });
	});
}

function artifactKey(artifact: ArtifactDescriptor): string {
	return `${artifact.kind}:${artifact.path}`;
}

function recoverCheckpointedTasks(manifest: TeamRunManifest, tasks: TeamTaskState[]): { manifest: TeamRunManifest; tasks: TeamTaskState[]; recovered: string[] } {
	const recovered: string[] = [];
	let nextManifest = manifest;
	let nextTasks = tasks.map((task) => {
		if (task.status !== "running" || task.checkpoint?.phase !== "artifact-written" || !task.resultArtifact) return task;
		recovered.push(task.id);
		return { ...task, status: "completed" as const, finishedAt: task.finishedAt ?? task.checkpoint.updatedAt, error: undefined, claim: undefined };
	});
	if (recovered.length) {
		const artifacts = new Map(nextManifest.artifacts.map((artifact) => [artifactKey(artifact), artifact]));
		for (const task of nextTasks) {
			if (!recovered.includes(task.id)) continue;
			for (const artifact of [task.promptArtifact, task.resultArtifact, task.logArtifact, task.transcriptArtifact].filter(Boolean) as ArtifactDescriptor[]) artifacts.set(artifactKey(artifact), artifact);
		}
		nextManifest = { ...nextManifest, artifacts: [...artifacts.values()], updatedAt: new Date().toISOString() };
		saveRunManifest(nextManifest);
		saveRunTasks(nextManifest, nextTasks);
	}
	return { manifest: nextManifest, tasks: nextTasks, recovered };
}

export async function handleResume(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	if (!params.runId) return result("Resume requires runId.", { action: "resume", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "resume", status: "error" }, true);
	if (!loaded.manifest.workflow) return result(`Run '${params.runId}' has no workflow to resume.`, { action: "resume", status: "error" }, true);
	const agents = allAgents(discoverAgents(ctx.cwd));
	const direct = directTeamAndWorkflowFromRun(loaded.manifest, loaded.tasks, agents);
	const team = direct?.team ?? allTeams(discoverTeams(ctx.cwd)).find((candidate) => candidate.name === loaded.manifest.team);
	if (!team) return result(`Team '${loaded.manifest.team}' not found.`, { action: "resume", status: "error" }, true);
	const workflow = direct?.workflow ?? allWorkflows(discoverWorkflows(ctx.cwd)).find((candidate) => candidate.name === loaded.manifest.workflow);
	if (!workflow) return result(`Workflow '${loaded.manifest.workflow}' not found.`, { action: "resume", status: "error" }, true);
	return await withRunLock(loaded.manifest, async () => {
		const recovered = recoverCheckpointedTasks(loaded.manifest, loaded.tasks);
		const resumeManifest = recovered.manifest;
		const resetTasks = recovered.tasks.map((task) => task.status === "failed" || task.status === "cancelled" || task.status === "skipped" || task.status === "running" ? { ...task, status: "queued" as const, error: undefined, startedAt: undefined, finishedAt: undefined, claim: undefined } : task);
		saveRunTasks(resumeManifest, resetTasks);
		const replay = replayPendingMailboxMessages(resumeManifest);
		appendEvent(resumeManifest.eventsPath, { type: "run.resume_requested", runId: resumeManifest.runId, data: { replayedMailboxMessages: replay.messages.length, recoveredCheckpointTasks: recovered.recovered } });
		if (recovered.recovered.length) appendEvent(resumeManifest.eventsPath, { type: "task.checkpoint_recovered", runId: resumeManifest.runId, message: `Recovered ${recovered.recovered.length} task(s) from artifact-written checkpoints.`, data: { taskIds: recovered.recovered } });
		if (replay.messages.length) appendEvent(resumeManifest.eventsPath, { type: "mailbox.replayed", runId: resumeManifest.runId, message: `Replayed ${replay.messages.length} pending inbox message(s).`, data: { messageIds: replay.messages.map((message) => message.id), taskIds: replay.messages.map((message) => message.taskId).filter(Boolean) } });
		const loadedConfig = loadConfig(ctx.cwd);
		const runtime = await resolveCrewRuntime(loadedConfig.config);
		const executeWorkers = runtime.kind !== "scaffold";
		const executed = await executeTeamRun({ manifest: resumeManifest, tasks: resetTasks, team, workflow, agents, executeWorkers, limits: loadedConfig.config.limits, runtime, runtimeConfig: loadedConfig.config.runtime, parentContext: buildParentContext(ctx), parentModel: ctx.model, modelRegistry: ctx.modelRegistry, modelOverride: params.model, signal: ctx.signal });
		return result([`Resumed run ${executed.manifest.runId}.`, `Status: ${executed.manifest.status}`, `Tasks: ${executed.tasks.length}`, `Artifacts: ${executed.manifest.artifactsRoot}`].join("\n"), { action: "resume", status: executed.manifest.status === "failed" ? "error" : "ok", runId: executed.manifest.runId, artifactsRoot: executed.manifest.artifactsRoot }, executed.manifest.status === "failed");
	});
}

export function handleEvents(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Events requires runId.", { action: "events", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "events", status: "error" }, true);
	const events = readEvents(loaded.manifest.eventsPath);
	const lines = [`Events for ${loaded.manifest.runId}:`, ...(events.length ? events.map((event) => `${event.time} ${event.type}${event.taskId ? ` ${event.taskId}` : ""}${event.message ? `: ${event.message}` : ""}${event.data ? ` ${JSON.stringify(event.data)}` : ""}`) : ["(none)"])];
	return result(lines.join("\n"), { action: "events", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export function handleArtifacts(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Artifacts requires runId.", { action: "artifacts", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "artifacts", status: "error" }, true);
	const lines = [`Artifacts for ${loaded.manifest.runId}:`, ...(loaded.manifest.artifacts.length ? loaded.manifest.artifacts.map((artifact) => `- ${artifact.kind}: ${artifact.path}${artifact.sizeBytes !== undefined ? ` (${artifact.sizeBytes} bytes)` : ""}${artifact.contentHash ? ` sha256=${artifact.contentHash.slice(0, 12)}` : ""}`) : ["- (none)"])];
	return result(lines.join("\n"), { action: "artifacts", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export function handleSummary(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Summary requires runId.", { action: "summary", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "summary", status: "error" }, true);
	const usage = aggregateUsage(loaded.tasks);
	const lines = [
		`Summary for ${loaded.manifest.runId}`,
		`Status: ${loaded.manifest.status}`,
		`Team: ${loaded.manifest.team}`,
		`Workflow: ${loaded.manifest.workflow ?? "(none)"}`,
		`Goal: ${loaded.manifest.goal}`,
		`Usage: ${formatUsage(usage)}`,
		"Tasks:",
		...loaded.tasks.map((task) => `- ${task.id}: ${task.status} (${task.role} -> ${task.agent})${task.error ? ` - ${task.error}` : ""}`),
	];
	return result(lines.join("\n"), { action: "summary", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export function handleWorktrees(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Worktrees requires runId.", { action: "worktrees", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "worktrees", status: "error" }, true);
	const withWorktrees = loaded.tasks.filter((task) => task.worktree);
	const lines = [
		`Worktrees for ${loaded.manifest.runId}:`,
		...(withWorktrees.length ? withWorktrees.map((task) => `- ${task.id}: ${task.worktree!.path} branch=${task.worktree!.branch} reused=${task.worktree!.reused ? "true" : "false"}`) : ["- (none)"]),
	];
	return result(lines.join("\n"), { action: "worktrees", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export function handleImports(_params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const imports = listImportedRuns(ctx.cwd);
	const lines = [
		"Imported pi-crew runs:",
		...(imports.length ? imports.map((entry) => `- ${entry.runId} (${entry.scope})${entry.status ? ` [${entry.status}]` : ""} ${entry.team ?? "unknown"}/${entry.workflow ?? "none"}: ${entry.goal ?? ""}\n  Bundle: ${entry.bundlePath}\n  Summary: ${entry.summaryPath}`) : ["- (none)"]),
	];
	return result(lines.join("\n"), { action: "imports", status: "ok" });
}

export function handleImport(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const cfg = configRecord(params.config);
	const bundlePath = typeof cfg.path === "string" ? cfg.path : typeof cfg.bundlePath === "string" ? cfg.bundlePath : undefined;
	if (!bundlePath) return result("Import requires config.path pointing at run-export.json.", { action: "import", status: "error" }, true);
	const scope = cfg.scope === "user" ? "user" : "project";
	try {
		const imported = importRunBundle(ctx.cwd, bundlePath, scope);
		return result([`Imported run bundle ${imported.runId}.`, `Bundle: ${imported.bundlePath}`, `Summary: ${imported.summaryPath}`].join("\n"), { action: "import", status: "ok" });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`Import failed: ${message}`, { action: "import", status: "error" }, true);
	}
}

export function handleExport(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Export requires runId.", { action: "export", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "export", status: "error" }, true);
	const exported = exportRunBundle(loaded.manifest, loaded.tasks);
	appendEvent(loaded.manifest.eventsPath, { type: "run.exported", runId: loaded.manifest.runId, data: exported });
	return result([`Exported run ${loaded.manifest.runId}.`, `JSON: ${exported.jsonPath}`, `Markdown: ${exported.markdownPath}`].join("\n"), { action: "export", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export function handlePrune(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const keep = params.keep ?? 20;
	if (!params.confirm) return result("prune requires confirm: true.", { action: "prune", status: "error" }, true);
	if (keep < 0 || !Number.isInteger(keep)) return result("keep must be an integer >= 0.", { action: "prune", status: "error" }, true);
	const pruned = pruneFinishedRuns(ctx.cwd, keep);
	return result([`Pruned finished pi-crew runs.`, `Kept: ${pruned.kept.length}`, `Removed: ${pruned.removed.length}`, ...(pruned.removed.length ? ["Removed runs:", ...pruned.removed.map((runId) => `- ${runId}`)] : [])].join("\n"), { action: "prune", status: "ok" });
}

export function handleForget(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Forget requires runId.", { action: "forget", status: "error" }, true);
	if (!params.confirm) return result("forget requires confirm: true.", { action: "forget", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "forget", status: "error" }, true);
	const cleanup = cleanupRunWorktrees(loaded.manifest, { force: params.force });
	if (cleanup.preserved.length > 0 && !params.force) {
		return result([`Run '${params.runId}' has preserved worktrees. Use force: true to forget anyway.`, ...cleanup.preserved.map((item) => `- ${item.path}: ${item.reason}`)].join("\n"), { action: "forget", status: "error", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot }, true);
	}
	fs.rmSync(loaded.manifest.stateRoot, { recursive: true, force: true });
	fs.rmSync(loaded.manifest.artifactsRoot, { recursive: true, force: true });
	return result([`Forgot run ${loaded.manifest.runId}.`, `Removed state: ${loaded.manifest.stateRoot}`, `Removed artifacts: ${loaded.manifest.artifactsRoot}`, ...(cleanup.removed.length ? ["Removed worktrees:", ...cleanup.removed.map((item) => `- ${item}`)] : [])].join("\n"), { action: "forget", status: "ok", runId: loaded.manifest.runId });
}

export function handleCleanup(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	if (!params.runId) return result("Cleanup requires runId.", { action: "cleanup", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "cleanup", status: "error" }, true);
	const cleanup = cleanupRunWorktrees(loaded.manifest, { force: params.force });
	appendEvent(loaded.manifest.eventsPath, { type: "worktree.cleanup", runId: loaded.manifest.runId, data: { removed: cleanup.removed, preserved: cleanup.preserved, artifacts: cleanup.artifactPaths } });
	const lines = [
		`Worktree cleanup for ${loaded.manifest.runId}:`,
		"Removed:",
		...(cleanup.removed.length ? cleanup.removed.map((item) => `- ${item}`) : ["- (none)"]),
		"Preserved:",
		...(cleanup.preserved.length ? cleanup.preserved.map((item) => `- ${item.path}: ${item.reason}`) : ["- (none)"]),
		"Artifacts:",
		...(cleanup.artifactPaths.length ? cleanup.artifactPaths.map((item) => `- ${item}`) : ["- (none)"]),
	];
	return result(lines.join("\n"), { action: "cleanup", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
}

export async function handleTeamTool(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const action = params.action ?? "list";
	switch (action) {
		case "list": return handleList(params, ctx);
		case "get": return handleGet(params, ctx);
		case "init": {
			const cfg = configRecord(params.config);
			const initialized = initializeProject(ctx.cwd, { copyBuiltins: cfg.copyBuiltins === true, overwrite: cfg.overwrite === true });
			return result([
				"Initialized pi-crew project layout.",
				"Directories:",
				...(initialized.createdDirs.length ? initialized.createdDirs.map((dir) => `- created ${dir}`) : ["- already existed"]),
				"Copied builtin files:",
				...(initialized.copiedFiles.length ? initialized.copiedFiles.map((file) => `- ${file}`) : ["- (none)"]),
				...(initialized.skippedFiles.length ? ["Skipped existing files:", ...initialized.skippedFiles.map((file) => `- ${file}`)] : []),
				`Gitignore: ${initialized.gitignorePath} (${initialized.gitignoreUpdated ? "updated" : "already configured"})`,
			].join("\n"), { action: "init", status: "ok" });
		}
		case "help": return result(piTeamsHelp(), { action: "help", status: "ok" });
		case "recommend": {
			const goal = params.goal ?? params.task;
			if (!goal) return result("Recommend requires goal or task.", { action: "recommend", status: "error" }, true);
			const loaded = loadConfig(ctx.cwd);
			const recommendation = recommendTeam(goal, loaded.config.autonomous, { teams: allTeams(discoverTeams(ctx.cwd)), agents: allAgents(discoverAgents(ctx.cwd)) });
			return result(formatRecommendation(goal, recommendation), { action: "recommend", status: "ok" });
		}
		case "autonomy": {
			const patch = autonomousPatchFromConfig(params.config);
			const shouldUpdate = Object.values(patch).some((value) => value !== undefined);
			if (!shouldUpdate) {
				const loaded = loadConfig(ctx.cwd);
				return result(formatAutonomyStatus(loaded.config.autonomous, loaded.path, false), { action: "autonomy", status: loaded.error ? "error" : "ok" }, Boolean(loaded.error));
			}
			try {
				const saved = updateAutonomousConfig(patch);
				return result(formatAutonomyStatus(saved.config.autonomous, saved.path, true), { action: "autonomy", status: "ok" });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return result(message, { action: "autonomy", status: "error" }, true);
			}
		}
		case "config": {
			const patch = configPatchFromConfig(params.config);
			const cfg = configRecord(params.config);
			const unsetPaths = Array.isArray(cfg.unset) ? cfg.unset.filter((entry): entry is string => typeof entry === "string") : typeof cfg.unset === "string" ? [cfg.unset] : [];
			const shouldUpdate = Object.values(patch).some((value) => value !== undefined) || unsetPaths.length > 0;
			if (shouldUpdate) {
				try {
					const saved = updateConfig(patch, { cwd: ctx.cwd, scope: cfg.scope === "project" ? "project" : "user", unsetPaths });
					return result(["Updated pi-crew config.", `Path: ${saved.path}`, "Effective config:", JSON.stringify(saved.config, null, 2)].join("\n"), { action: "config", status: "ok" });
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					return result(message, { action: "config", status: "error" }, true);
				}
			}
			const loaded = loadConfig(ctx.cwd);
			const lines = [
				"pi-crew config:",
				`Path: ${loaded.path}`,
				`Status: ${loaded.error ? `error: ${loaded.error}` : "ok"}`,
				"Effective config:",
				JSON.stringify(loaded.config, null, 2),
				"Schema: package export ./schema.json",
			];
			return result(lines.join("\n"), { action: "config", status: loaded.error ? "error" : "ok" }, Boolean(loaded.error));
		}
		case "validate": {
			const report = validateResources(ctx.cwd);
			const hasErrors = report.issues.some((issue) => issue.level === "error");
			return result(formatValidationReport(report), { action: "validate", status: hasErrors ? "error" : "ok" }, hasErrors);
		}
		case "doctor": return handleDoctor(ctx, params);
		case "cleanup": return handleCleanup(params, ctx);
		case "api": return await handleApi(params, ctx);
		case "events": return handleEvents(params, ctx);
		case "artifacts": return handleArtifacts(params, ctx);
		case "worktrees": return handleWorktrees(params, ctx);
		case "summary": return handleSummary(params, ctx);
		case "export": return handleExport(params, ctx);
		case "import": return handleImport(params, ctx);
		case "imports": return handleImports(params, ctx);
		case "prune": return handlePrune(params, ctx);
		case "forget": return handleForget(params, ctx);
		case "run": return handleRun(params, ctx);
		case "status": return handleStatus(params, ctx);
		case "cancel": return handleCancel(params, ctx);
		case "plan": return handlePlan(params, ctx);
		case "resume": return handleResume(params, ctx);
		case "create": return handleCreate(params, ctx);
		case "update": return handleUpdate(params, ctx);
		case "delete": return handleDelete(params, ctx);
		default: return result(`Unknown action: ${action}`, { action: "unknown", status: "error" }, true);
	}
}
