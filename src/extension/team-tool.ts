import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import {
	allAgents,
	discoverAgents,
	listDynamicAgents,
	registerDynamicAgent,
	unregisterDynamicAgent,
} from "../agents/discover-agents.ts";
import {
	loadConfig,
	updateAutonomousConfig,
	updateConfig,
} from "../config/config.ts";
// Heavy runtime — lazy-loaded to avoid 1.4s import cost at extension registration.
// executeTeamRun is only called when a team run actually executes.
import type { executeTeamRun as _executeTeamRunFn } from "../runtime/team-runner.ts";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { withRunLock } from "../state/locks.ts";
import { replayPendingMailboxMessages } from "../state/mailbox.ts";
import {
	loadRunManifestById,
	saveRunManifest,
	saveRunTasks,
	updateRunStatus,
} from "../state/state-store.ts";
import type {
	ArtifactDescriptor,
	TeamRunManifest,
	TeamTaskState,
} from "../state/types.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import {
	allWorkflows,
	discoverWorkflows,
} from "../workflows/discover-workflows.ts";
import { piTeamsHelp } from "./help.ts";
import { handleCreate, handleDelete, handleUpdate } from "./management.ts";
import { initializeProject } from "./project-init.ts";
import { listRuns } from "./run-index.ts";
import { formatRecommendation, recommendTeam } from "./team-recommendation.ts";
import { handleSettings } from "./team-tool/handle-settings.ts";
import type { PiTeamsToolResult } from "./tool-result.ts";
import {
	formatValidationReport,
	validateResources,
} from "./validate-resources.ts";

type ExecuteTeamRunFn = typeof _executeTeamRunFn;
let _cachedExecuteTeamRun: ExecuteTeamRunFn | undefined;
async function executeTeamRun(
	...args: Parameters<ExecuteTeamRunFn>
): Promise<Awaited<ReturnType<ExecuteTeamRunFn>>> {
	if (_cachedExecuteTeamRun === undefined) {
		// LAZY: heavy runtime — defer 1.4s import cost until team run actually executes.
		const mod = await import("../runtime/team-runner.ts");
		_cachedExecuteTeamRun = mod.executeTeamRun;
	}
	return _cachedExecuteTeamRun(...args);
}

import { directTeamAndWorkflowFromRun } from "../runtime/direct-run.ts";
import { parsePiJsonOutput } from "../runtime/pi-json-output.ts";
import {
	resolveCrewRuntime,
	runtimeResolutionState,
} from "../runtime/runtime-resolver.ts";
import { handleApi } from "./team-tool/api.ts";
import {
	autonomousPatchFromConfig,
	configPatchFromConfig,
	effectiveRunConfig,
	formatAutonomyStatus,
} from "./team-tool/config-patch.ts";
import {
	buildParentContext,
	configRecord,
	formatScoped,
	result,
	type TeamContext,
} from "./team-tool/context.ts";
// Lazy-loaded: run.ts pulls in spawnBackgroundTeamRun, resolveCrewRuntime, etc.
// Static import fails silently in some jiti contexts (child-process), leaving handleRun undefined.
import type { handleRun as _handleRunFn } from "./team-tool/run.ts";

type HandleRunFn = typeof _handleRunFn;
let _cachedHandleRun: HandleRunFn | undefined;
async function handleRun(
	...args: Parameters<HandleRunFn>
): Promise<Awaited<ReturnType<HandleRunFn>>> {
	if (_cachedHandleRun === undefined) {
		// LAZY: run.ts pulls in spawnBackgroundTeamRun + resolveCrewRuntime; also avoids jiti import race in child-process contexts.
		const mod = await import("./team-tool/run.ts");
		_cachedHandleRun = mod.handleRun;
	}
	return _cachedHandleRun(...args);
}

import { waitForRun } from "../runtime/run-tracker.ts";
import { normalizeSkillOverride } from "../runtime/skill-instructions.ts";
import { searchAgents, searchTeams } from "../utils/bm25-search.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import {
	type CacheControlDeps,
	invalidateSnapshot,
} from "./team-tool/cache-control.ts";
import { handleCancel, handleRetry } from "./team-tool/cancel.ts";
import { handleDoctor } from "./team-tool/doctor.ts";
import { handleExplain } from "./team-tool/explain.ts";
import { handleHealthMonitor } from "./team-tool/health-monitor.ts";
import {
	handleArtifacts,
	handleEvents,
	handleSummary,
} from "./team-tool/inspect.ts";
import {
	handleCleanup,
	handleExport,
	handleForget,
	handleImport,
	handleImports,
	handlePrune,
	handleWorktrees,
} from "./team-tool/lifecycle-actions.ts";
import {
	getCachedRun,
	computeRunCacheKey,
	getCacheStats,
} from "../state/run-cache.ts";
import {
	loadRunGraph,
	listRunGraphs,
} from "../state/run-graph.ts";
import { FileCheckpointStore } from "../runtime/checkpoint.ts";
import { buildTeamOnboarding } from "./team-onboard.ts";
import { handleParallel } from "./team-tool/parallel-dispatch.ts";
import { handleSchedule, handleListScheduled } from "./team-tool/handle-schedule.ts";
import { handlePlan } from "./team-tool/plan.ts";
import { handleOrchestrate } from "./team-tool/orchestrate.ts";
import { handleRespond } from "./team-tool/respond.ts";
import { handleStatus } from "./team-tool/status.ts";
import { handleAnchorSet, handleAnchorClear, handleAnchorStatus, handleAnchorAccumulate } from "./team-tool/anchor.ts";
import { handleAutoSummarizeOn, handleAutoSummarizeOff, handleAutoSummarizeStatus, handleAutoSummarizeConfig, createAutoSummarizeService } from "./team-tool/auto-summarize.ts";

