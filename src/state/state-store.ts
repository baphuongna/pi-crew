import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DEFAULT_CACHE, DEFAULT_PATHS } from "../config/defaults.ts";
import { errors } from "../errors.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import { createRunId, createTaskId } from "../utils/ids.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { findRepoRoot, projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { assertSafePathId, resolveContainedRelativePath, resolveRealContainedPath } from "../utils/safe-paths.ts";
import { toPiSessionId } from "../utils/session-utils.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import { unregisterActiveRun } from "./active-run-registry.ts";
import { atomicWriteJson, atomicWriteJsonAsync, atomicWriteJsonCoalesced, flushPendingAtomicWrites, readJsonFile } from "./atomic-write.ts";
import { canTransitionRunStatus } from "./contracts.ts";
import { appendEvent } from "./event-log.ts";
import { HealthStore } from "./health-store.ts";
import { withRunLock, withRunLockSync } from "./locks.ts";
import type { TeamRunManifest, TeamTaskState } from "./types.ts";

/**
 * stat() the manifest with a brief retry on Windows for the AV-scan window.
 *
 * On the GitHub Actions windows-latest runner, Windows Defender real-time
 * scanning can make a freshly-written manifest.json briefly invisible to
 * statSync (ENOENT) even though the write succeeded and the file is on disk.
 * loadRunManifestById is called right after createRunManifest in tests and in
 * production (e.g. refreshPersistedSubagentRecord), so without a retry the
 * caller sees a phantom "missing" run.
 *
 * On non-Windows, ENOENT means the file genuinely doesn't exist — passthrough
 * (throw immediately) with no retry. On Windows, ENOENT/EPERM/EBUSY/EAGAIN get
 * a handful of short retries (~30ms worst case) before giving up and throwing
 * so the caller's catch returns undefined as before.
 */
function statManifestWithWindowsRetry(manifestPath: string): fs.Stats {
	if (process.platform !== "win32") return fs.statSync(manifestPath);
	const retryable = new Set(["ENOENT", "EPERM", "EBUSY", "EAGAIN"]);
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return fs.statSync(manifestPath);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (!retryable.has(code ?? "")) throw error;
			const end = Date.now() + Math.min(8, 1 * 2 ** attempt);
			while (Date.now() < end) {
				/* brief spin to ride out the AV scan window */
			}
		}
	}
	return fs.statSync(manifestPath); // last attempt — let caller's catch handle ENOENT
}

export interface RunPaths {
	runId: string;
	stateRoot: string;
	artifactsRoot: string;
	manifestPath: string;
	tasksPath: string;
	eventsPath: string;
}

export interface ManifestCacheEntry {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	manifestMtimeMs: number;
	manifestSize: number;
	tasksMtimeMs: number;
	tasksSize: number;
	cachedAt?: number;
	generation?: number;
}

// F1: per-stateRoot generation counter. The previous global counter was
// incremented on every `invalidateRunCache` call regardless of which state's
// cache was invalidated, so a write to run A caused a hot-path miss in run B's
// cache even though B's on-disk files were untouched. With per-stateRoot
// generations, run B only misses its own cache when its own writes happen.
// NOTE: This generation counter is process-local. Cross-process consistency
// (e.g., parent + child processes writing to the same run) relies on the
// mtime/size checks in loadRunManifestById, not on this counter.
const manifestCacheGeneration = new Map<string, number>();
function genOf(stateRoot: string): number {
	return manifestCacheGeneration.get(stateRoot) ?? 0;
}

const MANIFEST_CACHE_TTL_MS = 60 * 1000; // 60 seconds (FIX: increased from 15s for read-heavy workloads; render tick 160ms caused frequent misses)
const LOAD_MANIFEST_RETRY_LIMIT = 5; // Configurable retry limit for mtime/size stability checks under contention
const manifestCache = new Map<string, ManifestCacheEntry>();

/** @internal — exported for TTL-eviction unit testing (Round 19). */
export function __test__setManifestCache(stateRoot: string, entry: ManifestCacheEntry): void {
	setManifestCache(stateRoot, entry);
}

/** @internal — exported for TTL-eviction unit testing (Round 19). */
export function __test__getManifestCacheEntry(stateRoot: string): ManifestCacheEntry | undefined {
	return manifestCache.get(stateRoot);
}

/** @internal — the TTL in ms used for manifest cache eviction. */
export const MANIFEST_CACHE_TTL_MS_VALUE = MANIFEST_CACHE_TTL_MS;

