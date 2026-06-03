import { allAgents, discoverAgents } from "../../agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../workflows/discover-workflows.ts";
import { loadConfig } from "../../config/config.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { writeArtifact } from "../../state/artifact-store.ts";
import { registerActiveRun, unregisterActiveRun } from "../../state/active-run-registry.ts";
import { createRunManifest, loadRunManifestById, updateRunStatus } from "../../state/state-store.ts";
import { atomicWriteJson } from "../../state/atomic-write.ts";
import { validateWorkflowForTeam } from "../../workflows/validate-workflow.ts";
import { PipelineRunner, type PipelineWorkflow } from "../../runtime/pipeline-runner.ts";
// Heavy runtime — lazy-loaded to avoid 1.4s import cost at extension registration.
import type { executeTeamRun as ExecuteTeamRunFn } from "../../runtime/team-runner.ts";
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- type-only import for TS inference
const _typeCheck: typeof ExecuteTeamRunFn = null as never as typeof ExecuteTeamRunFn;
import { logInternalError } from "../../utils/internal-error.ts";
let _cachedExecuteTeamRun: typeof ExecuteTeamRunFn | undefined;
async function executeTeamRun(...args: Parameters<typeof ExecuteTeamRunFn>): Promise<Awaited<ReturnType<typeof ExecuteTeamRunFn>>> {
	if (!_cachedExecuteTeamRun) {
		// LAZY: heavy runtime — defer 1.4s import cost until team run actually executes.
		const mod = await import("../../runtime/team-runner.ts");
		_cachedExecuteTeamRun = mod.executeTeamRun;
	}
	return _cachedExecuteTeamRun(...args);
}
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";
import { appendEventAsync, readEvents } from "../../state/event-log.ts";
import { resolveCrewRuntime, runtimeResolutionState } from "../../runtime/runtime-resolver.ts";
import { normalizeSkillOverride } from "../../runtime/skill-instructions.ts";
import { expandParallelResearchWorkflow } from "../../runtime/parallel-research.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../../runtime/process-status.ts";
import { waitForRun } from "../../runtime/run-tracker.ts";
import { hasAsyncStartMarker } from "../../runtime/async-marker.ts";
import { collectRunMetrics } from "../../state/run-metrics.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PiTeamsToolResult } from "../tool-result.ts";
import { buildParentContext, result, type TeamContext } from "./context.ts";
import { effectiveRunConfig } from "./config-patch.ts";

function tailFile(filePath: string, maxBytes = 4096): string | undefined {
	try {
		// Cap at 512KB to prevent OOM from misconfigured callers.
		const safeMaxBytes = Math.min(maxBytes, 512 * 1024);
		const stat = fs.statSync(filePath);
		const start = Math.max(0, stat.size - safeMaxBytes);
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
		void appendEventAsync(failed.eventsPath, { type: "async.failed", runId: failed.runId, message, data: { pid, detail: liveness.detail } });
	}, 3000);
	timer.unref();
}

