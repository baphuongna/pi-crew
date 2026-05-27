import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { appendEvent, scanSequence } from "../state/event-log.ts";
import { recordFromTask, upsertCrewAgent } from "./crew-agent-records.ts";
import { withRunLockSync } from "../state/locks.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { isWorkerHeartbeatStale } from "./worker-heartbeat.ts";
import type { ManifestCache } from "./manifest-cache.ts";
import { checkProcessLiveness } from "./process-status.ts";
import { reconcileStaleRun, type ReconcileResult } from "./stale-reconciler.ts";
import { executeHook, appendHookEvent } from "../hooks/registry.ts";
import { activeRunEntries, unregisterActiveRun, readActiveRunRegistry } from "../state/active-run-registry.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { terminateLiveAgentsForRun } from "./live-agent-manager.ts";

export interface RecoveryPlan {
	runId: string;
	resumableTasks: string[];
	preservedTasks: string[];
	lastEventSeq: number;
}

function isTerminalTask(task: TeamTaskState): boolean {
	return task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "skipped" || task.status === "needs_attention";
}

function shouldRecoverTask(task: TeamTaskState, deadMs: number): boolean {
	if (task.status !== "running") return false;
	if (!task.heartbeat) return true;
	return task.heartbeat.alive === false || isWorkerHeartbeatStale(task.heartbeat, deadMs);
}

export function detectInterruptedRuns(cwd: string, manifestCache: ManifestCache, deadMs = 300_000): RecoveryPlan[] {
	const plans: RecoveryPlan[] = [];
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running" && manifest.status !== "blocked") continue;
		if (manifest.async?.pid !== undefined && checkProcessLiveness(manifest.async.pid).alive) continue;
		const loaded = loadRunManifestById(cwd, manifest.runId);
		if (!loaded) continue;
		const resumableTasks = loaded.tasks.filter((task) => shouldRecoverTask(task, deadMs)).map((task) => task.id);
		if (!resumableTasks.length) continue;
		plans.push({ runId: manifest.runId, resumableTasks, preservedTasks: loaded.tasks.filter(isTerminalTask).map((task) => task.id), lastEventSeq: scanSequence(loaded.manifest.eventsPath) });
	}
	return plans;
}

export async function applyRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">, registry?: MetricRegistry): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId);
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);

	const hookReport = await executeHook("run_recovery", { runId: plan.runId, cwd: ctx.cwd });
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		appendEvent(loaded.manifest.eventsPath, { type: "crew.run.recovery_blocked", runId: plan.runId, message: `Recovery blocked by hook: ${hookReport.reason ?? "run_recovery hook blocked the operation."}`, data: { hookOutcome: "block", reason: hookReport.reason } });
		return;
	}

	const reset = new Set(plan.resumableTasks);
	const tasks = loaded.tasks.map((task) => reset.has(task.id) ? { ...task, status: "queued" as const, startedAt: undefined, finishedAt: undefined, error: undefined, heartbeat: undefined } : task);
	saveRunTasks(loaded.manifest, tasks);
	appendEvent(loaded.manifest.eventsPath, { type: "crew.run.resumed", runId: plan.runId, message: `Recovered ${plan.resumableTasks.length} interrupted task(s).`, data: { recoveredFromSeq: plan.lastEventSeq, resumableTasks: plan.resumableTasks } });
	registry?.counter("crew.run.count", "Total runs by status").inc({ status: "resumed" });
}

export function declineRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">): void {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId);
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);
	// Log the event first — if appendEvent fails, state remains consistent.
	appendEvent(loaded.manifest.eventsPath, { type: "crew.run.recovery_declined", runId: plan.runId, message: "Interrupted run was not resumed.", data: { recoveredFromSeq: plan.lastEventSeq } });
	updateRunStatus(loaded.manifest, "cancelled", "interrupted-not-resumed");
}

/**
 * Run 3-phase stale reconciliation on all active runs.
 * Returns results for each reconciled run.
 */