function setManifestCache(stateRoot: string, entry: ManifestCacheEntry): void {
	if (manifestCache.has(stateRoot)) manifestCache.delete(stateRoot);
	entry.cachedAt = Date.now();
	// Stamp with the *current* per-root generation so a concurrent writer's
	// increment between read and write invalidates this cache hit.
	entry.generation = genOf(stateRoot);
	// FIX: Evict all stale entries by TTL before adding new entry.
	// This ensures entries that are never accessed still get evicted
	// based on TTL, not just entries that are hit.
	const now = Date.now();
	for (const [key, val] of manifestCache.entries()) {
		if (val.cachedAt && now - val.cachedAt > MANIFEST_CACHE_TTL_MS) {
			manifestCache.delete(key);
		}
	}
	manifestCache.set(stateRoot, entry);
	while (manifestCache.size > DEFAULT_CACHE.manifestMaxEntries) {
		// FIX: Evict oldest entry by cachedAt (LRU), not insertion order.
		// cachedAt is set on both initial insertion and cache hits, so
		// frequently accessed entries bubble to the end and survive longer.
		let oldestKey: string | undefined;
		let oldestTime = Infinity;
		for (const [key, val] of manifestCache.entries()) {
			const t = val.cachedAt ?? 0;
			if (t < oldestTime) {
				oldestTime = t;
				oldestKey = key;
			}
		}
		if (!oldestKey) break;
		manifestCache.delete(oldestKey);
	}
}

function useProjectState(cwd: string): boolean {
	return findRepoRoot(cwd) !== undefined;
}

function invalidateRunCache(stateRoot: string): void {
	manifestCache.delete(stateRoot);
	// F1: only bump the generation of THIS stateRoot — sibling runs keep their
	// generation intact, so concurrent writes to run A no longer evict run B's
	// hot cache.
	manifestCacheGeneration.set(stateRoot, genOf(stateRoot) + 1);
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
	// Issue 2 fix: Reject manifests missing status field to prevent undefined
	// behavior in callers like canTransitionRunStatus(manifest.status, newStatus).
	if (!manifest.status || typeof manifest.status !== "string") return false;
	if (
		manifest.runId !== runId ||
		manifest.stateRoot !== stateRoot ||
		manifest.tasksPath !== tasksPath ||
		manifest.eventsPath !== path.join(stateRoot, "events.jsonl")
	)
		return false;
	const artifactsParent = path.join(scopeBaseRoot(cwd), DEFAULT_PATHS.state.artifactsSubdir);
	const expectedArtifactsRoot = resolveContainedRelativePath(artifactsParent, runId, "runId");
	if (manifest.artifactsRoot !== expectedArtifactsRoot) return false;
	// Always validate artifactsRoot is not a symlink, even when manifest has
	// no artifacts entries. A symlinked artifactsRoot pointing outside the
	// artifacts parent is a security violation (could write to attacker-
	// controlled locations). This check catches the case where the run was
	// created legitimately but the artifactsRoot was later replaced with a
	// symlink between manifest creation and load.
	if (fs.existsSync(expectedArtifactsRoot)) {
		try {
			if (fs.lstatSync(expectedArtifactsRoot).isSymbolicLink()) return false;
			resolveRealContainedPath(artifactsParent, runId);
		} catch {
			return false;
		}
	} else if (manifest.artifacts && manifest.artifacts.length > 0) {
		// Has artifacts entries but directory doesn't exist - benign state for
		// runs still in progress.
		return true;
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
		const children = workflow.steps
			.filter((candidate) => candidate.dependsOn?.includes(step.id))
			.map((candidate) => stepToTaskId.get(candidate.id))
			.filter((childId): childId is string => childId !== undefined);
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
	runKind?: "team-run" | "goal-loop" | "dynamic-workflow";
	/** round-14 P1-5: typed workflow arguments for .dwf.ts scripts (ctx.args<T>()). */
	args?: unknown;
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
		runKind: params.runKind ?? "team-run",
		...(params.args !== undefined ? { args: params.args } : {}),
	};
	fs.mkdirSync(paths.stateRoot, { recursive: true });
	fs.mkdirSync(paths.artifactsRoot, { recursive: true });
	// FIX: Use saveManifestAndTasksAtomicSync and check result to detect
	// partial failure. If tasksWritten=false when manifestWritten=true,
	// throw to ensure manifest and tasks are always consistent.
	const result = saveManifestAndTasksAtomicSync(manifest, tasks);
	if (!result.manifestWritten || !result.tasksWritten) {
		// Surface the underlying error message (result.error is String(err) from
		// saveManifestAndTasksAtomicSync). Passing it through errors.fileWrite as a
		// fake ErrnoException loses the message (reads .code → undefined →
		// "unknown"). Include it explicitly in the thrown message so CI logs and
		// production callers can see WHY the write failed instead of ": unknown".
		const cause = result.error ? `: ${result.error}` : "";
		throw errors
			.fileWrite(paths.stateRoot, {
				code: "EWRITEFAIL",
			} as NodeJS.ErrnoException)
			.withContext(
				`saveManifestAndTasksAtomicSync: manifestWritten=${result.manifestWritten}, tasksWritten=${result.tasksWritten}${cause}`,
			);
	}
	appendEvent(paths.eventsPath, {
		type: "run.created",
		runId: paths.runId,
		data: { team: params.team.name, workflow: params.workflow?.name },
		metadata: {
			seq: 1,
			provenance: "team_runner",
			sessionIdentity: {
				title: params.team.name,
				workspace: params.cwd,
				purpose: params.goal,
			},
			ownership: {
				owner: params.team.name,
				workflowScope: params.workflow?.name ?? "manual",
				watcherAction: "act",
			},
			confidence: "high",
		},
	});
	invalidateRunCache(paths.stateRoot);
	return { manifest, tasks, paths };
}

