import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "../agents/agent-config.ts";
import { allAgents, discoverAgents, listDynamicAgents, registerDynamicAgent, unregisterDynamicAgent } from "../agents/discover-agents.ts";
import { loadConfig } from "../config/config.ts";
// Heavy runtime — lazy-loaded to avoid 1.4s import cost at extension registration.
// executeTeamRun is only called when a team run actually executes.
import type { executeTeamRun as _executeTeamRunFn } from "../runtime/team-runner.ts";
import type { TeamToolParamsValue } from "../schema/team-tool-schema.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { TEAM_TERMINAL_TASK_STATUSES } from "../state/contracts.ts";
import { appendEvent, appendEventFireAndForget } from "../state/event-log/event-log.ts";
import { withRunLock } from "../state/locks.ts";
import { replayPendingMailboxMessages } from "../state/mailbox.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { allTeams, discoverTeams } from "../teams/discover-teams.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { allWorkflows, discoverWorkflows } from "../workflows/discover-workflows.ts";
import { listRuns } from "./run-index.ts";
import type { PiTeamsToolResult } from "./tool-result.ts";

type ExecuteTeamRunFn = typeof _executeTeamRunFn;
let _cachedExecuteTeamRun: ExecuteTeamRunFn | undefined;
async function executeTeamRun(...args: Parameters<ExecuteTeamRunFn>): Promise<Awaited<ReturnType<ExecuteTeamRunFn>>> {
	if (_cachedExecuteTeamRun === undefined) {
		// LAZY: heavy runtime — defer 1.4s import cost until team run actually executes.
		const mod = await import("../runtime/team-runner.ts");
		_cachedExecuteTeamRun = mod.executeTeamRun;
	}
	return _cachedExecuteTeamRun(...args);
}

import { directTeamAndWorkflowFromRun } from "../runtime/direct-run.ts";
import { resolveCrewRuntime, runtimeResolutionState } from "../runtime/model/runtime-resolver.ts";
import { parsePiJsonOutput } from "../runtime/output/pi-json-output.ts";
import { effectiveRunConfig } from "./team-tool/config-patch.ts";
import { buildParentContext, formatScoped, result, type TeamContext } from "./team-tool/context.ts";
// Lazy-loaded: run.ts pulls in spawnBackgroundTeamRun, resolveCrewRuntime, etc.
// Static import fails silently in some jiti contexts (child-process), leaving handleRun undefined.
import type { handleRun as _handleRunFn } from "./team-tool/run.ts";

type HandleRunFn = typeof _handleRunFn;
let _cachedHandleRun: HandleRunFn | undefined;
async function handleRun(...args: Parameters<HandleRunFn>): Promise<Awaited<ReturnType<HandleRunFn>>> {
	if (_cachedHandleRun === undefined) {
		// LAZY: run.ts pulls in spawnBackgroundTeamRun + resolveCrewRuntime; also avoids jiti import race in child-process contexts.
		const mod = await import("./team-tool/run.ts");
		_cachedHandleRun = mod.handleRun;
	}
	return _cachedHandleRun(...args);
}

import { t } from "../i18n.ts";
import { waitForRun } from "../runtime/run-tracker.ts";
import { normalizeSkillOverride } from "../runtime/skill-instructions.ts";
import { formatActionSuggestion } from "./action-suggestions.ts";
import { type CacheControlDeps, invalidateSnapshot } from "./team-tool/cache-control.ts";
// API-5 facade dispatch: domain routers replace the former 54-case switch.
import {
	domainForAction,
	handleAutomateDomain,
	handleControlDomain,
	handleManageDomain,
	handleRunDomain,
	handleStatusDomain,
} from "./team-tool/dispatch/index.ts";
import { RUN_NOT_FOUND_HINT } from "./team-tool/run-not-found.ts";

