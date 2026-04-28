import { allAgents, discoverAgents } from "../../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import { loadConfig } from "../../config/config.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { writeArtifact } from "../../state/artifact-store.ts";
import { createRunManifest, loadRunManifestById, updateRunStatus } from "../../state/state-store.ts";
import { atomicWriteJson } from "../../state/atomic-write.ts";
import { validateWorkflowForTeam } from "../../workflows/validate-workflow.ts";
import { executeTeamRun } from "../../runtime/team-runner.ts";
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";
import { appendEvent, readEvents } from "../../state/event-log.ts";
import { resolveCrewRuntime } from "../../runtime/runtime-resolver.ts";
import { expandParallelResearchWorkflow } from "../../runtime/parallel-research.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../../runtime/process-status.ts";
import { hasAsyncStartMarker } from "../../runtime/async-marker.ts";
import * as fs from "node:fs";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { buildParentContext, result, type TeamContext } from "./context.ts";
import { effectiveRunConfig } from "./config-patch.ts";

function tailFile(filePath: string, maxBytes = 4096): string | undefined {
	try {
		const stat = fs.statSync(filePath);
		const start = Math.max(0, stat.size - maxBytes);
		const fd = fs.openSync(filePath, "r");
		try {
			const buffer = Buffer.alloc(stat.size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			return buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function scheduleBackgroundEarlyExitGuard(cwd: string, runId: string, pid: number | undefined, logPath: string): void {
	if (process.env.PI_CREW_ASYNC_EARLY_EXIT_GUARD === "0") return;
	const timer = setTimeout(() => {
		const loaded = loadRunManifestById(cwd, runId);
		if (!loaded || !isActiveRunStatus(loaded.manifest.status)) return;
		if (hasAsyncStartMarker(loaded.manifest)) return;
		if (readEvents(loaded.manifest.eventsPath).some((event) => event.type === "async.started" || event.type === "async.completed" || event.type === "async.failed")) return;
		const liveness = checkProcessLiveness(pid);
		if (liveness.alive) return;
		const tail = tailFile(logPath);
		const message = `Background runner exited within 3s; see background.log${tail ? `\n${tail}` : ""}`;
		const failed = updateRunStatus(loaded.manifest, "failed", "Background runner exited within 3s; see background.log");
		appendEvent(failed.eventsPath, { type: "async.failed", runId: failed.runId, message, data: { pid, detail: liveness.detail } });
	}, 3000);
	timer.unref?.();
}

export async function handleRun(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const goal = params.goal ?? params.task;
	if (!goal) return result("Run requires goal or task.", { action: "run", status: "error" }, true);

	const teams = allTeams(discoverTeams(ctx.cwd));
	const workflows = allWorkflows(discoverWorkflows(ctx.cwd));
	const agents = allAgents(discoverAgents(ctx.cwd));
	const directAgent = params.agent ? agents.find((item) => item.name === params.agent) : undefined;
	if (params.agent && !directAgent) return result(`Agent '${params.agent}' not found.`, { action: "run", status: "error" }, true);
	const teamName = params.team ?? "default";
	const team = directAgent ? {
		name: `direct-${directAgent.name}`,
		description: `Direct subagent run for ${directAgent.name}`,
		source: "builtin" as const,
		filePath: "<generated>",
		roles: [{ name: params.role ?? "agent", agent: directAgent.name, description: directAgent.description }],
		defaultWorkflow: "direct-agent",
		workspaceMode: params.workspaceMode,
	} : teams.find((item) => item.name === teamName);
	if (!team) return result(`Team '${teamName}' not found.`, { action: "run", status: "error" }, true);
	const workflowName = directAgent ? "direct-agent" : params.workflow ?? team.defaultWorkflow ?? "default";
	const baseWorkflow = directAgent ? {
		name: "direct-agent",
		description: `Direct task for ${directAgent.name}`,
		source: "builtin" as const,
		filePath: "<generated>",
		steps: [{ id: "01_agent", role: params.role ?? "agent", task: "{goal}", model: params.model }],
	} : workflows.find((item) => item.name === workflowName);
	if (!baseWorkflow) return result(`Workflow '${workflowName}' not found.`, { action: "run", status: "error" }, true);
	const workflow = directAgent ? baseWorkflow : expandParallelResearchWorkflow(baseWorkflow, ctx.cwd);

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
		scheduleBackgroundEarlyExitGuard(ctx.cwd, updatedManifest.runId, spawned.pid, spawned.logPath);
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

	const runtime = await resolveCrewRuntime(effectiveRunConfig(loadedConfig.config, params.config));
	const executeWorkers = runtime.kind !== "scaffold";
	const executedConfig = effectiveRunConfig(loadedConfig.config, params.config);
	if (executeWorkers && ctx.startForegroundRun) {
		ctx.onRunStarted?.(updatedManifest.runId);
		ctx.startForegroundRun(async (signal) => {
			await executeTeamRun({ manifest: updatedManifest, tasks, team, workflow, agents, executeWorkers, limits: executedConfig.limits, runtime, runtimeConfig: executedConfig.runtime, parentContext: buildParentContext(ctx), parentModel: ctx.model, modelRegistry: ctx.modelRegistry, modelOverride: params.model, signal });
		}, updatedManifest.runId);
		const text = [
			`Started foreground pi-crew run ${updatedManifest.runId}.`,
			`Team: ${team.name}`,
			`Workflow: ${workflow.name}`,
			"Status: running",
			`Tasks: ${tasks.length}`,
			`Runtime: ${runtime.kind}`,
			`State: ${updatedManifest.stateRoot}`,
			`Artifacts: ${updatedManifest.artifactsRoot}`,
			"",
			"The run continues in this Pi session without blocking the chat. It will be interrupted on session shutdown. Use /team-dashboard or /team-status to watch it.",
		].join("\n");
		return result(text, { action: "run", status: "ok", runId: updatedManifest.runId, artifactsRoot: updatedManifest.artifactsRoot });
	}
	const executed = await executeTeamRun({ manifest: updatedManifest, tasks, team, workflow, agents, executeWorkers, limits: executedConfig.limits, runtime, runtimeConfig: executedConfig.runtime, parentContext: buildParentContext(ctx), parentModel: ctx.model, modelRegistry: ctx.modelRegistry, modelOverride: params.model, signal: ctx.signal });
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
		runtime.kind === "child-process"
			? "Child Pi worker execution is enabled by default; each task is launched as a separate Pi process. Set runtime.mode=scaffold or executeWorkers=false only for dry runs."
			: runtime.kind === "live-session"
				? "Experimental live-session worker execution was enabled."
				: "Safe scaffold mode: child Pi workers were not launched because runtime.mode=scaffold or executeWorkers=false was configured.",
	].join("\n");
	return result(text, { action: "run", status: executed.manifest.status === "failed" ? "error" : "ok", runId: executed.manifest.runId, artifactsRoot: executed.manifest.artifactsRoot }, executed.manifest.status === "failed");
}