export function saveRunManifest(manifest: TeamRunManifest): void {
	// FIX: Capture the cached tasks array + mtime/size BEFORE we invalidate the
	// cache. The previous implementation re-read tasks.json from disk after the
	// manifest write (a JSON.parse + fs.readFileSync per call), which defeated
	// the whole point of the manifest cache on the hot update path. Reusing the
	// already-cached entry is safe because:
	//   1. The cache entry's tasks array matches the tasks array reflected by
	//      its tasksMtimeMs/tasksSize — the three values move together.
	//   2. After invalidate, saveRunTasks (or any other writer) would bump the
	//      per-stateRoot generation, so a stale cache hit cannot serve.
	//   3. On cache miss, we fall back to tasks: [] with mtime/size 0 — the same
	//      shape the original pre-FIX code produced — so behavior is unchanged.
	const cachedBeforeInvalidate = manifestCache.get(manifest.stateRoot);
	const cachedTasks = cachedBeforeInvalidate?.tasks ?? [];
	const cachedTasksMtimeMs = cachedBeforeInvalidate?.tasksMtimeMs ?? 0;
	const cachedTasksSize = cachedBeforeInvalidate?.tasksSize ?? 0;
	// FIX: Invalidate cache BEFORE atomic write. The order matters for crash
	// safety: if we invalidated after the write and crashed before invalidation,
	// the stale cache entry (up to MANIFEST_CACHE_TTL_MS old) could be served.
	// By invalidating first, the worst case is a cache miss forcing a disk read,
	// which is always safe.
	invalidateRunCache(manifest.stateRoot);
	const manifestPath = path.join(manifest.stateRoot, "manifest.json");
	atomicWriteJson(manifestPath, manifest);
	// FIX: Re-populate cache with actual mtime/size so loadRunManifestById
	// doesn't miss the cache on next read. Without this, every load until
	// TTL expires would hit disk because cached 0 !== any real mtime.
	// NOTE: tasks is reused from the pre-invalidate cache snapshot above; if no
	// cache existed, tasks is [] (matching pre-FIX behavior). Callers that need
	// fresh tasks should call saveRunTasks or loadRunTasks separately.
	const manifestStat = fs.statSync(manifestPath);
	setManifestCache(manifest.stateRoot, {
		manifest,
		tasks: cachedTasks,
		manifestMtimeMs: manifestStat.mtimeMs,
		manifestSize: manifestStat.size,
		tasksMtimeMs: cachedTasksMtimeMs,
		tasksSize: cachedTasksSize,
	});
}

export async function saveRunManifestAsync(manifest: TeamRunManifest): Promise<void> {
	// FIX: Capture cached tasks array + mtime/size BEFORE invalidating, same
	// rationale as the sync saveRunManifest above. The async path previously
	// always set tasks: [] with mtime/size 0, so any cache hit was guaranteed
	// to look stale to loadRunManifestById until something else wrote tasks.json.
	const cachedBeforeInvalidate = manifestCache.get(manifest.stateRoot);
	const cachedTasks = cachedBeforeInvalidate?.tasks ?? [];
	const cachedTasksMtimeMs = cachedBeforeInvalidate?.tasksMtimeMs ?? 0;
	const cachedTasksSize = cachedBeforeInvalidate?.tasksSize ?? 0;
	// FIX: Invalidate cache BEFORE atomic write to prevent stale cache serving
	// after a crash. See saveRunManifest for full explanation.
	invalidateRunCache(manifest.stateRoot);
	const manifestPath = path.join(manifest.stateRoot, "manifest.json");
	await atomicWriteJsonAsync(manifestPath, manifest);
	// FIX: Re-populate cache with actual mtime/size. See saveRunManifest.
	const manifestStat = await fs.promises.stat(manifestPath);
	setManifestCache(manifest.stateRoot, {
		manifest,
		tasks: cachedTasks,
		manifestMtimeMs: manifestStat.mtimeMs,
		manifestSize: manifestStat.size,
		tasksMtimeMs: cachedTasksMtimeMs,
		tasksSize: cachedTasksSize,
	});
}