export { handleApi } from "./team-tool/api.ts";
export { handleRetry } from "./team-tool/cancel.ts";
export type { TeamContext } from "./team-tool/context.ts";
export { handleDoctor } from "./team-tool/doctor.ts";
export { handleSchedule } from "./team-tool/handle-schedule.ts";
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
export { handleOrchestrate } from "./team-tool/orchestrate.ts";
export { handlePlan } from "./team-tool/plan.ts";
export { handleStatus } from "./team-tool/status.ts";
export type { TeamToolDetails } from "./team-tool-types.ts";
export { handleRun };

export function handleList(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const resource = params.resource;
	const blocks: string[] = [];
	if (!resource || resource === "team") {
		const teams = allTeams(discoverTeams(ctx.cwd));
		blocks.push(
			"Teams:",
			...(teams.length ? teams.map((team) => formatScoped(team.name, team.source, team.description)) : ["- (none)"]),
		);
	}
	if (!resource || resource === "workflow") {
		const workflows = allWorkflows(discoverWorkflows(ctx.cwd));
		blocks.push(
			"",
			"Workflows:",
			...(workflows.length
				? workflows.map((workflow) => formatScoped(workflow.name, workflow.source, workflow.description))
				: ["- (none)"]),
		);
	}
	if (!resource || resource === "agent") {
		const agents = allAgents(discoverAgents(ctx.cwd));
		blocks.push(
			"",
			"Agents:",
			...(agents.length ? agents.map((agent) => formatScoped(agent.name, agent.source, agent.description)) : ["- (none)"]),
		);
	}
	if (!resource) {
		const runs = listRuns(ctx.cwd).slice(0, 10);
		blocks.push(
			"",
			"Recent runs:",
			...(runs.length
				? runs.map((run) => `- ${run.runId} [${run.status}] ${run.team}/${run.workflow ?? "none"}: ${run.goal}`)
				: ["- (none)"]),
		);
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
			...(team.roles.length
				? team.roles.map((role) => `- ${role.name} -> ${role.agent}${role.description ? `: ${role.description}` : ""}`)
				: ["- (none)"]),
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
			...(workflow.steps.length
				? workflow.steps.map((step) => `- ${step.id} [${step.role}] dependsOn=${step.dependsOn?.join(",") ?? "none"}`)
				: ["- (none)"]),
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

async function recoverCheckpointedTasks(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[]; recovered: string[] }> {
	const recovered: string[] = [];
	let nextManifest = manifest;
	const nextTasks = tasks.map((task) => {
		if (task.status !== "running" || !task.checkpoint) return task;
		if (task.checkpoint.phase === "artifact-written" && task.resultArtifact) {
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
			const transcriptsDir = path.join(manifest.artifactsRoot, "transcripts");
			let transcriptPath: string | undefined;
			if (fs.existsSync(transcriptsDir)) {
				const files = fs.readdirSync(transcriptsDir).filter((f) => f.startsWith(`${task.id}.attempt-`) && f.endsWith(".jsonl"));
				if (files.length > 0) {
					// Sort by attempt index descending to get the most recent
					files.sort((a, b) => {
						const idxA = parseInt(a.match(/\.attempt-(\d+)\./)?.[1] ?? "0", 10);
						const idxB = parseInt(b.match(/\.attempt-(\d+)\./)?.[1] ?? "0", 10);
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
				content: parsed.finalText ?? "(recovered from completed child transcript)",
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
		const artifacts = new Map(nextManifest.artifacts.map((artifact) => [artifactKey(artifact), artifact]));
		for (const task of nextTasks) {
			if (!recovered.includes(task.id)) continue;
			for (const artifact of [task.promptArtifact, task.resultArtifact, task.logArtifact, task.transcriptArtifact].filter(
				Boolean,
			) as ArtifactDescriptor[])
				artifacts.set(artifactKey(artifact), artifact);
		}
		nextManifest = {
			...nextManifest,
			artifacts: [...artifacts.values()],
			updatedAt: new Date().toISOString(),
		};
		await saveRunManifestAsync(nextManifest);
		saveRunTasks(nextManifest, nextTasks);
	}
	return { manifest: nextManifest, tasks: nextTasks, recovered };
}

export async function handleResume(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	if (!params.runId) return result("Resume requires runId.", { action: "resume", status: "error" }, true);
	const runCwd = locateRunCwd(params.runId, ctx.cwd);
	if (!runCwd) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "resume", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, params.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${params.runId}' not found.${RUN_NOT_FOUND_HINT}`, { action: "resume", status: "error" }, true);
	// R1: foreign-ownership check — mirrors handleRetry/handleCancel. Without it,
	// another session can resume (and re-execute) a run it doesn't own, racing
	// the owning session.
	const foreignRun = typeof loaded.manifest.ownerSessionId === "string" && loaded.manifest.ownerSessionId !== ctx.sessionId;
	if (foreignRun && !params.force) {
		return result(
			`Run ${loaded.manifest.runId} belongs to another session. Use force: true to override.`,
			{ action: "resume", status: "error", runId: loaded.manifest.runId },
			true,
		);
	}
	if (!loaded.manifest.workflow)
		return result(`Run '${params.runId}' has no workflow to resume.`, { action: "resume", status: "error" }, true);
	const agents = allAgents(discoverAgents(ctx.cwd));
	const direct = directTeamAndWorkflowFromRun(loaded.manifest, loaded.tasks, agents);
	const team = direct?.team ?? allTeams(discoverTeams(ctx.cwd)).find((candidate) => candidate.name === loaded.manifest.team);
	if (!team) return result(`Team '${loaded.manifest.team}' not found.`, { action: "resume", status: "error" }, true);
	const workflow =
		direct?.workflow ?? allWorkflows(discoverWorkflows(ctx.cwd)).find((candidate) => candidate.name === loaded.manifest.workflow);
	if (!workflow) return result(`Workflow '${loaded.manifest.workflow}' not found.`, { action: "resume", status: "error" }, true);
	return await withRunLock(loaded.manifest, async () => {
		// R2: re-read inside the lock so recovery + resetTasks reflect committed
		// state, not the pre-lock snapshot. Between the pre-lock load and lock
		// acquisition a task may have been cancelled (stale-reconciler) or
		// completed (background runner); using the stale snapshot would reset
		// running→queued and re-execute it (double execution: duplicate tokens +
		// duplicate side effects). Sibling handlers (cancelOrphanedRuns,
		// reconcileAllStaleRuns) re-read inside the lock for the same reason.
		const fresh = loadRunManifestById(runCwd, loaded.manifest.runId);
		const lockedManifest = fresh?.manifest ?? loaded.manifest;
		const lockedTasks = fresh?.tasks ?? loaded.tasks;
		const loadedConfig = loadConfig(ctx.cwd);
		const recovered = await recoverCheckpointedTasks(lockedManifest, lockedTasks);
		const resumeManifest = recovered.manifest;
		const executedConfig = {
			...effectiveRunConfig(loadedConfig.config, params.config),
		};
		// Preserve original manifest scaffold mode when resume has no explicit mode override
		// AND workers are not explicitly disabled. If workers are disabled, let
		// resolveCrewRuntime detect it and return blocked safety.
		if (!executedConfig.runtime?.mode && resumeManifest.runtimeResolution?.safety === "explicit_dry_run") {
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
		await saveRunManifestAsync(runtimeManifest);
		appendEvent(runtimeManifest.eventsPath, {
			type: "runtime.resolved",
			runId: runtimeManifest.runId,
			message: `Runtime resolved for resume: ${runtime.kind} safety=${runtime.safety}`,
			data: { runtimeResolution, action: "resume" },
		});
		if (runtime.safety === "blocked") {
			const runningManifest = updateRunStatus(runtimeManifest, "running", "Checking worker runtime availability before resume.");
			const blocked = updateRunStatus(
				runningManifest,
				"blocked",
				runtime.reason ?? "Child worker execution is disabled; refusing to resume with no-op scaffold subagents.",
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
			task.status === "failed" || task.status === "cancelled" || task.status === "skipped" || task.status === "running"
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
					taskIds: replay.messages.map((message) => message.taskId).filter(Boolean),
				},
			});
		const executeWorkers = runtime.kind !== "scaffold";
		const resumeSkillOverride = normalizeSkillOverride(params.skill) ?? runtimeManifest.skillOverride;
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

export function handleSteer(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const { runId, taskId, message } = params;
	if (!runId || !taskId || !message) {
		return result("steer requires runId, taskId, and message", { action: "steer", status: "error" }, true);
	}
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd) return result(`Run '${runId}' not found`, { action: "steer", status: "error" }, true);
	const loaded = loadRunManifestById(runCwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) return result(`Run '${runId}' not found`, { action: "steer", status: "error" }, true);
	const task = loaded.tasks.find((t) => t.id === taskId);
	if (!task) return result(`Task '${taskId}' not found`, { action: "steer", status: "error" }, true);
	if (!task.pendingSteers) task.pendingSteers = [];
	// T-S1: do not allow steering a task that has already reached a terminal status.
	if (TEAM_TERMINAL_TASK_STATUSES.has(task.status)) {
		return result(`Task '${taskId}' is ${task.status}; cannot steer.`, { action: "steer", status: "error" }, true);
	}
	// HIGH-04: Cap pendingSteers array to prevent unbounded memory growth
	const MAX_PENDING_STEERS = 100;
	if (task.pendingSteers.length >= MAX_PENDING_STEERS) {
		// Log warning before dropping the oldest message
		appendEventFireAndForget(loaded.manifest.eventsPath, {
			type: "task.steer_dropped",
			runId,
			taskId,
			data: {
				droppedMessage: task.pendingSteers[0],
				reason: "pendingSteers cap exceeded",
				queueDepth: task.pendingSteers.length,
			},
		});
		task.pendingSteers = task.pendingSteers.slice(-(MAX_PENDING_STEERS - 1));
	}
	task.pendingSteers.push(message);
	saveRunTasks(loaded.manifest, loaded.tasks);
	// Real-time steer delivery: write to steering file so child can read immediately
	try {
		const steeringDir = `${loaded.manifest.artifactsRoot}/steering`;
		fs.mkdirSync(steeringDir, { recursive: true });
		// AUDIT-08 defense-in-depth: validate the steering-file path is contained
		// within steeringDir. taskId is currently sanitized via createTaskId, but this
		// guards against future changes to task-id generation (e.g. if it ever
		// accepted user input).
		const safeSteeringPath = resolveRealContainedPath(steeringDir, `${taskId}.jsonl`);
		fs.appendFileSync(safeSteeringPath, JSON.stringify({ type: "steer", message, ts: new Date().toISOString() }) + "\n");
	} catch {
		// Best-effort: file write failure doesn't block the steer from pending array
	}
	appendEvent(loaded.manifest.eventsPath, {
		type: "task.steer_queued",
		runId,
		taskId,
		data: { message },
	});
	return result(`Steer queued for task '${taskId}'. It will be delivered when the task's session is ready.`, {
		action: "steer",
		status: "ok",
	});
}

export function cacheControlDepsFromContext(ctx: TeamContext): CacheControlDeps | undefined {
	if (!ctx.getRunSnapshotCache) return undefined;
	return { getRunSnapshotCache: ctx.getRunSnapshotCache };
}

export function handleInvalidate(params: TeamToolParamsValue, ctx: TeamContext): PiTeamsToolResult {
	const runId = params.runId;
	if (!runId) return result("Invalidate requires runId.", { action: "invalidate", status: "error" }, true);
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd) return result(`Run '${runId}' not found.`, { action: "invalidate", status: "error" }, true);
	const deps = cacheControlDepsFromContext(ctx);
	if (!deps) return result("Cache invalidation not available (no snapshot cache).", { action: "invalidate", status: "error" }, true);
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
 *
 * Defensive bounds (prevent hang on large dirs like /tmp in CI):
 * - Skips entries that are well-known system/ephemeral dirs (e.g. .npm, node_modules, .git)
 * - Caps the scan at MAX_SCAN_ENTRIES to avoid pathological scans
 * - Skips hidden entries (starting with `.`) unless they look like run directories
 *   (e.g. .crew, .pi, .tmp-crew-runs)
 */
const MAX_SCAN_ENTRIES = 1000;
const SKIP_SCAN_DIRS = new Set(["node_modules", ".git", ".npm", ".cache", ".local", "proc", "sys", "dev", "Library", "Applications"]);

export function locateRunCwd(runId: string, baseCwd: string): string | undefined {
	// Fast path: run is in the current CWD
	if (loadRunManifestById(baseCwd, runId)) {
		return baseCwd;
	}

	// Scan immediate child directories, but with defensive bounds.
	try {
		const entries = fs.readdirSync(baseCwd, { withFileTypes: true });
		const boundedEntries = entries.length > MAX_SCAN_ENTRIES ? entries.slice(0, MAX_SCAN_ENTRIES) : entries;
		for (const entry of boundedEntries) {
			if (!entry.isDirectory()) continue;
			if (SKIP_SCAN_DIRS.has(entry.name)) continue;
			// Skip hidden entries except well-known run-storage prefixes
			if (entry.name.startsWith(".")) {
				if (!entry.name.startsWith(".crew") && !entry.name.startsWith(".pi") && !entry.name.startsWith(".tmp-crew")) continue;
			}
			const candidate = path.join(baseCwd, entry.name);
			if (loadRunManifestById(candidate, runId)) {
				return candidate;
			}
		}
	} catch {
		/* ignore unreadable dirs */
	}

	return undefined;
}

export async function handleWait(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	const { runId } = params;
	if (!runId) return result("wait requires runId.", { action: "wait", status: "error" }, true);

	const timeoutMs = Math.min(
		Math.max(
			typeof params.config?.timeoutMs === "number" && Number.isFinite(params.config.timeoutMs) ? params.config.timeoutMs : 300_000,
			1_000, // minimum 1 s
		),
		3_600_000, // maximum 1 h
	);
	const pollIntervalMs = Math.max(
		Math.min(
			typeof params.config?.pollIntervalMs === "number" && Number.isFinite(params.config.pollIntervalMs)
				? params.config.pollIntervalMs
				: 2000,
			60_000, // maximum 60 s
		),
		500, // minimum 500 ms
	);

	// Resolve the run's CWD: try ctx.cwd first, then scan child dirs with .crew/
	const runCwd = locateRunCwd(runId, ctx.cwd);
	if (!runCwd) {
		return result(`Run '${runId}' not found in '${ctx.cwd}' or its subdirectories.`, { action: "wait", status: "error", runId }, true);
	}

	try {
		const { manifest, tasks } = await waitForRun(runId, runCwd, {
			timeoutMs,
			pollIntervalMs,
		});
		const taskSummary = tasks.map((t) => `  ${t.id}: ${t.status}`).join("\n");
		return result(
			[`Run ${runId} finished: ${manifest.status}`, `Summary: ${manifest.summary ?? "(none)"}`, `Tasks:`, taskSummary].join("\n"),
			{
				action: "wait",
				status: manifest.status === "failed" ? "error" : "ok",
				runId: manifest.runId,
			},
			manifest.status === "failed",
		);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return result(`wait failed: ${msg}`, { action: "wait", status: "error", runId }, true);
	}
}

export async function handleTeamTool(params: TeamToolParamsValue, ctx: TeamContext): Promise<PiTeamsToolResult> {
	// API-5 fix: normalize action into params so the domain routers (which read
	// params.action) see the resolved default, not the raw undefined. Without this,
	// a missing action defaulted to "list" at the facade but the router read
	// params.action=undefined → "Unhandled status-domain action: undefined".
	params = { ...params, action: params.action ?? "list" };
	const action = params.action ?? "list";
	const domain = domainForAction(action);
	switch (domain) {
		case "run":
			return handleRunDomain(params, ctx);
		case "status":
			return handleStatusDomain(params, ctx);
		case "control":
			return handleControlDomain(params, ctx);
		case "manage":
			return handleManageDomain(params, ctx);
		case "automate":
			return handleAutomateDomain(params, ctx);
		default:
			return result(
				t("team.unknownAction", { action: String(action) }) + formatActionSuggestion(String(action)),
				{ action: "unknown", status: "error" },
				true,
			);
	}
}

/**
 * Module-scoped RPC registry for access to pi-crew's team orchestrator.
 *
 * EXT-9: Previously this used a `globalThis[Symbol.for("pi-crew:registry")]`
 * singleton — fragile (cross-realm, no lifecycle, peer extensions could
 * read/overwrite it). It is now a module-level variable: exactly one instance
 * per extension load (one per pi session), invisible to peer extensions.
 * Cross-extension consumers should use the `pi.events` RPC channel
 * (`registerPiCrewRpc`) instead of poking globalThis.
 */
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

// Module-scoped singleton instance — one per extension load (EXT-9).
let crewRegistryInstance: CrewRegistry | undefined;

export function registerCrewGlobalRegistry(registry: CrewRegistry): void {
	crewRegistryInstance = registry;
}

/** @internal — exported for lifecycle tests. */
export function getCrewGlobalRegistry(): CrewRegistry | undefined {
	return crewRegistryInstance;
}

/** Manifest cache shape needed to construct the global registry's read-side. */
interface ManifestCacheForRegistry {
	get: (runId: string) => TeamRunManifest | undefined;
	list: (limit: number) => TeamRunManifest[];
}

/**
 * Build and install the global CrewRegistry singleton in a single atomic step.
 *
 * EXT-7 (Round 3): The previous design called `installCrewGlobalRegistry()` to
 * install stubs, then patched the manifest-backed methods asynchronously inside
 * `register.ts`. That left a window where cross-extension consumers could observe
 * the stub object on `globalThis[Symbol.for("pi-crew:registry")]`. By taking the
 * real dependencies up-front, we install the registry once with no stub phase —
 * callers see either no registry (pre-init) or the fully-real registry.
 */
export function installCrewGlobalRegistry(deps?: { manifestCache: ManifestCacheForRegistry; cwdProvider: () => string }): void {
	const manifestCache = deps?.manifestCache;
	const cwdProvider = deps?.cwdProvider ?? ((): string => process.cwd());
	const registry: CrewRegistry = {
		version: 2,
		getRecord: (runId: string) => manifestCache?.get(runId),
		listRuns: () =>
			manifestCache
				? manifestCache.list(100).map((m) => ({ runId: m.runId, status: m.status, goal: m.goal }))
				: ([] as Array<{ runId: string; status: string; goal: string }>),
		appendEvent: (runId: string, event: Record<string, unknown>) => {
			if (!manifestCache) return;
			const manifest = manifestCache.get(runId);
			if (manifest) {
				// LAZY: event-log is already loaded at module top, so use the
				// pre-resolved appendEventFireAndForget instead of re-importing.
				appendEventFireAndForget(manifest.eventsPath, event as Parameters<typeof appendEventFireAndForget>[1]);
			}
		},
		waitForAll: async (runId: string) => {
			if (!manifestCache) return;
			// LAZY: state-store is already loaded at module top; use the pre-resolved loadRunManifestById.
			const check = (): boolean => {
				const loaded = loadRunManifestById(cwdProvider(), runId);
				if (!loaded) return true;
				return !loaded.tasks.some((t: { status: string }) => t.status === "running" || t.status === "queued");
			};
			while (!check()) await new Promise((resolve) => setTimeout(resolve, 500));
		},
		hasRunning: (runId: string) => {
			if (!manifestCache) return false;
			const manifest = manifestCache.get(runId);
			if (!manifest) return false;
			// LAZY: state-store is already loaded at module top; use the pre-resolved loadRunManifestById.
			const loaded = loadRunManifestById(cwdProvider(), runId);
			if (!loaded) return false;
			return loaded.tasks.some((t: { status: string }) => t.status === "running" || t.status === "queued");
		},
		registerAgent: registerDynamicAgent,
		unregisterAgent: unregisterDynamicAgent,
		listDynamicAgents,
	};
	registerCrewGlobalRegistry(registry);
}

/** Remove the CrewRegistry singleton. Call during session cleanup. */
export function uninstallCrewGlobalRegistry(): void {
	crewRegistryInstance = undefined;
}
