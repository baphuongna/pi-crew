import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "./types.ts";
import { canTransitionRunStatus } from "./contracts.ts";
import { atomicWriteJson, atomicWriteJsonAsync, readJsonFile } from "./atomic-write.ts";
import { appendEvent } from "./event-log.ts";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";
import { createRunId, createTaskId } from "../utils/ids.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";

export interface RunPaths {
	runId: string;
	stateRoot: string;
	artifactsRoot: string;
	manifestPath: string;
	tasksPath: string;
	eventsPath: string;
}

interface ManifestCacheEntry {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	manifestMtimeMs: number;
	manifestSize: number;
	tasksMtimeMs: number;
	tasksSize: number;
}

const manifestCache = new Map<string, ManifestCacheEntry>();

function setManifestCache(stateRoot: string, entry: ManifestCacheEntry): void {
	if (manifestCache.has(stateRoot)) manifestCache.delete(stateRoot);
	manifestCache.set(stateRoot, entry);
	while (manifestCache.size > DEFAULT_CACHE.manifestMaxEntries) {
		const oldest = manifestCache.keys().next().value;
		if (!oldest) break;
		manifestCache.delete(oldest);
	}
}

function useProjectState(cwd: string): boolean {
	return findRepoRoot(cwd) !== undefined;
}

function invalidateRunCache(stateRoot: string): void {
	manifestCache.delete(stateRoot);
}

function scopeBaseRoot(cwd: string): string {
	return useProjectState(cwd) ? projectCrewRoot(cwd) : userCrewRoot();
}

function resolveRunStateRoot(cwd: string, runId: string): string | undefined {
	const scopedPath = path.join(scopeBaseRoot(cwd), DEFAULT_PATHS.state.runsSubdir, runId);
	return fs.existsSync(scopedPath) ? scopedPath : undefined;
}

export function createRunPaths(cwd: string, runId = createRunId()): RunPaths {
	const baseRoot = scopeBaseRoot(cwd);
	const stateRoot = path.join(baseRoot, DEFAULT_PATHS.state.runsSubdir, runId);
	const artifactsRoot = path.join(baseRoot, DEFAULT_PATHS.state.artifactsSubdir, runId);
	return {
		runId,
		stateRoot,
		artifactsRoot,
		manifestPath: path.join(stateRoot, DEFAULT_PATHS.state.manifestFile),
		tasksPath: path.join(stateRoot, DEFAULT_PATHS.state.tasksFile),
		eventsPath: path.join(stateRoot, DEFAULT_PATHS.state.eventsFile),
	};
}

export function createTasksFromWorkflow(runId: string, workflow: WorkflowConfig, team: TeamConfig, cwd: string): TeamTaskState[] {
	const stepToTaskId = new Map(workflow.steps.map((step, index) => [step.id, createTaskId(step.id, index)]));
	return workflow.steps.map((step, index) => {
		const role = team.roles.find((candidate) => candidate.name === step.role);
		const id = stepToTaskId.get(step.id) ?? createTaskId(step.id, index);
		const dependencies = step.dependsOn ?? [];
		const children = workflow.steps.filter((candidate) => candidate.dependsOn?.includes(step.id)).map((candidate) => stepToTaskId.get(candidate.id)).filter((childId): childId is string => childId !== undefined);
		return {
			id,
			runId,
			stepId: step.id,
			role: step.role,
			agent: role?.agent ?? step.role,
			title: step.id,
			status: "queued",
			dependsOn: dependencies,
			cwd,
			model: step.model,
			graph: {
				taskId: id,
				parentId: dependencies[0] ? stepToTaskId.get(dependencies[0]) : undefined,
				children,
				dependencies: dependencies.map((dep) => stepToTaskId.get(dep) ?? dep),
				queue: dependencies.length ? "blocked" : "ready",
			},
		};
	});
}