/**
 * Auto-cancel orphaned runs whose owner session no longer exists.
 *
 * When a Pi session dies (crash, force-close, Ctrl+C), `session_shutdown`
 * does not fire and child workers are not terminated. The next Pi session
 * must detect these orphaned runs and cancel them.
 *
 * Criteria for orphan detection:
 * 1. Manifest status is "running"
 * 2. Manifest has an `ownerSessionId` that is NOT the current session
 * 3. The owner session's process is no longer alive (PID check)
 * 4. No recent heartbeat activity (task heartbeat or agent progress within threshold)
 *
 * Returns the number of runs cancelled.
 */
export function cancelOrphanedRuns(
	cwd: string,
	manifestCache: ManifestCache,
	currentSessionId: string,
	staleThresholdMs = 300_000,
	now = Date.now(),
): { cancelled: string[]; skipped: string[] } {
	const cancelled: string[] = [];
	const skipped: string[] = [];

	// Phase 1: Scan project-level manifests via manifestCache
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running" && manifest.status !== "blocked") continue;

		// Only consider runs owned by a different session
		const ownerId = manifest.ownerSessionId;
		if (!ownerId || ownerId === currentSessionId) continue;

		// Check if the owner process is still alive
		const ownerPid = manifest.async?.pid;
		if (ownerPid !== undefined && checkProcessLiveness(ownerPid).alive) {
			skipped.push(manifest.runId);
			continue;
		}

		// Check for recent heartbeat activity
		const loaded = loadRunManifestById(cwd, manifest.runId);
		if (!loaded) continue;

		const hasRecentActivity = loaded.tasks.some((task) => {
			if (task.status !== "running" && task.status !== "waiting") return false;
			const heartbeatAt = task.heartbeat?.lastSeenAt ? new Date(task.heartbeat.lastSeenAt).getTime() : Number.NaN;
			if (task.heartbeat?.alive !== false && Number.isFinite(heartbeatAt) && now - heartbeatAt <= staleThresholdMs) return true;
			const activityAt = task.agentProgress?.lastActivityAt ? new Date(task.agentProgress.lastActivityAt).getTime() : Number.NaN;
			return Number.isFinite(activityAt) && now - activityAt <= staleThresholdMs;
		});

		if (hasRecentActivity) {
			skipped.push(manifest.runId);
			continue;
		}

		// Orphan confirmed — mark durable state terminal before best-effort live-agent abort.
		// terminateLiveAgent unregisters handles before awaiting abort(), and live-executor's
		// isCurrent() checks durable terminal state before writing progress.

		// Orphan confirmed — cancel all running tasks
		let cancelledRun = false;
		withRunLockSync(loaded.manifest, () => {
			const fresh = loadRunManifestById(cwd, manifest.runId);
			if (!fresh || (fresh.manifest.status !== "running" && fresh.manifest.status !== "blocked")) return;

			const now_iso = new Date(now).toISOString();
			const repairedTasks = fresh.tasks.map((task) => {
				if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
					return { ...task, status: "cancelled" as const, finishedAt: now_iso, error: `Orphaned run: owner session ${ownerId} no longer exists` };
				}
				return task;
			});

			saveRunTasks(fresh.manifest, repairedTasks);
			for (const task of repairedTasks) { try { upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold")); } catch { /* non-critical */ } }
			updateRunStatus(fresh.manifest, "cancelled", `Orphaned run: owner session ${ownerId} no longer exists`);
			appendEvent(fresh.manifest.eventsPath, { type: "crew.run.orphan_cancelled", runId: manifest.runId, message: `Auto-cancelled orphaned run (owner: ${ownerId})`, data: { ownerSessionId: ownerId, cancelledTasks: repairedTasks.filter((t) => t.status === "cancelled").length } });
			cancelled.push(manifest.runId);
			cancelledRun = true;
		});
		if (cancelledRun) void terminateLiveAgentsForRun(manifest.runId, "cancelled", appendEvent, loaded.manifest.eventsPath).catch(() => {});
	}

	return { cancelled, skipped };
}

