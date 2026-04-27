import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { effectiveAutonomousConfig, loadConfig, updateAutonomousConfig, updateConfig, type PiTeamsAutonomousConfig, type PiTeamsConfig } from "../config/config.ts";
import { projectPiRoot, userPiRoot } from "../utils/paths.ts";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import { withRunLock, withRunLockSync } from "../state/locks.ts";
import { canTransitionTaskStatus, isTeamTaskStatus } from "../state/contracts.ts";
import { claimTask, releaseTaskClaim, transitionClaimedTaskStatus } from "../state/task-claims.ts";
import { acknowledgeMailboxMessage, appendMailboxMessage, readDeliveryState, readMailbox, validateMailbox, type MailboxDirection } from "../state/mailbox.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { validateWorkflowForTeam } from "../workflows/validate-workflow.ts";
import { getPiSpawnCommand } from "../runtime/pi-spawn.ts";
import { executeTeamRun } from "../runtime/team-runner.ts";
import { spawnBackgroundTeamRun } from "../runtime/async-runner.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../runtime/process-status.ts";
import { appendEvent, readEvents, readEventsCursor } from "../state/event-log.ts";
import { cleanupRunWorktrees } from "../worktree/cleanup.ts";
import { piTeamsHelp } from "./help.ts";
import { initializeProject } from "./project-init.ts";
import { handleCreate, handleDelete, handleUpdate } from "./management.ts";
import { pruneFinishedRuns } from "./run-maintenance.ts";
import { exportRunBundle } from "./run-export.ts";
import { importRunBundle } from "./run-import.ts";
import { listImportedRuns } from "./import-index.ts";
import { listRuns } from "./run-index.ts";
import { formatValidationReport, validateResources } from "./validate-resources.ts";
import { formatRecommendation, recommendTeam } from "./team-recommendation.ts";
import { toolResult, type PiTeamsToolResult } from "./tool-result.ts";
import { touchWorkerHeartbeat } from "../runtime/worker-heartbeat.ts";
import { agentEventsPath, agentOutputPath, readCrewAgentEvents, readCrewAgentEventsCursor, readCrewAgentStatus, readCrewAgents } from "../runtime/crew-agent-records.ts";
import { resolveCrewRuntime } from "../runtime/runtime-resolver.ts";
import { probeLiveSessionRuntime } from "../runtime/live-session-runtime.ts";
import { applyAttentionState, formatActivityAge, resolveCrewControlConfig } from "../runtime/agent-control.ts";
import { buildAgentDashboard, readAgentOutput } from "../runtime/agent-observability.ts";

export interface TeamToolDetails {
	action: string;
	status: "ok" | "error" | "planned";
	runId?: string;
	artifactsRoot?: string;
}

type TeamContext = Pick<ExtensionContext, "cwd"> & Partial<Pick<ExtensionContext, "model">>;

function result(text: string, details: TeamToolDetails, isError = false): PiTeamsToolResult {
	return toolResult(text, details, isError);
}

function formatScoped(name: string, source: string, description: string): string {
	return `- ${name} (${source}): ${description}`;
}

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

function firstOutputLine(stdout: string | null | undefined, stderr: string | null | undefined): string {
	const output = `${stdout ?? ""}\n${stderr ?? ""}`.trim();
	return output.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "available";
}

