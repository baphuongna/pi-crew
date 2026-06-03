import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "./types.ts";
import { canTransitionRunStatus } from "./contracts.ts";
import { unregisterActiveRun } from "./active-run-registry.ts";
import { atomicWriteJson, atomicWriteJsonAsync, atomicWriteJsonCoalesced, readJsonFile } from "./atomic-write.ts";
import { appendEvent } from "./event-log.ts";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";
import { createRunId, createTaskId } from "../utils/ids.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { assertSafePathId, resolveContainedRelativePath, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { withRunLock } from "./locks.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import { toPiSessionId } from "../utils/session-utils.ts";

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
	cachedAt?: number;
}

const MANIFEST_CACHE_TTL_MS = 30 * 1000; // 30 seconds (FIX: reduced from 5 minutes for faster state updates)
const manifestCache = new Map<string, ManifestCacheEntry>();

function setManifestCache(stateRoot: string, entry: ManifestCacheEntry): void {
	if (manifestCache.has(stateRoot)) manifestCache.delete(stateRoot);
	entry.cachedAt = Date.now();
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
	assertSafePathId("runId", runId);
	const runsRoot = path.join(scopeBaseRoot(cwd), DEFAULT_PATHS.state.runsSubdir);
	const scopedPath = resolveContainedRelativePath(runsRoot, runId, "runId");
	try {
		// Single atomic validation: resolves through symlinks via realpath,
		// verifies containment within runsRoot, and throws ENOENT if missing.
		// Eliminates the TOCTOU window from the previous existsSync + lstatSync
		// + resolveRealContainedPath sequence.
		resolveRealContainedPath(runsRoot, runId);
	} catch {
		return undefined;
	}
	return scopedPath;
}

function validateRunManifestPaths(cwd: string, runId: string, manifest: TeamRunManifest, stateRoot: string, tasksPath: string): boolean {
	if (manifest.runId !== runId || manifest.stateRoot !== stateRoot || manifest.tasksPath !== tasksPath || manifest.eventsPath !== path.join(stateRoot, "events.jsonl")) return false;
	const artifactsParent = path.join(scopeBaseRoot(cwd), DEFAULT_PATHS.state.artifactsSubdir);
	const expectedArtifactsRoot = resolveContainedRelativePath(artifactsParent, runId, "runId");
	if (manifest.artifactsRoot !== expectedArtifactsRoot) return false;
	if (fs.existsSync(expectedArtifactsRoot)) {
		try {
			if (fs.lstatSync(expectedArtifactsRoot).isSymbolicLink()) return false;
			resolveRealContainedPath(artifactsParent, runId);
		} catch {
			return false;
		}
	}
	return true;
}