/**
 * Purge the global active-run-index of entries whose manifest is no longer active.
 *
 * This scans every entry in active-run-index.json and removes any whose:
 * - manifest file no longer exists, OR
 * - manifest status is terminal (completed/failed/cancelled/blocked), OR
 * - manifest cwd directory no longer exists (e.g. temp test dirs)
 *
 * Also removes entries where the manifest is still "running" but:
 * - The cwd has been deleted (temp dir cleanup)
 * - The async worker PID is dead AND no heartbeat for > threshold
 *
 * This is the **global** cleanup that cancelOrphanedRuns (project-scoped)
 * cannot reach.
 */
/**
 * Best-effort removal of stateRoot and artifactsRoot directories for a purged run.
 * Uses resolveRealContainedPath to ensure we only delete paths that are safely
 * contained within a known crew root (project or user level).
 */
function tryRemoveRunDirectories(entry: { stateRoot: string; cwd: string }): void {
	const roots = [projectCrewRoot(entry.cwd), userCrewRoot()];
	for (const root of roots) {
		try {
			resolveRealContainedPath(root, entry.stateRoot);
			// If we get here, stateRoot is safely contained — remove it
			fs.rmSync(entry.stateRoot, { recursive: true, force: true });
			break;
		} catch {
			// Not contained in this root, try next
		}
	}
	// NOTE: artifactsRoot is shared across runs and cleaned up by pruneFinishedRuns/pruneUserLevelRuns — not deleted here.
}

/**
 * Purge the global active-run-index of entries whose manifest is no longer active.
 *
 * Note: This function only cleans user-level active run entries.
 * Project-level stale runs are handled by session_start auto-prune triggered during run creation.
 */
export function purgeStaleActiveRunIndex(staleThresholdMs = 300_000, now = Date.now()): { purged: string[]; kept: string[] } {
	const purged: string[] = [];
	const kept: string[] = [];
	const entries = readActiveRunRegistry();

	for (const entry of entries) {
		// 1. Manifest file gone → definitely stale
		if (!fs.existsSync(entry.manifestPath)) {
			unregisterActiveRun(entry.runId);
			tryRemoveRunDirectories(entry);
			purged.push(entry.runId);
			continue;
		}

		// 2. CWD gone → temp dir cleaned up
		if (!fs.existsSync(entry.cwd)) {
			unregisterActiveRun(entry.runId);
			tryRemoveRunDirectories(entry);
			purged.push(entry.runId);
			continue;
		}

		// 3. Read manifest status
		let manifest: { status?: string; async?: { pid?: number }; ownerSessionId?: string } | undefined;
		try {
			manifest = JSON.parse(fs.readFileSync(entry.manifestPath, "utf-8"));
		} catch {
			unregisterActiveRun(entry.runId);
			tryRemoveRunDirectories(entry);
			purged.push(entry.runId);
			continue;
		}

		// 4. Terminal status → no longer active (just unregister, don't delete files)
		const terminalStatuses = new Set(["completed", "failed", "cancelled", "blocked"]);
		if (manifest && terminalStatuses.has(manifest.status ?? "")) {
			unregisterActiveRun(entry.runId);
			purged.push(entry.runId);
			continue;
		}

		// 5. Still "running" — check if worker PID is dead and no heartbeat
		if (manifest?.status === "running" && manifest.async?.pid !== undefined) {
			const pidAlive = checkProcessLiveness(manifest.async.pid).alive;
			if (!pidAlive) {
				// Check age — if manifest hasn't been updated in > threshold, it's stale
				const updatedAt = new Date(entry.updatedAt).getTime();
				if (Number.isFinite(updatedAt) && now - updatedAt > staleThresholdMs) {
					// Dead PID + stale update → cancel the manifest and unregister
					try {
						const fullLoaded = loadRunManifestById(entry.cwd, entry.runId);
						if (fullLoaded) {
							const now_iso = new Date(now).toISOString();
							const repairedTasks = fullLoaded.tasks.map((task) => {
								if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
									return { ...task, status: "cancelled" as const, finishedAt: now_iso, error: "Orphaned run: worker process dead and no recent activity" };
								}
								return task;
							});
							saveRunTasks(fullLoaded.manifest, repairedTasks);
							for (const task of repairedTasks) { try { upsertCrewAgent(fullLoaded.manifest, recordFromTask(fullLoaded.manifest, task, "scaffold")); } catch { /* non-critical */ } }
							updateRunStatus(fullLoaded.manifest, "cancelled", "Orphaned run: worker process dead and no recent activity");
							void terminateLiveAgentsForRun(fullLoaded.manifest.runId, "cancelled", appendEvent, fullLoaded.manifest.eventsPath).catch(() => {});
						}
					} catch {
						// Best-effort manifest cleanup
					}
					unregisterActiveRun(entry.runId);
					tryRemoveRunDirectories(entry);
					purged.push(entry.runId);
					continue;
				}
			}
		}

		// 6. "running" but no async worker PID — possible orphaned run where manifest
		// was never updated after worker exit. Check updatedAt age.
		if (manifest?.status === "running" && manifest.async === undefined) {
			const updatedAt = new Date(entry.updatedAt).getTime();
			if (Number.isFinite(updatedAt) && now - updatedAt > staleThresholdMs) {
				try {
					const fullLoaded = loadRunManifestById(entry.cwd, entry.runId);
					if (fullLoaded && fullLoaded.manifest.status === "running") {
						const now_iso = new Date(now).toISOString();
						const repairedTasks = fullLoaded.tasks.map((task) => {
							if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
								return { ...task, status: "cancelled" as const, finishedAt: now_iso, error: "Orphaned run: workflow completed but manifest never updated to terminal status" };
							}
							return task;
						});
						saveRunTasks(fullLoaded.manifest, repairedTasks);
						for (const task of repairedTasks) { try { upsertCrewAgent(fullLoaded.manifest, recordFromTask(fullLoaded.manifest, task, "scaffold")); } catch { /* non-critical */ } }
						updateRunStatus(fullLoaded.manifest, "cancelled", "Orphaned run: no async worker and no manifest update in over " + Math.round(staleThresholdMs / 60000) + " minutes");
						void terminateLiveAgentsForRun(fullLoaded.manifest.runId, "cancelled", appendEvent, fullLoaded.manifest.eventsPath).catch(() => {});
					}
				} catch {
					// Best-effort
				}
				unregisterActiveRun(entry.runId);
				tryRemoveRunDirectories(entry);
				purged.push(entry.runId);
				continue;
			}
		}

		kept.push(entry.runId);
	}

	return { purged, kept };
}