export async function handleRun(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const goal = params.goal ?? params.task;
	if (!goal) return result("Run requires goal or task.", { action: "run", status: "error" }, true);
	const intentPrefix = goal.length > 60 ? `${goal.slice(0, 57)}...` : goal;

	// P0: Ensure .crew directory structure exists before creating any manifests.
	// Dynamic import to avoid module binding issues in child-process contexts.
	const workingDir = ctx.cwd ?? process.cwd();
	const { ensureCrewDirectory } = await import("../../state/crew-init.ts");
	await ensureCrewDirectory(workingDir);

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

	// Check if this is a pipeline workflow - special handling for multi-stage execution
	const isPipelineWorkflow = workflowName === "pipeline" && !directAgent;
	if (isPipelineWorkflow) {
		// For pipeline workflows, use PipelineRunner for execution
		const pipelineRunner = new PipelineRunner();
		const pipelineWorkflow: PipelineWorkflow = {
			name: workflow.name,
			description: workflow.description,
			goal,
			stages: workflow.steps.map((step) => ({
				name: step.id,
				team: step.role,
				inputs: step.task,
				usePreviousResults: step.dependsOn && step.dependsOn.length > 0,
			})),
			stopOnError: true,
			defaultMaxConcurrency: workflow.maxConcurrency ?? 5,
		};

		// For now, show pipeline workflow info - full integration would require
		// connecting PipelineRunner to the actual team execution system
		const stageInfo = pipelineWorkflow.stages.map((s) => `- ${s.name} (${s.team})`).join("\n");
		return result([
			`Pipeline workflow: ${workflow.name}`,
			`Goal: ${goal}`,
			`Stages (${pipelineWorkflow.stages.length}):`,
			stageInfo,
			"",
			"Pipeline execution is available via the PipelineRunner API.",
			"Full CLI integration requires connecting to the team execution system.",
		].join("\n"), { action: "run", status: "ok" }, false);
	}

	const validationErrors = validateWorkflowForTeam(workflow, team);
	if (validationErrors.length > 0) {
		return result([`Workflow '${workflow.name}' is not valid for team '${team.name}':`, ...validationErrors.map((error) => `- ${error}`)].join("\n"), { action: "run", status: "error" }, true);
	}

	const skillOverride = normalizeSkillOverride(params.skill);
	const { manifest, tasks, paths } = createRunManifest({
		cwd: ctx.cwd,
		team,
		workflow,
		goal,
		workspaceMode: params.workspaceMode,
		ownerSessionId: ctx.sessionId,
	});
	const goalArtifact = writeArtifact(paths.artifactsRoot, {
		kind: "prompt",
		relativePath: "goal.md",
		content: `${goal}\n`,
		producer: "team-tool",
	});
	const updatedManifest = { ...manifest, ...(skillOverride !== undefined ? { skillOverride } : {}), artifacts: [goalArtifact], summary: "Run manifest created; worker execution is not implemented yet." };
	atomicWriteJson(paths.manifestPath, updatedManifest);
	registerActiveRun(updatedManifest);

	const loadedConfig = loadConfig(ctx.cwd);
	const executedConfig = effectiveRunConfig(loadedConfig.config, params.config);
	const runtime = await resolveCrewRuntime(executedConfig);
	const runtimeResolution = runtimeResolutionState(runtime);
	const executionManifest = { ...updatedManifest, runtimeResolution, runConfig: executedConfig, updatedAt: new Date().toISOString() };
	atomicWriteJson(paths.manifestPath, executionManifest);
	appendEventAsync(executionManifest.eventsPath, { type: "runtime.resolved", runId: executionManifest.runId, message: `Runtime resolved: ${runtime.kind} safety=${runtime.safety}`, data: { runtimeResolution } }).catch((error) => logInternalError("team-tool.run.resolved", error, `runId=${executionManifest.runId}`));
	const runAsync = params.async ?? executedConfig.asyncByDefault ?? false;
	let effectiveRuntime = runtime;
	if (runAsync && runtime.kind === "live-session") {
		effectiveRuntime = { ...runtime, kind: "child-process", steer: true, resume: false, liveToolActivity: false, fallback: "child-process", reason: "Background runner cannot use live-session; falling back to child-process." };
	}
	const effectiveRuntimeResolution = effectiveRuntime !== runtime ? runtimeResolutionState(effectiveRuntime) : runtimeResolution;
	const effectiveManifest = effectiveRuntime !== runtime ? { ...executionManifest, runtimeResolution: effectiveRuntimeResolution, updatedAt: new Date().toISOString() } : executionManifest;
	if (effectiveRuntime !== runtime) {
		atomicWriteJson(paths.manifestPath, effectiveManifest);
		appendEventAsync(effectiveManifest.eventsPath, { type: "runtime.resolved", runId: effectiveManifest.runId, message: `Runtime overridden: child-process (async fallback from live-session)`, data: { runtimeResolution: effectiveRuntimeResolution } }).catch((error) => logInternalError("team-tool.run.override", error, `runId=${effectiveManifest.runId}`));
	}
	if (runAsync) {
		if (effectiveRuntime.safety === "blocked") {
			const runningManifest = updateRunStatus(effectiveManifest, "running", "Checking worker runtime availability.");
			const blocked = updateRunStatus(runningManifest, "blocked", effectiveRuntime.reason ?? "Child worker execution is disabled; refusing to create no-op scaffold subagents.");
			void appendEventAsync(blocked.eventsPath, { type: "run.blocked", runId: blocked.runId, message: blocked.summary, data: { runtime: effectiveRuntime, runtimeResolution: effectiveRuntimeResolution, async: true, diagnostics: { requestedMode: effectiveRuntime.requestedMode, workersDisabled: executedConfig.executeWorkers === false, envCrew: process.env.PI_CREW_EXECUTE_WORKERS, envTeams: process.env.PI_TEAMS_EXECUTE_WORKERS } } });
			unregisterActiveRun(blocked.runId);
			return result([
				`Blocked pi-crew run ${blocked.runId}: real subagent workers are disabled.`,
				`Runtime: ${effectiveRuntime.kind} (requested ${effectiveRuntime.requestedMode})`,
				`Reason: ${effectiveRuntime.reason ?? "unknown"}`,
				`Config: executeWorkers=${executedConfig.executeWorkers ?? "<default>"}, runtime.mode=${executedConfig.runtime?.mode ?? "<default>"}`,
				`Env: PI_CREW_EXECUTE_WORKERS=${process.env.PI_CREW_EXECUTE_WORKERS ?? "<unset>"}, PI_TEAMS_EXECUTE_WORKERS=${process.env.PI_TEAMS_EXECUTE_WORKERS ?? "<unset>"}`,
			].join("\n"), { action: "run", status: "error", runId: blocked.runId, artifactsRoot: blocked.artifactsRoot }, true);
		}
		const spawned = await spawnBackgroundTeamRun(effectiveManifest);
		const asyncManifest = { ...effectiveManifest, async: { pid: spawned.pid, logPath: spawned.logPath, spawnedAt: new Date().toISOString() } };
		atomicWriteJson(paths.manifestPath, asyncManifest);
		void appendEventAsync(effectiveManifest.eventsPath, { type: "async.spawned", runId: effectiveManifest.runId, data: { pid: spawned.pid, logPath: spawned.logPath } });
		scheduleBackgroundEarlyExitGuard(ctx.cwd, effectiveManifest.runId, spawned.pid, spawned.logPath);
		// Wait for the async run to complete and return actual results.
		try {
			const completed = await waitForRun(updatedManifest.runId, ctx.cwd, { timeoutMs: 3600000 });
			const metrics = collectRunMetrics(ctx.cwd, completed.manifest.runId);
			const lines: string[] = [
				`pi-crew run ${completed.manifest.status}: ${completed.manifest.runId} (${team.name})`,
				`Goal: ${goal.slice(0, 100)}`,
			];
			if (metrics) {
				lines.push("");
				lines.push(`Metrics: ${metrics.completedCount}/${metrics.taskCount} tasks, ${metrics.totalTokens} tokens, ${metrics.durationMs}ms, consistency=${metrics.consistencyScore}`);
			}

			if (completed.tasks.length > 0) {
				// Read run-level summary artifact if present
				let summaryContent: string | undefined;
				const summaryArtifact = completed.manifest.artifacts?.find(
					(a: { kind?: string }) => a.kind === "summary",
				);
				if (summaryArtifact) {
					try {
						const sumPath = path.join(completed.manifest.artifactsRoot, summaryArtifact.path);
						summaryContent = fs.readFileSync(sumPath, "utf-8").trim().slice(0, 4000);
					} catch {
						/* summary unavailable */
					}
				}

				const taskLines: string[] = [];
				let failedCount = 0;
				const failedIds: string[] = [];
				for (const task of completed.tasks) {
					let resultExcerpt = "";
					if (task.resultArtifact?.path) {
						try {
							const resPath = path.isAbsolute(task.resultArtifact.path)
							? task.resultArtifact.path
							: path.join(completed.manifest.artifactsRoot, task.resultArtifact.path);
							resultExcerpt = fs.readFileSync(resPath, "utf-8").trim().slice(0, 2000);
						} catch {
							resultExcerpt = "(result unavailable)";
						}
					}
					const shortResult = resultExcerpt.slice(0, 500);
					const statusTag =
						task.status === "completed" ? "✓"
						: task.status === "failed" ? "✗"
						: task.status === "cancelled" ? "⊘"
						: "·";
					taskLines.push(
						`- ${statusTag} ${task.id} [${task.role}]: ${task.status}${shortResult ? " — " + shortResult : ""}${task.error ? ` | Error: ${task.error.slice(0, 200)}` : ""}`,
					);
					if (task.status === "failed" || task.status === "needs_attention") {
						failedCount++;
						failedIds.push(task.id);
					}
				}

				lines.push("");
				lines.push(`Tasks (${completed.tasks.length}):`);
				lines.push(...taskLines);

				if (summaryContent) {
					lines.push("");
					lines.push("Summary:");
					lines.push(summaryContent.slice(0, 2000));
				}

				if (failedCount === 0) {
					lines.push("");
					lines.push("All tasks completed successfully.");
				} else {
					lines.push("");
					lines.push(
						`${failedCount} task(s) failed: ${failedIds.join(", ")}. Consider retrying.`,
					);
				}
			} else {
				lines.push(
					completed.manifest.status === "completed"
						? "Run completed with no task results."
						: `The run ended with status: ${completed.manifest.status}. Check the run artifacts for details.`,
				);
			}

			const runFailed = completed.manifest.status === "failed" || completed.manifest.status === "blocked";
			return result(lines.join("\n"), { action: "run", status: runFailed ? "error" : "ok", runId: completed.manifest.runId, artifactsRoot: completed.manifest.artifactsRoot }, runFailed);
		} catch (waitError: unknown) {
			const errorMessage = waitError instanceof Error ? waitError.message : String(waitError);
			return result(
				[
					`pi-crew run timed out or failed: ${updatedManifest.runId}`,
					`Team: ${team.name}`,
					`Workflow: ${workflow.name}`,
					`Error: ${errorMessage}`,
					"",
					`Check status with: team status runId=${updatedManifest.runId}`,
					`State: ${updatedManifest.stateRoot}`,
					`Background log: ${spawned.logPath}`,
				].join("\n"),
				{ action: "run", status: "error", runId: updatedManifest.runId, artifactsRoot: updatedManifest.artifactsRoot },
				true,
			);
		}
	}

	if (runtime.safety === "blocked") {
		const runningManifest = updateRunStatus(executionManifest, "running", "Checking worker runtime availability.");
		const blocked = updateRunStatus(runningManifest, "blocked", runtime.reason ?? "Child worker execution is disabled; refusing to create no-op scaffold subagents.");
		void appendEventAsync(blocked.eventsPath, { type: "run.blocked", runId: blocked.runId, message: blocked.summary, data: { runtime, runtimeResolution, diagnostics: { requestedMode: runtime.requestedMode, workersDisabled: executedConfig.executeWorkers === false, envCrew: process.env.PI_CREW_EXECUTE_WORKERS, envTeams: process.env.PI_TEAMS_EXECUTE_WORKERS } } });
		unregisterActiveRun(blocked.runId);
		return result([
			`Blocked pi-crew run ${blocked.runId}: real subagent workers are disabled.`,
			`Runtime: ${runtime.kind} (requested ${runtime.requestedMode})`,
			`Reason: ${runtime.reason ?? "unknown"}`,
			`Config: executeWorkers=${executedConfig.executeWorkers ?? "<default>"}, runtime.mode=${executedConfig.runtime?.mode ?? "<default>"}`,
			`Env: PI_CREW_EXECUTE_WORKERS=${process.env.PI_CREW_EXECUTE_WORKERS ?? "<unset>"}, PI_TEAMS_EXECUTE_WORKERS=${process.env.PI_TEAMS_EXECUTE_WORKERS ?? "<unset>"}`,
			"",
			"To run effective subagents, remove executeWorkers=false / PI_CREW_EXECUTE_WORKERS=0 / PI_TEAMS_EXECUTE_WORKERS=0 or set runtime.mode=child-process.",
			"Use runtime.mode=scaffold only for explicit dry-run prompt/artifact generation.",
		].join("\n"), { action: "run", status: "error", runId: blocked.runId, artifactsRoot: blocked.artifactsRoot }, true);
	}
	const executeWorkers = runtime.kind !== "scaffold";
	if (executeWorkers && ctx.startForegroundRun) {
		ctx.onRunStarted?.(updatedManifest.runId);
		ctx.startForegroundRun(async (signal) => {
			try {
				await executeTeamRun({ manifest: executionManifest, tasks, team, workflow, agents, executeWorkers, limits: executedConfig.limits, runtime, runtimeConfig: executedConfig.runtime, parentContext: buildParentContext(ctx), parentModel: ctx.model, modelRegistry: ctx.modelRegistry, modelOverride: params.model, skillOverride, signal, reliability: executedConfig.reliability, metricRegistry: ctx.metricRegistry, onJsonEvent: ctx.onJsonEvent, workspaceId: ctx.sessionId ?? ctx.cwd });
			} finally {
				unregisterActiveRun(updatedManifest.runId);
			}
		}, updatedManifest.runId);

		// Wait for the foreground run to complete and return actual results.
		try {
			const completed = await waitForRun(updatedManifest.runId, ctx.cwd, { timeoutMs: 3600000 });
			const metrics = collectRunMetrics(ctx.cwd, completed.manifest.runId);
			const lines: string[] = [
				`pi-crew run ${completed.manifest.status}: ${completed.manifest.runId} (${team.name})`,
				`Goal: ${goal.slice(0, 100)}`,
			];
			if (metrics) {
				lines.push("");
				lines.push(`Metrics: ${metrics.completedCount}/${metrics.taskCount} tasks, ${metrics.totalTokens} tokens, ${metrics.durationMs}ms, consistency=${metrics.consistencyScore}`);
			}

			if (completed.tasks.length > 0) {
				// Read run-level summary artifact if present
				let summaryContent: string | undefined;
				const summaryArtifact = completed.manifest.artifacts?.find(
					(a: { kind?: string }) => a.kind === "summary",
				);
				if (summaryArtifact) {
					try {
						const sumPath = path.join(completed.manifest.artifactsRoot, summaryArtifact.path);
						summaryContent = fs.readFileSync(sumPath, "utf-8").trim().slice(0, 4000);
					} catch {
						/* summary unavailable */
					}
				}

				const taskLines: string[] = [];
				let failedCount = 0;
				const failedIds: string[] = [];
				for (const task of completed.tasks) {
					let resultExcerpt = "";
					if (task.resultArtifact?.path) {
						try {
							const resPath = path.isAbsolute(task.resultArtifact.path)
							? task.resultArtifact.path
							: path.join(completed.manifest.artifactsRoot, task.resultArtifact.path);
							resultExcerpt = fs.readFileSync(resPath, "utf-8").trim().slice(0, 2000);
						} catch {
							resultExcerpt = "(result unavailable)";
						}
					}
					const shortResult = resultExcerpt.slice(0, 500);
					const statusTag =
						task.status === "completed" ? "✓"
						: task.status === "failed" ? "✗"
						: task.status === "cancelled" ? "⊘"
						: "·";
					taskLines.push(
						`- ${statusTag} ${task.id} [${task.role}]: ${task.status}${shortResult ? " — " + shortResult : ""}${task.error ? ` | Error: ${task.error.slice(0, 200)}` : ""}`,
					);
					if (task.status === "failed" || task.status === "needs_attention") {
						failedCount++;
						failedIds.push(task.id);
					}
				}

				lines.push("");
				lines.push(`Tasks (${completed.tasks.length}):`);
				lines.push(...taskLines);

				if (summaryContent) {
					lines.push("");
					lines.push("Summary:");
					lines.push(summaryContent.slice(0, 2000));
				}

				if (failedCount === 0) {
					lines.push("");
					lines.push("All tasks completed successfully.");
				} else {
					lines.push("");
					lines.push(
						`${failedCount} task(s) failed: ${failedIds.join(", ")}. Consider retrying.`,
					);
				}
			} else {
				lines.push(
					completed.manifest.status === "completed"
						? "Run completed with no task results."
						: `The run ended with status: ${completed.manifest.status}. Check the run artifacts for details.`,
				);
			}

			const runFailed = completed.manifest.status === "failed" || completed.manifest.status === "blocked";
			return result(lines.join("\n"), { action: "run", status: runFailed ? "error" : "ok", runId: completed.manifest.runId, artifactsRoot: completed.manifest.artifactsRoot }, runFailed);
		} catch (waitError: unknown) {
			const errorMessage = waitError instanceof Error ? waitError.message : String(waitError);
			return result(
				[
					`pi-crew run timed out or failed: ${updatedManifest.runId}`,
					`Team: ${team.name}`,
					`Workflow: ${workflow.name}`,
					`Error: ${errorMessage}`,
					"",
					`Check status with: team status runId=${updatedManifest.runId}`,
					`State: ${updatedManifest.stateRoot}`,
				].join("\n"),
				{ action: "run", status: "error", runId: updatedManifest.runId, artifactsRoot: updatedManifest.artifactsRoot },
				true,
			);
		}
	}
	let executed: Awaited<ReturnType<typeof executeTeamRun>>;
	try {
		executed = await executeTeamRun({ manifest: executionManifest, tasks, team, workflow, agents, executeWorkers, limits: executedConfig.limits, runtime, runtimeConfig: executedConfig.runtime, parentContext: buildParentContext(ctx), parentModel: ctx.model, modelRegistry: ctx.modelRegistry, modelOverride: params.model, skillOverride, signal: ctx.signal, reliability: executedConfig.reliability, metricRegistry: ctx.metricRegistry, onJsonEvent: ctx.onJsonEvent, workspaceId: ctx.cwd });
	} finally {
		unregisterActiveRun(updatedManifest.runId);
	}
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