export { handleApi } from "./team-tool/api.ts";
export { handleRetry } from "./team-tool/cancel.ts";
export type { TeamContext } from "./team-tool/context.ts";
export { handleDoctor } from "./team-tool/doctor.ts";
export {
	handleArtifacts,
	handleEvents,
	handleSummary,
} from "./team-tool/inspect.ts";
export {
	handleCleanup,
	handleExport,
	handleForget,
	handleImport,
	handleImports,
	handlePrune,
	handleWorktrees,
} from "./team-tool/lifecycle-actions.ts";
export { handleSchedule } from "./team-tool/handle-schedule.ts";
export { handlePlan } from "./team-tool/plan.ts";
export { handleStatus } from "./team-tool/status.ts";
export type { TeamToolDetails } from "./team-tool-types.ts";
export { handleRun };
export { handleOrchestrate } from "./team-tool/orchestrate.ts";

export function handleList(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): PiTeamsToolResult {
	const resource = params.resource;
	const blocks: string[] = [];
	if (!resource || resource === "team") {
		const teams = allTeams(discoverTeams(ctx.cwd));
		blocks.push(
			"Teams:",
			...(teams.length
				? teams.map((team) =>
						formatScoped(team.name, team.source, team.description),
					)
				: ["- (none)"]),
		);
	}
	if (!resource || resource === "workflow") {
		const workflows = allWorkflows(discoverWorkflows(ctx.cwd));
		blocks.push(
			"",
			"Workflows:",
			...(workflows.length
				? workflows.map((workflow) =>
						formatScoped(
							workflow.name,
							workflow.source,
							workflow.description,
						),
					)
				: ["- (none)"]),
		);
	}
	if (!resource || resource === "agent") {
		const agents = allAgents(discoverAgents(ctx.cwd));
		blocks.push(
			"",
			"Agents:",
			...(agents.length
				? agents.map((agent) =>
						formatScoped(
							agent.name,
							agent.source,
							agent.description,
						),
					)
				: ["- (none)"]),
		);
	}
	if (!resource) {
		const runs = listRuns(ctx.cwd).slice(0, 10);
		blocks.push(
			"",
			"Recent runs:",
			...(runs.length
				? runs.map(
						(run) =>
							`- ${run.runId} [${run.status}] ${run.team}/${run.workflow ?? "none"}: ${run.goal}`,
					)
				: ["- (none)"]),
		);
	}
	return result(blocks.join("\n"), { action: "list", status: "ok" });
}

export function handleGet(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): PiTeamsToolResult {
	if (params.team) {
		const team = allTeams(discoverTeams(ctx.cwd)).find(
			(item) => item.name === params.team,
		);
		if (!team)
			return result(
				`Team '${params.team}' not found.`,
				{ action: "get", status: "error" },
				true,
			);
		const lines = [
			`Team: ${team.name} (${team.source})`,
			`Path: ${team.filePath}`,
			`Description: ${team.description}`,
			`Default workflow: ${team.defaultWorkflow ?? "(none)"}`,
			`Workspace mode: ${team.workspaceMode ?? "single"}`,
			"Roles:",
			...(team.roles.length
				? team.roles.map(
						(role) =>
							`- ${role.name} -> ${role.agent}${role.description ? `: ${role.description}` : ""}`,
					)
				: ["- (none)"]),
		];
		return result(lines.join("\n"), { action: "get", status: "ok" });
	}
	if (params.workflow) {
		const workflow = allWorkflows(discoverWorkflows(ctx.cwd)).find(
			(item) => item.name === params.workflow,
		);
		if (!workflow)
			return result(
				`Workflow '${params.workflow}' not found.`,
				{ action: "get", status: "error" },
				true,
			);
		const lines = [
			`Workflow: ${workflow.name} (${workflow.source})`,
			`Path: ${workflow.filePath}`,
			`Description: ${workflow.description}`,
			"Steps:",
			...(workflow.steps.length
				? workflow.steps.map(
						(step) =>
							`- ${step.id} [${step.role}] dependsOn=${step.dependsOn?.join(",") ?? "none"}`,
					)
				: ["- (none)"]),
		];
		return result(lines.join("\n"), { action: "get", status: "ok" });
	}
	if (params.agent) {
		const agent = allAgents(discoverAgents(ctx.cwd)).find(
			(item) => item.name === params.agent,
		);
		if (!agent)
			return result(
				`Agent '${params.agent}' not found.`,
				{ action: "get", status: "error" },
				true,
			);
		const lines = [
			`Agent: ${agent.name} (${agent.source})`,
			`Path: ${agent.filePath}`,
			`Description: ${agent.description}`,
			agent.model ? `Model: ${agent.model}` : undefined,
			agent.skills?.length
				? `Skills: ${agent.skills.join(", ")}`
				: undefined,
			"",
			agent.systemPrompt || "(empty system prompt)",
		].filter((line): line is string => line !== undefined);
		return result(lines.join("\n"), { action: "get", status: "ok" });
	}
	return result(
		"Specify team, workflow, or agent for get.",
		{ action: "get", status: "error" },
		true,
	);
}