export function reconcileAllStaleRuns(cwd: string, manifestCache: ManifestCache, now = Date.now()): ReconcileResult[] {
	const results: ReconcileResult[] = [];
	for (const manifest of manifestCache.list(50)) {
		if (manifest.status !== "running" && manifest.status !== "blocked") continue;
		const loaded = loadRunManifestById(cwd, manifest.runId);
		if (!loaded) continue;
		// Use lock to prevent race with cancel/status handlers modifying the same run
		withRunLockSync(loaded.manifest, () => {
			// Re-read inside lock to get freshest data
			const fresh = loadRunManifestById(cwd, manifest.runId);
			if (!fresh || (fresh.manifest.status !== "running" && fresh.manifest.status !== "blocked")) return;
			const result = reconcileStaleRun(fresh.manifest, fresh.tasks, now);
			if (result.repaired || result.verdict === "result_exists") {
				if (result.repairedTasks) {
				saveRunTasks(fresh.manifest, result.repairedTasks);
				for (const task of result.repairedTasks) { try { upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold")); } catch { /* non-critical */ } }
			}
				updateRunStatus(fresh.manifest, "failed", `Stale run reconciled: ${result.detail}`);
				void terminateLiveAgentsForRun(fresh.manifest.runId, "failed", appendEvent, fresh.manifest.eventsPath).catch(() => {});
				appendEvent(fresh.manifest.eventsPath, { type: "crew.run.reconciled_stale", runId: manifest.runId, message: result.detail, data: { verdict: result.verdict } });
			}
			if (result.verdict !== "healthy") {
				results.push(result);
			}
		});
	}
	return results;
}