export function saveRunTasks(manifest: TeamRunManifest, tasks: TeamTaskState[]): void {
	// FIX: Invalidate cache BEFORE atomic write to prevent stale cache serving.
	invalidateRunCache(manifest.stateRoot);

	// Guard: if the run state directory has been removed (prune/forget/cleanup),
	// silently return — there is nothing to persist and the run is gone.
	try {
		fs.statSync(manifest.stateRoot);
	} catch {
		return;
	}

	atomicWriteJson(manifest.tasksPath, tasks);
	// FIX: Re-populate cache with actual mtime/size for manifest and tasks.
	// Note: We re-read manifest from disk to get its current mtime/size
	// since we only wrote tasks here.
	const manifestPath = path.join(manifest.stateRoot, "manifest.json");
	let manifestStat: fs.Stats;
	let tasksStat: fs.Stats;
	try {
		manifestStat = fs.statSync(manifestPath);
		tasksStat = fs.statSync(manifest.tasksPath);
	} catch {
		// Run state disappeared between the guard above and now — give up gracefully.
		return;
	}
	// FIX: If cache was evicted, re-read manifest from disk rather than using
	// a minimal fallback. A stale minimal manifest with only runId populated
	// would cause manifest.status to be undefined, breaking status checks.
	// If the manifest cannot be read, throw an error — callers using withRunLock
	// should never hit this case, and the error indicates a serious problem.
	// FIX: Also check that the re-read manifest has a status field. If not,
	// fall back to the manifest parameter's status rather than serving a
	// degraded manifest that would break status transition checks.
	const cached = manifestCache.get(manifest.stateRoot);
	const manifestEntry = cached?.manifest ?? readJsonFile<TeamRunManifest>(manifestPath);
	if (!manifestEntry) {
		return; // Run deleted between guard and read
	}
	// Preserve current status from the manifest parameter if the on-disk
	// manifest is missing it (could be a partial write).
	if (!manifestEntry.status) {
		manifestEntry.status = manifest.status;
	}
	setManifestCache(manifest.stateRoot, {
		manifest: manifestEntry,
		tasks,
		manifestMtimeMs: manifestStat.mtimeMs,
		manifestSize: manifestStat.size,
		tasksMtimeMs: tasksStat.mtimeMs,
		tasksSize: tasksStat.size,
	});
}

/**
 * 2.1 caller-migration helper: coalesced variant. Use only when the
 * caller does NOT immediately read tasks.json afterwards (the read would
 * see the previous on-disk content while the write is still buffered).
 * Bulk update paths that fan out into multiple writer call sites are the
 * intended use case. Single-update + read-update loops (e.g.
 * persistSingleTaskUpdate) should keep using saveRunTasks — OR call
 * `flushPendingAtomicWrites()` immediately before their read to force
 * any pending coalesced writes to land on disk first.
 *
 * (perf review 2026-07 F4) — now used by persistSingleTaskUpdate's
 * non-terminal checkpoint path; that caller calls flushPendingAtomicWrites()
 * before its read-modify-write load to defeat the stale-read window.
 */
/** @internal */
export function saveRunTasksCoalesced(manifest: TeamRunManifest, tasks: TeamTaskState[]): void {
	// FIX: Invalidate cache BEFORE atomic write to prevent stale cache serving.
	invalidateRunCache(manifest.stateRoot);
	try {
		fs.statSync(manifest.stateRoot);
	} catch {
		return;
	}
	atomicWriteJsonCoalesced(manifest.tasksPath, tasks);
}