function commandExists(command: string, args: string[]): { ok: boolean; detail: string } {
	const output = spawnSync(command, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	if (!output.error && output.status === 0) return { ok: true, detail: firstOutputLine(output.stdout, output.stderr) };
	return { ok: false, detail: output.error?.message ?? firstOutputLine(output.stdout, output.stderr) };
}

function piCommandExists(): { ok: boolean; detail: string } {
	const spec = getPiSpawnCommand(["--version"]);
	const output = spawnSync(spec.command, spec.args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
	if (!output.error && output.status === 0) {
		const executable = spec.command === "pi" ? "pi" : `${spec.command} ${spec.args[0] ?? ""}`.trim();
		return { ok: true, detail: `${firstOutputLine(output.stdout, output.stderr)} (${executable})` };
	}
	return { ok: false, detail: output.error?.message ?? firstOutputLine(output.stdout, output.stderr) };
}

function checkWritableDir(dir: string): { ok: boolean; detail: string } {
	try {
		fs.mkdirSync(dir, { recursive: true });
		const probe = path.join(dir, `.pi-crew-write-${process.pid}-${Date.now()}`);
		fs.writeFileSync(probe, "ok", "utf-8");
		fs.unlinkSync(probe);
		return { ok: true, detail: dir };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, detail: `${dir}: ${message}` };
	}
}

export function handleDoctor(ctx: TeamContext, params: TeamToolParamsValue = {}): PiTeamsToolResult {
	const discoveredAgents = allAgents(discoverAgents(ctx.cwd));
	const agentCount = discoveredAgents.length;
	const teamCount = allTeams(discoverTeams(ctx.cwd)).length;
	const workflowCount = allWorkflows(discoverWorkflows(ctx.cwd)).length;
	const git = commandExists("git", ["--version"]);
	const pi = piCommandExists();
	const loadedConfig = loadConfig(ctx.cwd);
	const userWritable = checkWritableDir(path.join(userPiRoot(), "extensions", "pi-crew"));
	const projectWritable = checkWritableDir(path.join(projectPiRoot(ctx.cwd), "teams"));
	const validation = validateResources(ctx.cwd);
	const validationErrors = validation.issues.filter((issue) => issue.level === "error").length;
	const validationWarnings = validation.issues.filter((issue) => issue.level === "warning").length;
	let smokeChildPi: { ok: boolean; detail: string } | undefined;
	const doctorCfg = configRecord(params.config);
	if (doctorCfg.smokeChildPi === true) {
		try {
			const spec = getPiSpawnCommand(["--mode", "json", "-p", "Reply with exactly PI-TEAMS-SMOKE-OK"]);
			const output = execFileSync(spec.command, spec.args, { cwd: ctx.cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 }).trim();
			smokeChildPi = { ok: output.includes("PI-TEAMS-SMOKE-OK"), detail: output.split("\n").slice(-1)[0] ?? "completed" };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			smokeChildPi = { ok: false, detail: message };
		}
	}
	const checks = [
		{ label: "cwd", ok: fs.existsSync(ctx.cwd), detail: ctx.cwd },
		{ label: "platform", ok: true, detail: `${process.platform}/${process.arch} node=${process.version}` },
		{ label: "pi command", ok: pi.ok, detail: pi.detail },
		{ label: "git command", ok: git.ok, detail: git.detail },
		{ label: "user state writable", ok: userWritable.ok, detail: userWritable.detail },
		{ label: "project state writable", ok: projectWritable.ok, detail: projectWritable.detail },
		{ label: "config", ok: !loadedConfig.error, detail: loadedConfig.error ? `${loadedConfig.path}: ${loadedConfig.error}` : loadedConfig.path },
		{ label: "current model", ok: true, detail: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not available in this context" },
		{ label: "resource model hints", ok: true, detail: `${discoveredAgents.filter((agent) => agent.model || agent.fallbackModels?.length).length} agents declare model/fallback preferences` },
		{ label: "agents", ok: agentCount > 0, detail: `${agentCount} discovered` },
		{ label: "teams", ok: teamCount > 0, detail: `${teamCount} discovered` },
		{ label: "workflows", ok: workflowCount > 0, detail: `${workflowCount} discovered` },
		{ label: "resource validation", ok: validationErrors === 0, detail: `${validationErrors} errors, ${validationWarnings} warnings` },
		...(smokeChildPi ? [{ label: "child Pi smoke", ok: smokeChildPi.ok, detail: smokeChildPi.detail }] : []),
	];
	const text = ["pi-crew doctor:", ...checks.map((check) => `- ${check.ok ? "OK" : "FAIL"} ${check.label}: ${check.detail}`)].join("\n");
	return result(text, { action: "doctor", status: checks.every((check) => check.ok) ? "ok" : "error" }, checks.some((check) => !check.ok));
}

export async function handleRun(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const goal = params.goal ?? params.task;
	if (!goal) return result("Run requires goal or task.", { action: "run", status: "error" }, true);

	const teams = allTeams(discoverTeams(ctx.cwd));
	const workflows = allWorkflows(discoverWorkflows(ctx.cwd));
	const agents = allAgents(discoverAgents(ctx.cwd));
	const teamName = params.team ?? "default";
	const team = teams.find((item) => item.name === teamName);
	if (!team) return result(`Team '${teamName}' not found.`, { action: "run", status: "error" }, true);
	const workflowName = params.workflow ?? team.defaultWorkflow ?? "default";
	const workflow = workflows.find((item) => item.name === workflowName);
	if (!workflow) return result(`Workflow '${workflowName}' not found.`, { action: "run", status: "error" }, true);

	const validationErrors = validateWorkflowForTeam(workflow, team);
	if (validationErrors.length > 0) {
		return result([`Workflow '${workflow.name}' is not valid for team '${team.name}':`, ...validationErrors.map((error) => `- ${error}`)].join("\n"), { action: "run", status: "error" }, true);
	}

	const { manifest, tasks, paths } = createRunManifest({
		cwd: ctx.cwd,
		team,
		workflow,
		goal,
		workspaceMode: params.workspaceMode,
	});
	const goalArtifact = writeArtifact(paths.artifactsRoot, {
		kind: "prompt",
		relativePath: "goal.md",
		content: `${goal}\n`,
		producer: "team-tool",
	});
	const updatedManifest = { ...manifest, artifacts: [goalArtifact], summary: "Run manifest created; worker execution is not implemented yet." };
	atomicWriteJson(paths.manifestPath, updatedManifest);

	const loadedConfig = loadConfig(ctx.cwd);
	const runAsync = params.async ?? loadedConfig.config.asyncByDefault ?? false;
	if (runAsync) {
		const spawned = spawnBackgroundTeamRun(updatedManifest);
		const asyncManifest = { ...updatedManifest, async: { pid: spawned.pid, logPath: spawned.logPath, spawnedAt: new Date().toISOString() } };
		atomicWriteJson(paths.manifestPath, asyncManifest);
		appendEvent(updatedManifest.eventsPath, { type: "async.spawned", runId: updatedManifest.runId, data: { pid: spawned.pid, logPath: spawned.logPath } });
		const text = [
			`Started async pi-crew run ${updatedManifest.runId}.`,
			`Team: ${team.name}`,
			`Workflow: ${workflow.name}`,
			`Status: ${updatedManifest.status}`,
			`Tasks: ${tasks.length}`,
			`State: ${updatedManifest.stateRoot}`,
			`Artifacts: ${updatedManifest.artifactsRoot}`,
			`Background log: ${spawned.logPath}`,
			"",
			`Check status with: team status runId=${updatedManifest.runId}`,
		].join("\n");
		return result(text, { action: "run", status: "ok", runId: updatedManifest.runId, artifactsRoot: updatedManifest.artifactsRoot });
	}

	const runtime = await resolveCrewRuntime(loadedConfig.config);
	const executeWorkers = runtime.kind === "child-process";
	const executed = await executeTeamRun({ manifest: updatedManifest, tasks, team, workflow, agents, executeWorkers, limits: loadedConfig.config.limits, runtime, runtimeConfig: loadedConfig.config.runtime });
	const text = [
		`Created pi-crew run ${executed.manifest.runId}.`,
		`Team: ${team.name}`,
		`Workflow: ${workflow.name}`,
		`Status: ${executed.manifest.status}`,
		`Tasks: ${executed.tasks.length}`,
		`State: ${executed.manifest.stateRoot}`,
		`Artifacts: ${executed.manifest.artifactsRoot}`,
		"",
		`Runtime: ${runtime.kind}${runtime.fallback ? ` (fallback from ${runtime.requestedMode})` : ""}${runtime.reason ? ` - ${runtime.reason}` : ""}`,
		executeWorkers
			? "Child Pi worker execution was enabled."
			: "Safe scaffold mode: child Pi workers were not launched. Set PI_TEAMS_EXECUTE_WORKERS=1 or runtime.mode=child-process to enable real worker execution.",
	].join("\n");
	return result(text, { action: "run", status: executed.manifest.status === "failed" ? "error" : "ok", runId: executed.manifest.runId, artifactsRoot: executed.manifest.artifactsRoot }, executed.manifest.status === "failed");
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
		"Tasks:",
		...(tasks.length ? tasks.map((task) => `- ${task.id} [${task.status}] ${task.role} -> ${task.agent}${task.taskPacket ? ` scope=${task.taskPacket.scope}` : ""}${task.verification ? ` green=${task.verification.observedGreenLevel}/${task.verification.requiredGreenLevel}` : ""}${task.modelAttempts?.length ? ` attempts=${task.modelAttempts.length}` : ""}${task.jsonEvents !== undefined ? ` jsonEvents=${task.jsonEvents}` : ""}${task.usage ? ` usage=${JSON.stringify(task.usage)}` : ""}${task.worktree ? ` worktree=${task.worktree.path}` : ""}${task.error ? ` error=${task.error}` : ""}`) : ["- (none)"]),
		`Task counts: ${[...counts.entries()].map(([status, count]) => `${status}=${count}`).join(", ") || "none"}`,
		"Agents:",
		...(crewAgents.length ? crewAgents.map((agent) => `- ${agent.id} [${agent.status}] ${agent.role} -> ${agent.agent} runtime=${agent.runtime}${agent.progress?.activityState === "needs_attention" ? " needs_attention" : ""}${formatActivityAge(agent) ? ` activity=${formatActivityAge(agent)}` : ""}${agent.progress?.currentTool ? ` tool=${agent.progress.currentTool}` : ""}${agent.toolUses ? ` tools=${agent.toolUses}` : ""}${agent.progress?.tokens ? ` tokens=${agent.progress.tokens}` : ""}${agent.progress?.turns ? ` turns=${agent.progress.turns}` : ""}${agent.jsonEvents !== undefined ? ` jsonEvents=${agent.jsonEvents}` : ""}${agent.statusPath ? ` status=${agent.statusPath}` : ""}${agent.error ? ` error=${agent.error}` : ""}`) : ["- (none)"]),
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
		const updated = updateRunStatus(loaded.manifest, "cancelled", "Run cancelled by user request. Already-finished worker processes are not retroactively changed.");
		return result(`Cancelled run ${updated.runId}.`, { action: "cancel", status: "ok", runId: updated.runId, artifactsRoot: updated.artifactsRoot });
	});
}