export function createRunManifest(params: {
	cwd: string;
	team: TeamConfig;
	workflow?: WorkflowConfig;
	goal: string;
	workspaceMode?: "single" | "worktree";
}): { manifest: TeamRunManifest; tasks: TeamTaskState[]; paths: RunPaths } {
	const paths = createRunPaths(params.cwd);
	const now = new Date().toISOString();
	const tasks = params.workflow ? createTasksFromWorkflow(paths.runId, params.workflow, params.team, params.cwd) : [];
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: paths.runId,
		team: params.team.name,
		workflow: params.workflow?.name,
		goal: params.goal,
		status: "queued",
		workspaceMode: params.workspaceMode ?? params.team.workspaceMode ?? "single",
		createdAt: now,
		updatedAt: now,
		cwd: params.cwd,
		stateRoot: paths.stateRoot,
		artifactsRoot: paths.artifactsRoot,
		tasksPath: paths.tasksPath,
		eventsPath: paths.eventsPath,
		artifacts: [],
	};
	fs.mkdirSync(paths.stateRoot, { recursive: true });
	fs.mkdirSync(paths.artifactsRoot, { recursive: true });
	atomicWriteJson(paths.manifestPath, manifest);
	atomicWriteJson(paths.tasksPath, tasks);
	appendEvent(paths.eventsPath, {
		type: "run.created",
		runId: paths.runId,
		data: { team: params.team.name, workflow: params.workflow?.name },
		metadata: {
			seq: 1,
			provenance: "team_runner",
			sessionIdentity: { title: params.team.name, workspace: params.cwd, purpose: params.goal },
			ownership: { owner: params.team.name, workflowScope: params.workflow?.name ?? "manual", watcherAction: "act" },
			confidence: "high",
		},
	});
	invalidateRunCache(paths.stateRoot);
	return { manifest, tasks, paths };
}

export function saveRunManifest(manifest: TeamRunManifest): void {
	atomicWriteJson(path.join(manifest.stateRoot, "manifest.json"), manifest);
	invalidateRunCache(manifest.stateRoot);
}

export async function saveRunManifestAsync(manifest: TeamRunManifest): Promise<void> {
	await atomicWriteJsonAsync(path.join(manifest.stateRoot, "manifest.json"), manifest);
	invalidateRunCache(manifest.stateRoot);
}

export function saveRunTasks(manifest: TeamRunManifest, tasks: TeamTaskState[]): void {
	atomicWriteJson(manifest.tasksPath, tasks);
	invalidateRunCache(manifest.stateRoot);
}

export async function saveRunTasksAsync(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<void> {
	await atomicWriteJsonAsync(manifest.tasksPath, tasks);
	invalidateRunCache(manifest.stateRoot);
}

export function updateRunStatus(manifest: TeamRunManifest, status: TeamRunManifest["status"], summary?: string): TeamRunManifest {
	if (!canTransitionRunStatus(manifest.status, status)) {
		throw new Error(`Invalid run status transition: ${manifest.status} -> ${status}`);
	}
	const updated: TeamRunManifest = { ...manifest, status, updatedAt: new Date().toISOString(), summary: summary ?? manifest.summary };
	saveRunManifest(updated);
	appendEvent(updated.eventsPath, {
		type: `run.${status}`,
		runId: updated.runId,
		message: summary,
		metadata: {
			provenance: "team_runner",
			sessionIdentity: { title: updated.team, workspace: updated.cwd, purpose: updated.goal },
			ownership: { owner: updated.team, workflowScope: updated.workflow ?? "manual", watcherAction: "act" },
			confidence: "high",
		},
	});
	return updated;
}

export function __test__manifestCacheSize(): number {
	return manifestCache.size;
}

export function __test__clearManifestCache(): void {
	manifestCache.clear();
}

export function loadRunManifestById(cwd: string, runId: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined {
	const stateRoot = resolveRunStateRoot(cwd, runId);
	if (!stateRoot) return undefined;
	const manifestPath = path.join(stateRoot, "manifest.json");
	const tasksPath = path.join(stateRoot, "tasks.json");

	let manifestStat: fs.Stats;
	try {
		manifestStat = fs.statSync(manifestPath);
	} catch {
		return undefined;
	}
	const cached = manifestCache.get(stateRoot);
	let tasksStat: fs.Stats | undefined;
	try {
		tasksStat = fs.statSync(tasksPath);
	} catch {
		tasksStat = undefined;
	}
	const tasksMtimeMs = tasksStat?.mtimeMs ?? 0;
	if (
		cached
		&& cached.manifestMtimeMs === manifestStat.mtimeMs
		&& cached.manifestSize === manifestStat.size
		&& cached.tasksMtimeMs === tasksMtimeMs
		&& cached.tasksSize === (tasksStat?.size ?? 0)
	) {
		return { manifest: cached.manifest, tasks: cached.tasks };
	}

	const manifest = readJsonFile<TeamRunManifest>(manifestPath);
	if (!manifest) return undefined;
	const tasks = readJsonFile<TeamTaskState[]>(tasksPath) ?? [];
	setManifestCache(stateRoot, {
		manifest,
		tasks,
		manifestMtimeMs: manifestStat.mtimeMs,
		manifestSize: manifestStat.size,
		tasksMtimeMs,
		tasksSize: tasksStat?.size ?? 0,
	});
	return { manifest, tasks };
}