export function createRunPaths(cwd: string, runId = createRunId()): RunPaths {
	assertSafePathId("runId", runId);
	const baseRoot = scopeBaseRoot(cwd);
	const stateRoot = resolveContainedRelativePath(path.join(baseRoot, DEFAULT_PATHS.state.runsSubdir), runId, "runId");
	const artifactsRoot = resolveContainedRelativePath(path.join(baseRoot, DEFAULT_PATHS.state.artifactsSubdir), runId, "runId");
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
	ownerSessionId?: string;
}): { manifest: TeamRunManifest; tasks: TeamTaskState[]; paths: RunPaths } {
	const paths = createRunPaths(params.cwd);
	const now = new Date().toISOString();
	const tasks = params.workflow ? createTasksFromWorkflow(paths.runId, params.workflow, params.team, params.cwd) : [];
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: paths.runId,
		sessionId: toPiSessionId(paths.runId),
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
		...(params.ownerSessionId ? { ownerSessionId: params.ownerSessionId } : {}),
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

/**
 * 2.1 caller-migration helper: coalesced variant. Use only when the
 * caller does NOT immediately read tasks.json afterwards (the read would
 * see the previous on-disk content while the write is still buffered).
 * Bulk update paths that fan out into multiple writer call sites are the
 * intended use case. Single-update + read-update loops (e.g.
 * persistSingleTaskUpdate) should keep using saveRunTasks.
 */
export function saveRunTasksCoalesced(manifest: TeamRunManifest, tasks: TeamTaskState[]): void {
	atomicWriteJsonCoalesced(manifest.tasksPath, tasks);
	invalidateRunCache(manifest.stateRoot);
}

export async function saveRunTasksAsync(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<void> {
	await atomicWriteJsonAsync(manifest.tasksPath, tasks);
	invalidateRunCache(manifest.stateRoot);
}

/**
 * Save manifest and tasks files with individual atomic writes.
 *
 * Note: The two writes are individually atomic (via rename) but not
 * jointly atomic — a crash between writes can leave them inconsistent.
 * This is acceptable because crash recovery detects and repairs
 * inconsistent state on next session start.
 */
export async function saveManifestAndTasksAtomic(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<void> {
	await withRunLock(manifest, async () => {
		await Promise.all([
			atomicWriteJsonAsync(path.join(manifest.stateRoot, "manifest.json"), manifest),
			atomicWriteJsonAsync(manifest.tasksPath, tasks),
		]);
		invalidateRunCache(manifest.stateRoot);
	});
}

export interface UpdateRunStatusOptions {
	data?: Record<string, unknown>;
	metadata?: Parameters<typeof appendEvent>[1]["metadata"];
}

export function updateRunStatus(manifest: TeamRunManifest, status: TeamRunManifest["status"], summary?: string, options: UpdateRunStatusOptions = {}): TeamRunManifest {
	if (!canTransitionRunStatus(manifest.status, status)) {
		throw new Error(`Invalid run status transition: ${manifest.status} -> ${status}`);
	}
	const updated: TeamRunManifest = { ...manifest, status, updatedAt: new Date().toISOString(), summary: summary ?? manifest.summary };
	saveRunManifest(updated);
	// Unregister from active-run-index when run reaches a terminal status.
	// Without this, stale entries accumulate (e.g. integration tests in /tmp) and
	// Pi UI shows ghost "queued" runs that are actually completed/failed/cancelled.
	// Note: "blocked" is excluded because blocked runs can be unblocked later.
	if (status === "completed" || status === "failed" || status === "cancelled") {
		try { unregisterActiveRun(updated.runId); } catch { /* non-critical */ }
	}
	appendEvent(updated.eventsPath, {
		type: `run.${status}`,
		runId: updated.runId,
		message: summary,
		...(options.data ? { data: options.data } : {}),
		metadata: {
			provenance: "team_runner",
			sessionIdentity: { title: updated.team, workspace: updated.cwd, purpose: updated.goal },
			ownership: { owner: updated.team, workflowScope: updated.workflow ?? "manual", watcherAction: "act" },
			confidence: "high",
			...options.metadata,
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

async function readJsonFileAsync<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as T;
	} catch {
		return undefined;
	}
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
		// TTL eviction: expire stale entries even if mtime matches
		if (cached.cachedAt && Date.now() - cached.cachedAt > MANIFEST_CACHE_TTL_MS) {
			manifestCache.delete(stateRoot);
		} else if (!validateRunManifestPaths(cwd, runId, cached.manifest, stateRoot, tasksPath)) {
			manifestCache.delete(stateRoot);
			return undefined;
		} else {
			return { manifest: cached.manifest, tasks: cached.tasks };
		}
	}

	// FIX: Re-stat and re-read inside a single synchronous block to close the
	// TOCTOU window. We use a sentinel-based re-read: if mtime/size changed
	// between the initial stat and the read, re-read until stable. With file
	// sizes typically small (<5MB), the extra cost is negligible. Note: this
	// doesn't fully prevent torn writes — callers needing strict consistency
	// should use withRunLock() around the whole load+modify+save sequence.
	let attempts = 0;
	let manifest: TeamRunManifest | undefined;
	let tasks: TeamTaskState[] | undefined;
	while (attempts < 3) {
		const freshStat = fs.statSync(manifestPath);
		manifest = readJsonFile<TeamRunManifest>(manifestPath);
		const freshTasksStat = fs.existsSync(tasksPath) ? fs.statSync(tasksPath) : undefined;
		tasks = readJsonFile<TeamTaskState[]>(tasksPath) ?? [];
		// If size/mtime didn't change between stat and read, we're consistent.
		if (freshStat.mtimeMs === manifestStat.mtimeMs && freshStat.size === manifestStat.size
			&& (!freshTasksStat || (freshTasksStat.mtimeMs === tasksStat?.mtimeMs && freshTasksStat.size === tasksStat?.size))) {
			break;
		}
		attempts += 1;
		manifestStat = freshStat;
		tasksStat = freshTasksStat;
	}
	if (!manifest || !validateRunManifestPaths(cwd, runId, manifest, stateRoot, tasksPath)) return undefined;
	setManifestCache(stateRoot, {
		manifest,
		tasks: tasks ?? [],
		manifestMtimeMs: manifestStat.mtimeMs,
		manifestSize: manifestStat.size,
		tasksMtimeMs,
		tasksSize: tasksStat?.size ?? 0,
	});
	return { manifest, tasks: tasks ?? [] };
}

export async function loadRunManifestByIdAsync(cwd: string, runId: string): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined> {
	const stateRoot = resolveRunStateRoot(cwd, runId);
	if (!stateRoot) return undefined;
	const manifestPath = path.join(stateRoot, "manifest.json");
	const tasksPath = path.join(stateRoot, "tasks.json");
	let manifestStat: fs.Stats;
	try {
		manifestStat = await fs.promises.stat(manifestPath);
	} catch {
		return undefined;
	}
	const cached = manifestCache.get(stateRoot);
	let tasksStat: fs.Stats | undefined;
	try {
		tasksStat = await fs.promises.stat(tasksPath);
	} catch {
		tasksStat = undefined;
	}
	const tasksMtimeMs = tasksStat?.mtimeMs ?? 0;
	if (cached && cached.manifestMtimeMs === manifestStat.mtimeMs && cached.manifestSize === manifestStat.size && cached.tasksMtimeMs === tasksMtimeMs && cached.tasksSize === (tasksStat?.size ?? 0)) {
		// TTL eviction: expire stale entries even if mtime matches
		if (cached.cachedAt && Date.now() - cached.cachedAt > MANIFEST_CACHE_TTL_MS) {
			manifestCache.delete(stateRoot);
		} else if (!validateRunManifestPaths(cwd, runId, cached.manifest, stateRoot, tasksPath)) {
			manifestCache.delete(stateRoot);
			return undefined;
		} else {
			return { manifest: cached.manifest, tasks: cached.tasks };
		}
	}
	const manifest = await readJsonFileAsync<TeamRunManifest>(manifestPath);
	if (!manifest || !validateRunManifestPaths(cwd, runId, manifest, stateRoot, tasksPath)) return undefined;
	const tasks = await readJsonFileAsync<TeamTaskState[]>(tasksPath) ?? [];
	setManifestCache(stateRoot, { manifest, tasks, manifestMtimeMs: manifestStat.mtimeMs, manifestSize: manifestStat.size, tasksMtimeMs, tasksSize: tasksStat?.size ?? 0 });
	return { manifest, tasks };
}
