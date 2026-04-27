import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "./types.ts";
import { canTransitionRunStatus } from "./contracts.ts";
import { atomicWriteJson, readJsonFile } from "./atomic-write.ts";
import { appendEvent } from "./event-log.ts";
import { createRunId, createTaskId } from "../utils/ids.ts";
import { projectPiRoot, userPiRoot } from "../utils/paths.ts";
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

function useProjectState(cwd: string): boolean {
	return fs.existsSync(path.join(cwd, ".pi")) || fs.existsSync(path.join(cwd, ".git"));
}

export function createRunPaths(cwd: string, runId = createRunId()): RunPaths {
	const baseRoot = useProjectState(cwd)
		? path.join(projectPiRoot(cwd), "teams")
		: path.join(userPiRoot(), "extensions", "pi-crew", "runs");
	const stateRoot = path.join(baseRoot, "state", "runs", runId);
	const artifactsRoot = path.join(baseRoot, "artifacts", runId);
	return {
		runId,
		stateRoot,
		artifactsRoot,
		manifestPath: path.join(stateRoot, "manifest.json"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
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
	appendEvent(paths.eventsPath, { type: "run.created", runId: paths.runId, data: { team: params.team.name, workflow: params.workflow?.name } });
	return { manifest, tasks, paths };
}

export function saveRunManifest(manifest: TeamRunManifest): void {
	atomicWriteJson(path.join(manifest.stateRoot, "manifest.json"), manifest);
}

export function saveRunTasks(manifest: TeamRunManifest, tasks: TeamTaskState[]): void {
	atomicWriteJson(manifest.tasksPath, tasks);
}

export function updateRunStatus(manifest: TeamRunManifest, status: TeamRunManifest["status"], summary?: string): TeamRunManifest {
	if (!canTransitionRunStatus(manifest.status, status)) {
		throw new Error(`Invalid run status transition: ${manifest.status} -> ${status}`);
	}
	const updated: TeamRunManifest = { ...manifest, status, updatedAt: new Date().toISOString(), summary: summary ?? manifest.summary };
	saveRunManifest(updated);
	appendEvent(updated.eventsPath, { type: `run.${status}`, runId: updated.runId, message: summary });
	return updated;
}

export function loadRunManifestById(cwd: string, runId: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined {
	const projectPath = path.join(projectPiRoot(cwd), "teams", "state", "runs", runId);
	const userPath = path.join(userPiRoot(), "extensions", "pi-crew", "runs", "state", "runs", runId);
	const stateRoot = fs.existsSync(projectPath) ? projectPath : userPath;
	const manifest = readJsonFile<TeamRunManifest>(path.join(stateRoot, "manifest.json"));
	if (!manifest) return undefined;
	const tasks = readJsonFile<TeamTaskState[]>(path.join(stateRoot, "tasks.json")) ?? [];
	return { manifest, tasks };
}