function artifactKey(artifact: ArtifactDescriptor): string {
	return `${artifact.kind}:${artifact.path}`;
}

function recoverCheckpointedTasks(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
): { manifest: TeamRunManifest; tasks: TeamTaskState[]; recovered: string[] } {
	const recovered: string[] = [];
	let nextManifest = manifest;
	const nextTasks = tasks.map((task) => {
		if (task.status !== "running" || !task.checkpoint) return task;
		if (
			task.checkpoint.phase === "artifact-written" &&
			task.resultArtifact
		) {
			recovered.push(task.id);
			return {
				...task,
				status: "completed" as const,
				finishedAt: task.finishedAt ?? task.checkpoint.updatedAt,
				error: undefined,
				claim: undefined,
			};
		}
		if (task.checkpoint.phase === "child-stdout-final") {
			// transcripts are written with .attempt-${i}.jsonl suffix; find the most recent one
			const transcriptsDir = path.join(
				manifest.artifactsRoot,
				"transcripts",
			);
			let transcriptPath: string | undefined;
			if (fs.existsSync(transcriptsDir)) {
				const files = fs
					.readdirSync(transcriptsDir)
					.filter(
						(f) =>
							f.startsWith(`${task.id}.attempt-`) &&
							f.endsWith(".jsonl"),
					);
				if (files.length > 0) {
					// Sort by attempt index descending to get the most recent
					files.sort((a, b) => {
						const idxA = parseInt(
							a.match(/\.attempt-(\d+)\./)?.[1] ?? "0",
						);
						const idxB = parseInt(
							b.match(/\.attempt-(\d+)\./)?.[1] ?? "0",
						);
						return idxB - idxA;
					});
					transcriptPath = path.join(transcriptsDir, files[0]);
				}
			}
			if (!transcriptPath) return task;
			const transcript = fs.readFileSync(transcriptPath, "utf-8");
			const parsed = parsePiJsonOutput(transcript);
			if (!parsed.finalText && !parsed.usage) return task;
			const resultArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "result",
				relativePath: `results/${task.id}.txt`,
				content:
					parsed.finalText ??
					"(recovered from completed child transcript)",
				producer: task.id,
			});
			const transcriptArtifact = writeArtifact(manifest.artifactsRoot, {
				kind: "log",
				relativePath: `transcripts/${task.id}.jsonl`,
				content: transcript,
				producer: task.id,
			});
			recovered.push(task.id);
			return {
				...task,
				status: "completed" as const,
				finishedAt: task.finishedAt ?? task.checkpoint.updatedAt,
				error: undefined,
				claim: undefined,
				resultArtifact,
				transcriptArtifact,
				usage: parsed.usage,
				jsonEvents: parsed.jsonEvents,
			};
		}
		return task;
	});
	if (recovered.length) {
		const artifacts = new Map(
			nextManifest.artifacts.map((artifact) => [
				artifactKey(artifact),
				artifact,
			]),
		);
		for (const task of nextTasks) {
			if (!recovered.includes(task.id)) continue;
			for (const artifact of [
				task.promptArtifact,
				task.resultArtifact,
				task.logArtifact,
				task.transcriptArtifact,
			].filter(Boolean) as ArtifactDescriptor[])
				artifacts.set(artifactKey(artifact), artifact);
		}
		nextManifest = {
			...nextManifest,
			artifacts: [...artifacts.values()],
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(nextManifest);
		saveRunTasks(nextManifest, nextTasks);
	}
	return { manifest: nextManifest, tasks: nextTasks, recovered };
}

