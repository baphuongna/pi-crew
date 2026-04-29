import * as fs from "node:fs";
import * as path from "node:path";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { loadConfig, updateAutonomousConfig, updateConfig } from "../config/config.ts";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { loadRunManifestById, saveRunManifest, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import { withRunLock, withRunLockSync } from "../state/locks.ts";
import { aggregateUsage, formatUsage } from "../state/usage.ts";
import { appendEvent, readEvents } from "../state/event-log.ts";
import { writeArtifact } from "../state/artifact-store.ts";
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
import { parsePiJsonOutput } from "../runtime/pi-json-output.ts";
import { buildParentContext, configRecord, formatScoped, result, type TeamContext } from "./team-tool/context.ts";
import { autonomousPatchFromConfig, configPatchFromConfig, formatAutonomyStatus } from "./team-tool/config-patch.ts";
import { handleApi } from "./team-tool/api.ts";
import { handleRun } from "./team-tool/run.ts";
import { handleDoctor } from "./team-tool/doctor.ts";
import { handleStatus } from "./team-tool/status.ts";
import { handleArtifacts, handleEvents, handleSummary } from "./team-tool/inspect.ts";
import { handleCleanup, handleExport, handleForget, handleImport, handleImports, handlePrune, handleWorktrees } from "./team-tool/lifecycle-actions.ts";
import { handleCancel } from "./team-tool/cancel.ts";
import { handlePlan } from "./team-tool/plan.ts";
import { logInternalError } from "../utils/internal-error.ts";

export type { TeamToolDetails } from "./team-tool-types.ts";
export type { TeamContext } from "./team-tool/context.ts";
export { handleRun } from "./team-tool/run.ts";
export { handleDoctor } from "./team-tool/doctor.ts";
export { handleStatus } from "./team-tool/status.ts";
export { handleArtifacts, handleEvents, handleSummary } from "./team-tool/inspect.ts";
export { handleCleanup, handleExport, handleForget, handleImport, handleImports, handlePrune, handleWorktrees } from "./team-tool/lifecycle-actions.ts";
export { handleCancel } from "./team-tool/cancel.ts";
export { handlePlan } from "./team-tool/plan.ts";
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

function artifactKey(artifact: ArtifactDescriptor): string {
	return `${artifact.kind}:${artifact.path}`;
}

function recoverCheckpointedTasks(manifest: TeamRunManifest, tasks: TeamTaskState[]): { manifest: TeamRunManifest; tasks: TeamTaskState[]; recovered: string[] } {
	const recovered: string[] = [];
	let nextManifest = manifest;
	let nextTasks = tasks.map((task) => {
		if (task.status !== "running" || !task.checkpoint) return task;
		if (task.checkpoint.phase === "artifact-written" && task.resultArtifact) {
			recovered.push(task.id);
			return { ...task, status: "completed" as const, finishedAt: task.finishedAt ?? task.checkpoint.updatedAt, error: undefined, claim: undefined };
		}
		if (task.checkpoint.phase === "child-stdout-final") {
			const transcriptPath = path.join(manifest.artifactsRoot, "transcripts", `${task.id}.jsonl`);
			if (!fs.existsSync(transcriptPath)) return task;
			const transcript = fs.readFileSync(transcriptPath, "utf-8");
			const parsed = parsePiJsonOutput(transcript);
			if (!parsed.finalText && !parsed.usage) return task;
			const resultArtifact = writeArtifact(manifest.artifactsRoot, { kind: "result", relativePath: `results/${task.id}.txt`, content: parsed.finalText ?? "(recovered from completed child transcript)", producer: task.id });
			const transcriptArtifact = writeArtifact(manifest.artifactsRoot, { kind: "log", relativePath: `transcripts/${task.id}.jsonl`, content: transcript, producer: task.id });
			recovered.push(task.id);
			return { ...task, status: "completed" as const, finishedAt: task.finishedAt ?? task.checkpoint.updatedAt, error: undefined, claim: undefined, resultArtifact, transcriptArtifact, usage: parsed.usage, jsonEvents: parsed.jsonEvents };
		}
		return task;
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
		const executed = await executeTeamRun({ manifest: resumeManifest, tasks: resetTasks, team, workflow, agents, executeWorkers, limits: loadedConfig.config.limits, runtime, runtimeConfig: loadedConfig.config.runtime, parentContext: buildParentContext(ctx), parentModel: ctx.model, modelRegistry: ctx.modelRegistry, modelOverride: params.model, signal: ctx.signal, reliability: loadedConfig.config.reliability, metricRegistry: ctx.metricRegistry });
		return result([`Resumed run ${executed.manifest.runId}.`, `Status: ${executed.manifest.status}`, `Tasks: ${executed.tasks.length}`, `Artifacts: ${executed.manifest.artifactsRoot}`].join("\n"), { action: "resume", status: executed.manifest.status === "failed" ? "error" : "ok", runId: executed.manifest.runId, artifactsRoot: executed.manifest.artifactsRoot }, executed.manifest.status === "failed");
	});
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