export async function saveRunTasksAsync(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<void> {
	// FIX: Invalidate cache BEFORE atomic write to prevent stale cache serving.
	invalidateRunCache(manifest.stateRoot);
	try {
		await fsp.access(manifest.stateRoot);
	} catch {
		return;
	}
	await atomicWriteJsonAsync(manifest.tasksPath, tasks);
}

/**
 * Save manifest and tasks files with individual atomic writes.
 * FIX: Changed from Promise.all (parallel, non-jointly-atomic) to sequential
 * writes to ensure manifest is written before tasks. A crash between writes
 * leaves them in a known state (manifest is older, tasks is newer) which
 * loadRunManifestById's retry loop can detect via mtime comparison.
 * NOTE: There is no stale-reconciler component — the retry loop provides
 * best-effort detection of mid-write crashes by re-reading until mtime/size
 * are stable. For strict atomicity, callers should use withRunLock().
 * FIX: Returns a result object so callers know which write step failed.
 * If manifest write succeeds but tasks write fails, the caller can recover.
 */
/** @internal */
interface SaveManifestAndTasksResult {
	manifestWritten: boolean;
	tasksWritten: boolean;
	error?: string;
}

async function saveManifestAndTasksAtomic(manifest: TeamRunManifest, tasks: TeamTaskState[]): Promise<SaveManifestAndTasksResult> {
	let manifestWritten = false;
	let tasksWritten = false;
	try {
		await withRunLock(manifest, async () => {
			// FIX: Invalidate cache BEFORE writes to prevent stale cache serving.
			// Sequential writes instead of Promise.all to ensure manifest is
			// written before tasks. If a crash occurs between writes, manifest is
			// the older timestamp which stale-reconciler uses to detect inconsistency.
			invalidateRunCache(manifest.stateRoot);
			await atomicWriteJsonAsync(path.join(manifest.stateRoot, "manifest.json"), manifest);
			manifestWritten = true;
			await atomicWriteJsonAsync(manifest.tasksPath, tasks);
			tasksWritten = true;
		});
	} catch (err) {
		return {
			manifestWritten,
			tasksWritten,
			// FIX: Use String(err) to safely convert any thrown value (Error,
			// string, number, null, undefined) to a string. err.message would be
			// undefined for non-Error throwables, losing useful context.
			error: String(err),
		};
	}
	return { manifestWritten: true, tasksWritten: true };
}

/** @internal */
function saveManifestAndTasksAtomicSync(manifest: TeamRunManifest, tasks: TeamTaskState[]): SaveManifestAndTasksResult {
	let manifestWritten = false;
	let tasksWritten = false;
	try {
		withRunLockSync(manifest, () => {
			// FIX: Invalidate cache BEFORE writes to prevent stale cache serving.
			invalidateRunCache(manifest.stateRoot);
			atomicWriteJson(path.join(manifest.stateRoot, "manifest.json"), manifest);
			manifestWritten = true;
			atomicWriteJson(manifest.tasksPath, tasks);
			tasksWritten = true;
		});
	} catch (err) {
		return {
			manifestWritten,
			tasksWritten,
			// FIX: Use String(err) to safely convert any thrown value (Error,
			// string, number, null, undefined) to a string. err.message would be
			// undefined for non-Error throwables, losing useful context.
			error: String(err),
		};
	}
	return { manifestWritten: true, tasksWritten: true };
}

export interface UpdateRunStatusOptions {
	data?: Record<string, unknown>;
	metadata?: Parameters<typeof appendEvent>[1]["metadata"];
}

export function updateRunStatus(
	manifest: TeamRunManifest,
	status: TeamRunManifest["status"],
	summary?: string,
	options: UpdateRunStatusOptions = {},
): TeamRunManifest {
	if (!canTransitionRunStatus(manifest.status, status)) {
		throw errors.invalidStatusTransition(manifest.status, status);
	}
	const updated: TeamRunManifest = {
		...manifest,
		status,
		updatedAt: new Date().toISOString(),
		summary: summary ?? manifest.summary,
	};
	saveRunManifest(updated);
	// Unregister from active-run-index when run reaches a terminal status.
	// Without this, stale entries accumulate (e.g. integration tests in /tmp) and
	// Pi UI shows ghost "queued" runs that are actually completed/failed/cancelled.
	// Note: "blocked" is excluded because blocked runs can be unblocked later.
	if (status === "completed" || status === "failed" || status === "cancelled") {
		try {
			unregisterActiveRun(updated.runId);
		} catch {
			/* non-critical */
		}
	}
	appendEvent(updated.eventsPath, {
		type: `run.${status}`,
		runId: updated.runId,
		message: summary,
		...(options.data ? { data: options.data } : {}),
		metadata: {
			provenance: "team_runner",
			sessionIdentity: {
				title: updated.team,
				workspace: updated.cwd,
				purpose: updated.goal,
			},
			ownership: {
				owner: updated.team,
				workflowScope: updated.workflow ?? "manual",
				watcherAction: "act",
			},
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

/**
 * OPT-08 additive helper: drop the manifest cache entry for `stateRoot` after
 * flushing any pending coalesced atomic writes (process-wide). Forces the next
 * `loadRunManifestById` / `loadRunManifestByIdAsync` for this run to hit disk
 * instead of serving a possibly-stale cache hit. Idempotent: safe to call
 * multiple times, including for unknown stateRoots.
 *
 * This is an additive helper ONLY — it does NOT replace the load-bearing CAS
 * loop in `persistSingleTaskUpdate`, nor does it bypass `withRunLock` /
 * `fs.statSync`-based invalidation. It is a safe exit hatch for callers that
 * want a guaranteed cache drop (e.g. cleanup paths, end-of-run shutdown).
 *
 * Scope note: `flushPendingAtomicWrites()` flushes ALL pending coalesced
 * writes process-wide, not just those under `stateRoot`. The coalescer has no
 * per-stateRoot filter; flushing the whole queue is the simplest correct
 * behavior and matches the existing `flushPendingAtomicWrites()` contract
 * used by cleanupRuntime / process exit handlers.
 */
export async function unloadRun(stateRoot: string): Promise<void> {
	// Flush first so any in-flight buffered write lands on disk before we drop
	// the cache entry. Otherwise a coalesced write could fire AFTER unloadRun
	// returns, re-populate the cache from disk, and re-stale it.
	flushPendingAtomicWrites();
	// invalidateRunCache bumps the per-stateRoot generation counter so even if
	// some in-process reader has a stale reference, the next cache lookup
	// misses (generation mismatch) and re-reads from disk.
	invalidateRunCache(stateRoot);
}

/**
 * OPT-08 additive helper: read-only inspection of the manifest cache.
 * Returns current size, configured limits, and per-stateRoot observability
 * (cache generation + age in ms). Pure read — never mutates cache state.
 * Useful for `tests`, dashboards, and pre-shutdown sanity checks.
 */
export interface ManifestCacheStats {
	size: number;
	maxEntries: number;
	ttlMs: number;
	perStateRoot: Record<string, { generation: number; ageMs: number }>;
}

export function getManifestCacheStats(): ManifestCacheStats {
	const now = Date.now();
	const perStateRoot: Record<string, { generation: number; ageMs: number }> = {};
	for (const [stateRoot, entry] of manifestCache.entries()) {
		perStateRoot[stateRoot] = {
			generation: entry.generation ?? genOf(stateRoot),
			// ageMs is 0 when cachedAt is unset (defensive — setManifestCache
			// always sets it today, but a future regression would otherwise
			// surface as `undefined` in the stats object).
			ageMs: entry.cachedAt ? now - entry.cachedAt : 0,
		};
	}
	return {
		size: manifestCache.size,
		maxEntries: DEFAULT_CACHE.manifestMaxEntries,
		ttlMs: MANIFEST_CACHE_TTL_MS,
		perStateRoot,
	};
}

async function readJsonFileAsync<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(filePath, "utf-8")) as T;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" && code !== "ENOTDIR") {
			logInternalError("readJsonFileAsync", err, `filePath=${filePath}`);
		}
		return undefined;
	}
}

/**
 * Load a run manifest and its tasks by runId.
 * WARNING: This function provides best-effort consistency only. The sentinel-based
 * retry loop does NOT guarantee manifest/tasks consistency under contention —
 * a concurrent writer can complete a full write cycle between the final stat
 * and the read. For strict consistency, callers MUST wrap load+modify+save in
 * withRunLock(). Callers that need guaranteed consistency should use the lock.
 */
export function loadRunManifestById(cwd: string, runId: string): { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined {
	const stateRoot = resolveRunStateRoot(cwd, runId);
	if (!stateRoot) return undefined;
	const manifestPath = path.join(stateRoot, "manifest.json");
	const tasksPath = path.join(stateRoot, "tasks.json");

	let manifestStat: fs.Stats;
	try {
		manifestStat = statManifestWithWindowsRetry(manifestPath);
	} catch {
		return undefined;
	}
	const cached = manifestCache.get(stateRoot);
	// Issue 1 fix: Note that the cache read-check-use sequence below is NOT atomic
	// under concurrent modification. While individual JS Map operations are atomic,
	// the sequence spanning multiple filesystem operations is not atomic. Callers MUST
	// NOT invoke loadRunManifestById concurrently with cache-modifying operations
	// (setManifestCache, invalidateRunCache) for the same stateRoot. The generation
	// counter provides some protection, but does not make the read-check-use atomic.
	let tasksStat: fs.Stats | undefined;
	try {
		tasksStat = fs.statSync(tasksPath);
	} catch {
		tasksStat = undefined;
	}
	const tasksMtimeMs = tasksStat?.mtimeMs ?? 0;
	if (
		cached &&
		cached.manifestMtimeMs === manifestStat.mtimeMs &&
		cached.manifestSize === manifestStat.size &&
		cached.tasksMtimeMs === tasksMtimeMs &&
		cached.tasksSize === (tasksStat?.size ?? 0) &&
		cached.generation === genOf(stateRoot)
	) {
		// TTL eviction: expire stale entries even if mtime matches
		// FIX: Also evict entries where cachedAt is undefined — such entries are
		// effectively immortal otherwise (the `cached.cachedAt &&` check would skip
		// them every time). This can happen if a cache entry was created by
		// setManifestCache that didn't set cachedAt (shouldn't happen in current
		// code, but defensive against future regressions).
		if (!cached.cachedAt || Date.now() - cached.cachedAt > MANIFEST_CACHE_TTL_MS) {
			manifestCache.delete(stateRoot);
		} else if (!validateRunManifestPaths(cwd, runId, cached.manifest, stateRoot, tasksPath)) {
			manifestCache.delete(stateRoot);
			return undefined;
		} else if (!fs.existsSync(tasksPath)) {
			// Tasks file was deleted after cache was populated — this is a cache miss,
			// not a manifest inconsistency. The cache check passes because
			// tasksMtimeMs=0 and tasksSize=0 match a cache entry written when tasks.json
			// didn't exist. We fall through to the retry loop which will correctly
			// detect the missing file and return undefined. The alternative (treating
			// this as an inconsistency) would require failing the cache hit path, which
			// is unnecessary since the retry loop handles it correctly anyway.
			manifestCache.delete(stateRoot);
			return undefined;
		} else {
			return { manifest: cached.manifest, tasks: cached.tasks ?? [] };
		}
	}

	// FIX: Sentinel-based retry loop for best-effort consistency. Re-stat and
	// re-read until mtime/size are stable. The retry limit is now configurable
	// via LOAD_MANIFEST_RETRY_LIMIT (was hardcoded 3). High contention can still
	// cause non-convergence — for strict consistency, callers MUST use withRunLock().
	// Issue 3 fix: Made retry limit configurable instead of hardcoded 3.
	let attempts = 0;
	let manifest: TeamRunManifest | undefined;
	let tasks: TeamTaskState[] | undefined;
	while (attempts < LOAD_MANIFEST_RETRY_LIMIT) {
		const freshStat = fs.statSync(manifestPath);
		manifest = readJsonFile<TeamRunManifest>(manifestPath);
		const freshTasksStat = fs.existsSync(tasksPath) ? fs.statSync(tasksPath) : undefined;
		tasks = readJsonFile<TeamTaskState[]>(tasksPath) ?? [];
		// If size/mtime didn't change between stat and read, we're consistent.
		if (
			freshStat.mtimeMs === manifestStat.mtimeMs &&
			freshStat.size === manifestStat.size &&
			(!freshTasksStat || (freshTasksStat.mtimeMs === tasksStat?.mtimeMs && freshTasksStat.size === tasksStat?.size))
		) {
			break;
		}
		attempts += 1;
		manifestStat = freshStat;
		tasksStat = freshTasksStat;
	}
	// WARNING: Best-effort consistency only — retry loop detected mtime/size
	// instability. A concurrent writer can still complete a full write cycle
	// between the final stat and the read. Callers needing strict consistency
	// MUST use withRunLock() around load+modify+save.
	if (attempts > 0) {
		// Round 19: downgrade to debug — retry-loop instability is expected under
		// concurrent writes (live team runs constantly append to tasks.json).
		// This is best-effort by design; strict consistency requires withRunLock().
		console.debug(
			`[state-store] loadRunManifestById: retry loop detected instability for run ${runId} after ${attempts} attempt(s) — best-effort only, use withRunLock() for strict consistency`,
		);
	}
	// NOTE: manifest mtime may legitimately be >= tasks mtime because
	// saveManifestAndTasksAtomicSync writes manifest before tasks. However,
	// if a crash occurs AFTER tasks is written but BEFORE manifest is written,
	// tasks mtime would be > manifest mtime (the opposite). The retry loop
	// above detects this crash state by re-reading until mtime/size are stable
	// — the final stable state is what gets used. Because the retry loop
	// handles the crash case, we do NOT fail based on this comparison alone.
	// It does not indicate corruption on its own.
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

export async function loadRunManifestByIdAsync(
	cwd: string,
	runId: string,
): Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined> {
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
	// Issue 1 fix: Note that the cache read-check-use sequence below is NOT atomic
	// under concurrent modification. Same as sync version — see loadRunManifestById.
	let tasksStat: fs.Stats | undefined;
	try {
		tasksStat = await fs.promises.stat(tasksPath);
	} catch {
		tasksStat = undefined;
	}
	const tasksMtimeMs = tasksStat?.mtimeMs ?? 0;
	if (
		cached &&
		cached.manifestMtimeMs === manifestStat.mtimeMs &&
		cached.manifestSize === manifestStat.size &&
		cached.tasksMtimeMs === tasksMtimeMs &&
		cached.tasksSize === (tasksStat?.size ?? 0) &&
		cached.generation === genOf(stateRoot)
	) {
		// TTL eviction: expire stale entries even if mtime matches
		// FIX: Also evict entries where cachedAt is undefined — such entries are
		// effectively immortal otherwise (the `cached.cachedAt &&` check would skip
		// them every time). This can happen if a cache entry was created by
		// setManifestCache that didn't set cachedAt (shouldn't happen in current
		// code, but defensive against future regressions).
		if (!cached.cachedAt || Date.now() - cached.cachedAt > MANIFEST_CACHE_TTL_MS) {
			manifestCache.delete(stateRoot);
		} else if (!validateRunManifestPaths(cwd, runId, cached.manifest, stateRoot, tasksPath)) {
			manifestCache.delete(stateRoot);
			return undefined;
		} else if (
			!(await fsp.access(tasksPath).then(
				() => true,
				() => false,
			))
		) {
			// Tasks file was deleted after cache was populated — do not serve stale cache.
			manifestCache.delete(stateRoot);
			return undefined;
		} else {
			return { manifest: cached.manifest, tasks: cached.tasks ?? [] };
		}
	}

	// FIX: Sentinel-based retry loop to close TOCTOU window between stat and read.
	// Matches the pattern used in the sync loadRunManifestById.
	// Issue 3 fix: Made retry limit configurable instead of hardcoded 3.
	let manifest: TeamRunManifest | undefined;
	let tasks: TeamTaskState[] | undefined;
	let attempts = 0;
	while (attempts < LOAD_MANIFEST_RETRY_LIMIT) {
		const freshStat = await fs.promises.stat(manifestPath);
		manifest = await readJsonFileAsync<TeamRunManifest>(manifestPath);
		const freshTasksStat = await fs.promises.stat(tasksPath).catch(() => undefined);
		tasks = (await readJsonFileAsync<TeamTaskState[]>(tasksPath)) ?? [];
		// If size/mtime didn't change between stat and read, we're consistent.
		if (
			freshStat.mtimeMs === manifestStat.mtimeMs &&
			freshStat.size === manifestStat.size &&
			(!freshTasksStat || (freshTasksStat.mtimeMs === tasksStat?.mtimeMs && freshTasksStat.size === tasksStat?.size))
		) {
			break;
		}
		attempts += 1;
		manifestStat = freshStat;
		tasksStat = freshTasksStat;
	}
	// WARNING: Best-effort consistency only — retry loop detected mtime/size
	// instability. A concurrent writer can still complete a full write cycle
	// between the final stat and the read. Callers needing strict consistency
	// MUST use withRunLock() around load+modify+save.
	if (attempts > 0) {
		// Round 19: downgrade to debug — retry-loop instability is expected under
		// concurrent writes (live team runs constantly append to tasks.json).
		// This is best-effort by design; strict consistency requires withRunLock().
		console.debug(
			`[state-store] loadRunManifestByIdAsync: retry loop detected instability for run ${runId} after ${attempts} attempt(s) — best-effort only, use withRunLock() for strict consistency`,
		);
	}
	// NOTE: manifest mtime may legitimately be >= tasks mtime because
	// saveManifestAndTasksAtomicSync writes manifest before tasks. However,
	// if a crash occurs AFTER tasks is written but BEFORE manifest is written,
	// tasks mtime would be > manifest mtime (the opposite). The retry loop
	// above detects this crash state by re-reading until mtime/size are stable
	// — the final stable state is what gets used. Because the retry loop
	// handles the crash case, we do NOT fail based on this comparison alone.
	// It does not indicate corruption on its own.

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