export async function handleResume(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<PiTeamsToolResult> {
	if (!params.runId)
		return result(
			"Resume requires runId.",
			{ action: "resume", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd)
		return result(
			`Run '${params.runId}' not found.`,
			{ action: "resume", status: "error" },
			true,
		);
	const loaded = loadRunManifestById(runCwd, params.runId);
	if (!loaded)
		return result(
			`Run '${params.runId}' not found.`,
			{ action: "resume", status: "error" },
			true,
		);
	if (!loaded.manifest.workflow)
		return result(
			`Run '${params.runId}' has no workflow to resume.`,
			{ action: "resume", status: "error" },
			true,
		);
	const agents = allAgents(discoverAgents(ctx.cwd));
	const direct = directTeamAndWorkflowFromRun(
		loaded.manifest,
		loaded.tasks,
		agents,
	);
	const team =
		direct?.team ??
		allTeams(discoverTeams(ctx.cwd)).find(
			(candidate) => candidate.name === loaded.manifest.team,
		);
	if (!team)
		return result(
			`Team '${loaded.manifest.team}' not found.`,
			{ action: "resume", status: "error" },
			true,
		);
	const workflow =
		direct?.workflow ??
		allWorkflows(discoverWorkflows(ctx.cwd)).find(
			(candidate) => candidate.name === loaded.manifest.workflow,
		);
	if (!workflow)
		return result(
			`Workflow '${loaded.manifest.workflow}' not found.`,
			{ action: "resume", status: "error" },
			true,
		);
	return await withRunLock(loaded.manifest, async () => {
		const loadedConfig = loadConfig(ctx.cwd);
		const recovered = recoverCheckpointedTasks(
			loaded.manifest,
			loaded.tasks,
		);
		const resumeManifest = recovered.manifest;
		const executedConfig = {
			...effectiveRunConfig(loadedConfig.config, params.config),
		};
		// Preserve original manifest scaffold mode when resume has no explicit mode override
		// AND workers are not explicitly disabled. If workers are disabled, let
		// resolveCrewRuntime detect it and return blocked safety.
		if (
			!executedConfig.runtime?.mode &&
			resumeManifest.runtimeResolution?.safety === "explicit_dry_run"
		) {
			const workersDisabled =
				executedConfig.executeWorkers === false ||
				process.env.PI_CREW_EXECUTE_WORKERS === "0" ||
				process.env.PI_TEAMS_EXECUTE_WORKERS === "0";
			if (!workersDisabled)
				executedConfig.runtime = {
					...executedConfig.runtime,
					mode: "scaffold",
				};
		}
		const runtime = await resolveCrewRuntime(executedConfig);
		const runtimeResolution = runtimeResolutionState(runtime);
		const runtimeManifest = {
			...resumeManifest,
			runtimeResolution,
			updatedAt: new Date().toISOString(),
		};
		saveRunManifest(runtimeManifest);
		appendEvent(runtimeManifest.eventsPath, {
			type: "runtime.resolved",
			runId: runtimeManifest.runId,
			message: `Runtime resolved for resume: ${runtime.kind} safety=${runtime.safety}`,
			data: { runtimeResolution, action: "resume" },
		});
		if (runtime.safety === "blocked") {
			const runningManifest = updateRunStatus(
				runtimeManifest,
				"running",
				"Checking worker runtime availability before resume.",
			);
			const blocked = updateRunStatus(
				runningManifest,
				"blocked",
				runtime.reason ??
					"Child worker execution is disabled; refusing to resume with no-op scaffold subagents.",
			);
			appendEvent(blocked.eventsPath, {
				type: "run.blocked",
				runId: blocked.runId,
				message: blocked.summary,
				data: { runtime, action: "resume" },
			});
			return result(
				[
					`Blocked resume for pi-crew run ${blocked.runId}: real subagent workers are disabled.`,
					`Runtime: ${runtime.kind} (requested ${runtime.requestedMode})`,
					runtime.reason ?? "Child worker execution is disabled.",
					"",
					"To resume effective subagents, remove executeWorkers=false / PI_CREW_EXECUTE_WORKERS=0 / PI_TEAMS_EXECUTE_WORKERS=0 or set runtime.mode=child-process.",
					"Use runtime.mode=scaffold only for explicit dry-run prompt/artifact generation.",
				].join("\n"),
				{
					action: "resume",
					status: "error",
					runId: blocked.runId,
					artifactsRoot: blocked.artifactsRoot,
				},
				true,
			);
		}
		const resetTasks = recovered.tasks.map((task) =>
			task.status === "failed" ||
			task.status === "cancelled" ||
			task.status === "skipped" ||
			task.status === "running"
				? {
						...task,
						status: "queued" as const,
						error: undefined,
						startedAt: undefined,
						finishedAt: undefined,
						claim: undefined,
					}
				: task,
		);
		saveRunTasks(runtimeManifest, resetTasks);
		const replay = replayPendingMailboxMessages(runtimeManifest);
		appendEvent(runtimeManifest.eventsPath, {
			type: "run.resume_requested",
			runId: runtimeManifest.runId,
			data: {
				replayedMailboxMessages: replay.messages.length,
				recoveredCheckpointTasks: recovered.recovered,
			},
		});
		if (recovered.recovered.length)
			appendEvent(runtimeManifest.eventsPath, {
				type: "task.checkpoint_recovered",
				runId: runtimeManifest.runId,
				message: `Recovered ${recovered.recovered.length} task(s) from artifact-written checkpoints.`,
				data: { taskIds: recovered.recovered },
			});
		if (replay.messages.length)
			appendEvent(runtimeManifest.eventsPath, {
				type: "mailbox.replayed",
				runId: runtimeManifest.runId,
				message: `Replayed ${replay.messages.length} pending inbox message(s).`,
				data: {
					messageIds: replay.messages.map((message) => message.id),
					taskIds: replay.messages
						.map((message) => message.taskId)
						.filter(Boolean),
				},
			});
		const executeWorkers = runtime.kind !== "scaffold";
		const resumeSkillOverride =
			normalizeSkillOverride(params.skill) ??
			runtimeManifest.skillOverride;
		const executed = await executeTeamRun({
			manifest: runtimeManifest,
			tasks: resetTasks,
			team,
			workflow,
			agents,
			executeWorkers,
			limits: executedConfig.limits,
			runtime,
			runtimeConfig: executedConfig.runtime,
			parentContext: buildParentContext(ctx),
			parentModel: ctx.model,
			modelRegistry: ctx.modelRegistry,
			modelOverride: params.model,
			skillOverride: resumeSkillOverride,
			signal: ctx.signal,
			reliability: executedConfig.reliability,
			metricRegistry: ctx.metricRegistry,
			workspaceId: ctx.sessionId ?? ctx.cwd,
		});
		return result(
			[
				`Resumed run ${executed.manifest.runId}.`,
				`Status: ${executed.manifest.status}`,
				`Tasks: ${executed.tasks.length}`,
				`Artifacts: ${executed.manifest.artifactsRoot}`,
			].join("\n"),
			{
				action: "resume",
				status: executed.manifest.status === "failed" ? "error" : "ok",
				runId: executed.manifest.runId,
				artifactsRoot: executed.manifest.artifactsRoot,
			},
			executed.manifest.status === "failed",
		);
	});
}

export function handleSteer(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): PiTeamsToolResult {
	const { runId, taskId, message } = params;
	if (!runId || !taskId || !message) {
		return result(
			"steer requires runId, taskId, and message",
			{ action: "steer", status: "error" },
			true,
		);
	}
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd)
		return result(
			`Run '${runId}' not found`,
			{ action: "steer", status: "error" },
			true,
		);
	const loaded = loadRunManifestById(runCwd, runId);
	if (!loaded)
		return result(
			`Run '${runId}' not found`,
			{ action: "steer", status: "error" },
			true,
		);
	const task = loaded.tasks.find((t) => t.id === taskId);
	if (!task)
		return result(
			`Task '${taskId}' not found`,
			{ action: "steer", status: "error" },
			true,
		);
	if (!task.pendingSteers) task.pendingSteers = [];
		// HIGH-04: Cap pendingSteers array to prevent unbounded memory growth
		const MAX_PENDING_STEERS = 100;
		if (task.pendingSteers.length >= MAX_PENDING_STEERS) {
			task.pendingSteers = task.pendingSteers.slice(-(MAX_PENDING_STEERS - 1));
		}
		task.pendingSteers.push(message);
	saveRunTasks(loaded.manifest, loaded.tasks);
	appendEvent(loaded.manifest.eventsPath, {
		type: "task.steer_queued",
		runId,
		taskId,
		data: { message },
	});
	return result(
		`Steer queued for task '${taskId}'. It will be delivered when the task's session is ready.`,
		{ action: "steer", status: "ok" },
	);
}

function cacheControlDepsFromContext(
	ctx: TeamContext,
): CacheControlDeps | undefined {
	if (!ctx.getRunSnapshotCache) return undefined;
	return { getRunSnapshotCache: ctx.getRunSnapshotCache };
}

function handleInvalidate(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): PiTeamsToolResult {
	const runId = params.runId;
	if (!runId)
		return result(
			"Invalidate requires runId.",
			{ action: "invalidate", status: "error" },
			true,
		);
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd)
		return result(
			`Run '${runId}' not found.`,
			{ action: "invalidate", status: "error" },
			true,
		);
	const deps = cacheControlDepsFromContext(ctx);
	if (!deps)
		return result(
			"Cache invalidation not available (no snapshot cache).",
			{ action: "invalidate", status: "error" },
			true,
		);
	invalidateSnapshot(runId, runCwd, deps);
	return result(`Cache invalidated for run ${runId}.`, {
		action: "invalidate",
		status: "ok",
		runId,
	});
}