export async function handleResume(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	if (!params.runId) return result("Resume requires runId.", { action: "resume", status: "error" }, true);
	const loaded = loadRunManifestById(ctx.cwd, params.runId);
	if (!loaded) return result(`Run '${params.runId}' not found.`, { action: "resume", status: "error" }, true);
	if (!loaded.manifest.workflow) return result(`Run '${params.runId}' has no workflow to resume.`, { action: "resume", status: "error" }, true);
	const team = allTeams(discoverTeams(ctx.cwd)).find((candidate) => candidate.name === loaded.manifest.team);
	if (!team) return result(`Team '${loaded.manifest.team}' not found.`, { action: "resume", status: "error" }, true);
	const workflow = allWorkflows(discoverWorkflows(ctx.cwd)).find((candidate) => candidate.name === loaded.manifest.workflow);
	if (!workflow) return result(`Workflow '${loaded.manifest.workflow}' not found.`, { action: "resume", status: "error" }, true);
	return await withRunLock(loaded.manifest, async () => {
		const resetTasks = loaded.tasks.map((task) => task.status === "failed" || task.status === "cancelled" || task.status === "skipped" || task.status === "running" ? { ...task, status: "queued" as const, error: undefined, startedAt: undefined, finishedAt: undefined, claim: undefined } : task);
		saveRunTasks(loaded.manifest, resetTasks);
		appendEvent(loaded.manifest.eventsPath, { type: "run.resume_requested", runId: loaded.manifest.runId });
		const loadedConfig = loadConfig(ctx.cwd);
		const runtime = await resolveCrewRuntime(loadedConfig.config);
		const executeWorkers = runtime.kind === "child-process";
		const executed = await executeTeamRun({ manifest: loaded.manifest, tasks: resetTasks, team, workflow, agents: allAgents(discoverAgents(ctx.cwd)), executeWorkers, limits: loadedConfig.config.limits, runtime, runtimeConfig: loadedConfig.config.runtime });
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

function configRecord(config: unknown): Record<string, unknown> {
	if (!config || typeof config !== "object" || Array.isArray(config)) return {};
	return config as Record<string, unknown>;
}

function autonomousPatchFromConfig(config: unknown): PiTeamsAutonomousConfig {
	const cfg = configRecord(config);
	const profile = cfg.profile === "manual" || cfg.profile === "suggested" || cfg.profile === "assisted" || cfg.profile === "aggressive" ? cfg.profile : undefined;
	const magicKeywords = cfg.magicKeywords && typeof cfg.magicKeywords === "object" && !Array.isArray(cfg.magicKeywords)
		? Object.fromEntries(Object.entries(cfg.magicKeywords as Record<string, unknown>).filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((item) => typeof item === "string")))
		: undefined;
	return {
		profile,
		enabled: typeof cfg.enabled === "boolean" ? cfg.enabled : undefined,
		injectPolicy: typeof cfg.injectPolicy === "boolean" ? cfg.injectPolicy : undefined,
		preferAsyncForLongTasks: typeof cfg.preferAsyncForLongTasks === "boolean" ? cfg.preferAsyncForLongTasks : undefined,
		allowWorktreeSuggestion: typeof cfg.allowWorktreeSuggestion === "boolean" ? cfg.allowWorktreeSuggestion : undefined,
		magicKeywords,
	};
}

function configPatchFromConfig(config: unknown): PiTeamsConfig {
	const cfg = configRecord(config);
	const control = configRecord(cfg.control);
	return {
		asyncByDefault: typeof cfg.asyncByDefault === "boolean" ? cfg.asyncByDefault : undefined,
		executeWorkers: typeof cfg.executeWorkers === "boolean" ? cfg.executeWorkers : undefined,
		notifierIntervalMs: typeof cfg.notifierIntervalMs === "number" && Number.isFinite(cfg.notifierIntervalMs) ? cfg.notifierIntervalMs : undefined,
		requireCleanWorktreeLeader: typeof cfg.requireCleanWorktreeLeader === "boolean" ? cfg.requireCleanWorktreeLeader : undefined,
		autonomous: typeof cfg.autonomous === "object" && cfg.autonomous !== null && !Array.isArray(cfg.autonomous) ? autonomousPatchFromConfig(cfg.autonomous) : undefined,
		control: Object.keys(control).length > 0 ? {
			enabled: typeof control.enabled === "boolean" ? control.enabled : undefined,
			needsAttentionAfterMs: typeof control.needsAttentionAfterMs === "number" && Number.isInteger(control.needsAttentionAfterMs) && control.needsAttentionAfterMs > 0 ? control.needsAttentionAfterMs : undefined,
		} : undefined,
	};
}

function formatAutonomyStatus(config: PiTeamsAutonomousConfig | undefined, pathValue: string, updated: boolean): string {
	const effective = effectiveAutonomousConfig(config);
	return [
		updated ? "Updated pi-crew autonomous mode." : "pi-crew autonomous mode:",
		`Path: ${pathValue}`,
		`Profile: ${effective.profile}`,
		`Enabled: ${effective.enabled}`,
		`Inject policy: ${effective.injectPolicy}`,
		`Prefer async for long tasks: ${effective.preferAsyncForLongTasks}`,
		`Allow worktree suggestion: ${effective.allowWorktreeSuggestion}`,
	].join("\n");
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
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) return result("API read-agent-events requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const sinceSeq = typeof cfg.sinceSeq === "number" ? cfg.sinceSeq : undefined;
		const limit = typeof cfg.limit === "number" ? cfg.limit : undefined;
		const payload = sinceSeq !== undefined || limit !== undefined
			? readCrewAgentEventsCursor(loaded.manifest, agent.taskId, { sinceSeq, limit })
			: { path: agentEventsPath(loaded.manifest, agent.taskId), events: readCrewAgentEvents(loaded.manifest, agent.taskId) };
		return result(JSON.stringify(payload, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-agent-transcript") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) return result("API read-agent-transcript requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const transcriptPath = agent.transcriptPath && fs.existsSync(agent.transcriptPath) ? agent.transcriptPath : agentOutputPath(loaded.manifest, agent.taskId);
		const text = fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath, "utf-8") : "";
		return result(text || `(no transcript at ${transcriptPath})`, { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "read-agent-output") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) return result("API read-agent-output requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const maxBytes = typeof cfg.maxBytes === "number" ? cfg.maxBytes : undefined;
		return result(JSON.stringify(readAgentOutput(loaded.manifest, agent.taskId, maxBytes), null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "agent-dashboard") {
		return result(buildAgentDashboard(loaded.manifest).text, { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "nudge-agent") {
		const agentId = typeof cfg.agentId === "string" ? cfg.agentId : undefined;
		const agent = readCrewAgents(loaded.manifest).find((item) => item.id === agentId || item.taskId === agentId);
		if (!agent) return result("API nudge-agent requires config.agentId matching an agent id or task id.", { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		const messageText = typeof cfg.message === "string" && cfg.message.trim() ? cfg.message.trim() : "Please report your current status, blocker, or smallest next step.";
		const message = appendMailboxMessage(loaded.manifest, { direction: "inbox", from: "leader", to: agent.taskId, taskId: agent.taskId, body: messageText });
		appendEvent(loaded.manifest.eventsPath, { type: "agent.nudged", runId: loaded.manifest.runId, taskId: agent.taskId, message: messageText, data: { agentId: agent.id, mailboxMessageId: message.id } });
		return result(JSON.stringify({ agentId: agent.id, mailboxMessage: message }, null, 2), { action: "api", status: "ok", runId: loaded.manifest.runId, artifactsRoot: loaded.manifest.artifactsRoot });
	}
	if (operation === "steer-agent" || operation === "stop-agent" || operation === "resume-agent" || operation === "interrupt-agent") {
		const runtime = await resolveCrewRuntime(loadConfig(ctx.cwd).config);
		if (!runtime.steer && operation === "steer-agent") return result(`Runtime '${runtime.kind}' does not support live steering. Use nudge-agent for mailbox-based child-process coordination.`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		if (!runtime.resume && operation === "resume-agent") return result(`Runtime '${runtime.kind}' does not support live resume.`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		if (operation === "interrupt-agent" && runtime.kind !== "live-session") return result(`Runtime '${runtime.kind}' does not expose per-agent interrupt yet. Use nudge-agent or cancel the run.`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
		return result(`Operation '${operation}' is reserved for live-session runtime and is not active for this run yet.`, { action: "api", status: "error", runId: loaded.manifest.runId }, true);
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