/**
 * Locate the CWD where a run's state is stored.
 * Tries ctx.cwd first, then scans immediate child directories for .crew/state/runs/<runId>.
 */
export function locateRunCwd(runId: string, baseCwd: string): string | undefined {
	// Fast path: run is in the current CWD
	if (loadRunManifestById(baseCwd, runId)) return baseCwd;

	// Scan immediate child directories
	try {
		for (const entry of fs.readdirSync(baseCwd, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const candidate = path.join(baseCwd, entry.name);
			if (loadRunManifestById(candidate, runId)) return candidate;
		}
	} catch {
		/* ignore unreadable dirs */
	}

	return undefined;
}

async function handleWait(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<PiTeamsToolResult> {
	const { runId } = params;
	if (!runId)
		return result(
			"wait requires runId.",
			{ action: "wait", status: "error" },
			true,
		);

	const timeoutMs = Math.min(
		Math.max(
			typeof params.config?.timeoutMs === "number" &&
				Number.isFinite(params.config.timeoutMs)
				? params.config.timeoutMs
				: 300_000,
			1_000, // minimum 1 s
		),
		3_600_000, // maximum 1 h
	);
	const pollIntervalMs = Math.max(
		Math.min(
			typeof params.config?.pollIntervalMs === "number" &&
				Number.isFinite(params.config.pollIntervalMs)
				? params.config.pollIntervalMs
				: 2000,
			60_000, // maximum 60 s
		),
		500, // minimum 500 ms
	);

	// Resolve the run's CWD: try ctx.cwd first, then scan child dirs with .crew/
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd) {
		return result(
			`Run '${runId}' not found in '${ctx.cwd}' or its subdirectories.`,
			{ action: "wait", status: "error", runId },
			true,
		);
	}

	try {
		const { manifest, tasks } = await waitForRun(runId, runCwd, {
			timeoutMs,
			pollIntervalMs,
		});
		const taskSummary = tasks
			.map((t) => `  ${t.id}: ${t.status}`)
			.join("\n");
		return result(
			[
				`Run ${runId} finished: ${manifest.status}`,
				`Summary: ${manifest.summary ?? "(none)"}`,
				`Tasks:`,
				taskSummary,
			].join("\n"),
			{
				action: "wait",
				status: manifest.status === "failed" ? "error" : "ok",
				runId: manifest.runId,
			},
			manifest.status === "failed",
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return result(
			`wait failed: ${msg}`,
			{ action: "wait", status: "error", runId },
			true,
		);
	}
}

export async function handleTeamTool(
	params: TeamToolParamsValue,
	ctx: TeamContext,
): Promise<PiTeamsToolResult> {
	const action = params.action ?? "list";
	switch (action as string) {
		case "list":
			return handleList(params, ctx);
		case "get":
			return handleGet(params, ctx);
		case "init": {
			const cfg = configRecord(params.config);
			const ignoreMethod =
				typeof cfg.ignoreMethod === "string" &&
				(cfg.ignoreMethod === "gitignore" ||
					cfg.ignoreMethod === "exclude")
					? cfg.ignoreMethod
					: undefined;
			const initialized = initializeProject(ctx.cwd, {
				copyBuiltins: cfg.copyBuiltins === true,
				overwrite: cfg.overwrite === true,
				configScope:
					cfg.configScope === "project" || cfg.scope === "project"
						? "project"
						: cfg.configScope === "none" || cfg.scope === "none"
							? "none"
							: "global",
				ignoreMethod,
			});
			return result(
				[
					"Initialized pi-crew project layout.",
					"Directories:",
					...(initialized.createdDirs.length
						? initialized.createdDirs.map(
								(dir) => `- created ${dir}`,
							)
						: ["- already existed"]),
					"Copied builtin files:",
					...(initialized.copiedFiles.length
						? initialized.copiedFiles.map((file) => `- ${file}`)
						: ["- (none)"]),
					...(initialized.skippedFiles.length
						? [
								"Skipped existing files:",
								...initialized.skippedFiles.map(
									(file) => `- ${file}`,
								),
							]
						: []),
					`Config: ${initialized.configPath || "(none)"} (${initialized.configScope}${initialized.configCreated ? "; created" : initialized.configSkipped ? "; already existed" : "; unchanged"})`,
					`Ignore: ${initialized.gitignorePath} (${initialized.gitignoreUpdated ? "updated" : "already configured"})`,
				].join("\n"),
				{ action: "init", status: "ok" },
			);
		}
		case "help":
			return result(piTeamsHelp(), { action: "help", status: "ok" });
		case "recommend": {
			const goal = params.goal ?? params.task;
			if (!goal)
				return result(
					"Recommend requires goal or task.",
					{ action: "recommend", status: "error" },
					true,
				);
			const loaded = loadConfig(ctx.cwd);
			const recommendation = recommendTeam(
				goal,
				loaded.config.autonomous,
				{
					teams: allTeams(discoverTeams(ctx.cwd)),
					agents: allAgents(discoverAgents(ctx.cwd)),
				},
			);
			return result(formatRecommendation(goal, recommendation), {
				action: "recommend",
				status: "ok",
			});
		}
		case "autonomy": {
			const patch = autonomousPatchFromConfig(params.config);
			const shouldUpdate = Object.values(patch).some(
				(value) => value !== undefined,
			);
			if (!shouldUpdate) {
				const loaded = loadConfig(ctx.cwd);
				return result(
					formatAutonomyStatus(
						loaded.config.autonomous,
						loaded.path,
						false,
					),
					{
						action: "autonomy",
						status: loaded.error ? "error" : "ok",
					},
					Boolean(loaded.error),
				);
			}
			try {
				const saved = updateAutonomousConfig(patch);
				return result(
					formatAutonomyStatus(
						saved.config.autonomous,
						saved.path,
						true,
					),
					{ action: "autonomy", status: "ok" },
				);
			} catch (error) {
				const message =
					error instanceof Error ? error.message : String(error);
				return result(
					message,
					{ action: "autonomy", status: "error" },
					true,
				);
			}
		}
		case "config": {
			const patch = configPatchFromConfig(params.config);
			const cfg = configRecord(params.config);
			const unsetPaths = Array.isArray(cfg.unset)
				? cfg.unset.filter(
						(entry): entry is string => typeof entry === "string",
					)
				: typeof cfg.unset === "string"
					? [cfg.unset]
					: [];
			const shouldUpdate =
				Object.values(patch).some((value) => value !== undefined) ||
				unsetPaths.length > 0;
			if (shouldUpdate) {
				try {
					const saved = updateConfig(patch, {
						cwd: ctx.cwd,
						scope: cfg.scope === "project" ? "project" : "user",
						unsetPaths,
					});
					return result(
						[
							"Updated pi-crew config.",
							`Path: ${saved.path}`,
							"Effective config:",
							JSON.stringify(saved.config, null, 2),
						].join("\n"),
						{ action: "config", status: "ok" },
					);
				} catch (error) {
					const message =
						error instanceof Error ? error.message : String(error);
					return result(
						message,
						{ action: "config", status: "error" },
						true,
					);
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
			return result(
				lines.join("\n"),
				{ action: "config", status: loaded.error ? "error" : "ok" },
				Boolean(loaded.error),
			);
		}
		case "validate": {
			const report = validateResources(ctx.cwd);
			const hasErrors = report.issues.some(
				(issue) => issue.level === "error",
			);
			return result(
				formatValidationReport(report),
				{ action: "validate", status: hasErrors ? "error" : "ok" },
				hasErrors,
			);
		}
		case "doctor":
			return handleDoctor(ctx, params);
		case "cleanup":
			return handleCleanup(params, ctx);
		case "api":
			return await handleApi(params, ctx);
		case "events":
			return handleEvents(params, ctx);
		case "artifacts":
			return handleArtifacts(params, ctx);
		case "worktrees":
			return handleWorktrees(params, ctx);
		case "summary":
			return handleSummary(params, ctx);
		case "export":
			return handleExport(params, ctx);
		case "import":
			return handleImport(params, ctx);
		case "imports":
			return handleImports(params, ctx);
		case "settings":
			return handleSettings(params, ctx);
		case "prune":
			return handlePrune(params, ctx);
		case "forget":
			return handleForget(params, ctx);
		case "run":
			return handleRun(params, ctx);
		case "status":
			return handleStatus(params, ctx);
		case "cancel":
			return handleCancel(params, ctx, cacheControlDepsFromContext(ctx));
		case "retry":
			return handleRetry(params, ctx, cacheControlDepsFromContext(ctx));
		case "invalidate":
			return handleInvalidate(params, ctx);
		case "respond":
			return handleRespond(params, ctx);
		case "parallel":
			return await handleParallel(params, ctx);
		case "plan":
			return handlePlan(params, ctx);
		case "orchestrate":
			return handleOrchestrate(params, ctx);
		case "resume":
			return handleResume(params, ctx);
		case "create":
			return handleCreate(params, ctx);
		case "update":
			return handleUpdate(params, ctx);
		case "delete":
			return handleDelete(params, ctx);
		case "steer":
			return handleSteer(params, ctx);
		case "health":
			return handleHealthMonitor(ctx, params);
		case "wait":
			return handleWait(params, ctx);
		case "graph": {
			if (params.runId) {
				const graph = loadRunGraph(ctx.cwd, params.runId);
				return result(
					graph ? JSON.stringify(graph, null, 2) : "No graph found for this run.",
					{ action: "graph", status: graph ? "ok" : "error" },
					!graph,
				);
			}
			const graphs = listRunGraphs(ctx.cwd);
			return result(
				graphs.length ? `Available graphs:\n${graphs.join("\n")}` : "No graphs available.",
				{ action: "graph", status: "ok" },
			);
		}
		case "search": {
			const query = params.goal ?? params.task ?? "";
			if (!query) {
				return result("Search requires goal or task query.", { action: "search", status: "error" }, true);
			}
			try {
				const [agentResults, teamResults] = await Promise.all([
					searchAgents(query, { limit: 5 }),
					searchTeams(query, { limit: 3 }),
				]);
				const lines: string[] = [];
				if (teamResults.length) {
					lines.push("## Teams");
					for (const r of teamResults) {
						lines.push(`- [${r.team.name}] score=${r.score.toFixed(2)}: ${r.team.description ?? "(no description)"}`);
					}
				}
				if (agentResults.length) {
					lines.push("## Agents");
					for (const r of agentResults) {
						lines.push(`- [${r.agent.name}] score=${r.score.toFixed(2)}: ${r.agent.description ?? "(no description)"}`);
					}
				}
				return result(lines.length ? lines.join("\n") : "No results found.", { action: "search", status: "ok" });
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return result(`Search failed: ${msg}`, { action: "search", status: "error" }, true);
			}
		}
		case "schedule":
			return handleSchedule(params, ctx);
		case "scheduled":
			return handleListScheduled(params, ctx);
		case "anchor": {
			const subAction = typeof params.config?.subAction === "string" ? params.config.subAction : "status";
			switch (subAction) {
				case "set":
					return handleAnchorSet(params, ctx);
				case "clear":
					return handleAnchorClear(params, ctx);
				case "accumulate":
					return handleAnchorAccumulate(params, ctx);
				default:
					return handleAnchorStatus(params, ctx);
			}
		}
		case "auto-summarize":
		case "auto_boomerang": {
			const subAction = typeof params.config?.subAction === "string" ? params.config.subAction : ((params.action as string) === "auto_boomerang" ? "toggle" : "status");
			switch (subAction) {
				case "on":
					return handleAutoSummarizeOn(params, ctx);
				case "off":
					return handleAutoSummarizeOff(params, ctx);
				case "config":
					return handleAutoSummarizeConfig(params, ctx);
				case "toggle": {
					const service = createAutoSummarizeService();
					service.toggle();
					return result(
						`Auto-summarize ${service.isEnabled() ? "enabled" : "disabled"}.`,
						{ action: "auto-summarize", status: "ok" },
					);
				}
				default:
					return handleAutoSummarizeStatus(params, ctx);
			}
		}
		case "onboard": {
			const team = params.team ?? "default";
			const onboarding = buildTeamOnboarding(team, ctx.cwd);
			return result(onboarding, { action: "onboard", status: "ok" });
		}
		case "explain": {
			const explainResult = handleExplain(params, ctx.cwd);
			return result(explainResult.text, { action: "explain", status: explainResult.isError ? "error" : "ok" }, explainResult.isError);
		}
		case "cache": {
			if (params.goal) {
				const key = computeRunCacheKey(
					params.goal,
					params.team ?? "default",
					params.workflow ?? "default",
					ctx.cwd,
				);
				const cached = getCachedRun(ctx.cwd, key);
				if (cached) {
					return result(
						`Cached run found (${new Date(cached.cachedAt).toISOString()}): runId=${cached.runId}, status=${cached.status}, ${cached.tasks.length} tasks`,
						{ action: "cache", status: "ok", data: { cacheKey: key, cacheHit: true, runId: cached.runId, status: cached.status, taskCount: cached.tasks.length } },
					);
				}
				return result(`No cached result for key: ${key}`, { action: "cache", status: "ok", data: { cacheKey: key, cacheHit: false } });
			}
			const stats = getCacheStats(ctx.cwd);
			return result(
				`Cache stats: ${stats.entries} entries, ${stats.sizeBytes} bytes`,
				{ action: "cache", status: "ok" },
			);
		}
		case "checkpoint": {
			if (!params.runId || !params.taskId) {
				return result("Checkpoint requires runId and taskId.", { action: "checkpoint", status: "error" }, true);
			}
			const stateRoot = path.join(projectCrewRoot(ctx.cwd), "state", "runs", params.runId);
			const store = new FileCheckpointStore(stateRoot);
			const checkpoint = store.load(params.runId, params.taskId);
			if (!checkpoint) {
				return result("No checkpoint found.", { action: "checkpoint", status: "error" }, true);
			}
			return result(
				`Checkpoint: step=${checkpoint.step}, progress=${checkpoint.progress}, savedAt=${new Date(checkpoint.savedAt).toISOString()}`,
				{ action: "checkpoint", status: "ok", data: { checkpoint } },
			);
		}
		default:
			return result(
				`Unknown action: ${action}`,
				{ action: "unknown", status: "error" },
				true,
			);
	}
}

/**
 * Global RPC registry for cross-extension access to pi-crew's team orchestrator.
 * Uses Symbol.for() for cross-package singleton pattern (same as OpenTelemetry).
 * Extensions can access via: const reg = globalThis[Symbol.for("pi-crew:registry")];
 */
const CREW_REGISTRY_KEY = Symbol.for("pi-crew:registry");
interface CrewRegistry {
	version: 2;
	getRecord: (runId: string) => TeamRunManifest | undefined;
	listRuns: () => Array<{ runId: string; status: string; goal: string }>;
	appendEvent: (runId: string, event: Record<string, unknown>) => void;
	waitForAll: (runId: string) => Promise<void>;
	hasRunning: (runId: string) => boolean;
	/** Register a dynamic agent at runtime. Invalidates the discovery cache. */
	registerAgent: (config: AgentConfig) => void;
	/** Unregister a previously registered dynamic agent. Invalidates the discovery cache. */
	unregisterAgent: (name: string) => void;
	/** List all currently registered dynamic agents. */
	listDynamicAgents: () => AgentConfig[];
}

// ─── Dynamic Agent Registry (Phase 3b) ───────────────────────────────────
// The dynamic agent store lives in discover-agents.ts and is merged into
// discovery results with highest priority. The CrewRegistry interface exposes
// registerAgent/unregisterAgent/listDynamicAgents for cross-extension access.

export function registerCrewGlobalRegistry(registry: CrewRegistry): void {
	(globalThis as Record<symbol | string, unknown>)[CREW_REGISTRY_KEY] =
		registry;
}

export function getCrewGlobalRegistry(): CrewRegistry | undefined {
	return (globalThis as Record<symbol | string, unknown>)[
		CREW_REGISTRY_KEY
	] as CrewRegistry | undefined;
}

/** Create and install the global CrewRegistry singleton. Call once at extension init. */
export function installCrewGlobalRegistry(): void {
	registerCrewGlobalRegistry({
		version: 2,
		getRecord: (runId: string) => undefined as unknown as TeamRunManifest,
		listRuns: () => [],
		appendEvent: () => {},
		waitForAll: async () => {},
		hasRunning: () => false,
		registerAgent: registerDynamicAgent,
		unregisterAgent: unregisterDynamicAgent,
		listDynamicAgents,
	});
}
