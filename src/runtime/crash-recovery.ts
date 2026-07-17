import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendHookEvent, executeHook } from "../hooks/registry.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
import { readActiveRunRegistry, unregisterActiveRun } from "../state/active-run-registry.ts";
import { appendEvent, scanSequence } from "../state/event-log.ts";
import { withRunLockSync } from "../state/locks.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../state/state-store.ts";
import type { TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import { recordFromTask, upsertCrewAgent } from "./crew-agent-records.ts";
import { terminateLiveAgentsForRun } from "./live-agent-manager.ts";
import type { ManifestCache } from "./manifest-cache.ts";
import { checkProcessLiveness } from "./process-status.ts";
import { isPlanApprovalPending, type ReconcileResult, reconcileStaleRun } from "./stale-reconciler.ts";
import { isWorkerHeartbeatStale } from "./worker-heartbeat.ts";

export interface RecoveryPlan {
	runId: string;
	resumableTasks: string[];
	preservedTasks: string[];
	lastEventSeq: number;
}

function isTerminalTask(task: TeamTaskState): boolean {
	return (
		task.status === "completed" ||
		task.status === "failed" ||
		task.status === "cancelled" ||
		task.status === "skipped" ||
		task.status === "needs_attention"
	);
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
		// Preserve runs intentionally blocked on plan approval — not crashes.
		if (isPlanApprovalPending(manifest)) continue;
		if (manifest.async?.pid !== undefined && checkProcessLiveness(manifest.async.pid).alive) continue;
		// NOTE: no withRunLock — best-effort only; concurrent writes may cause inconsistency
		const loaded = loadRunManifestById(cwd, manifest.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
		if (!loaded) continue;
		const resumableTasks = loaded.tasks.filter((task) => shouldRecoverTask(task, deadMs)).map((task) => task.id);
		if (!resumableTasks.length) continue;
		plans.push({
			runId: manifest.runId,
			resumableTasks,
			preservedTasks: loaded.tasks.filter(isTerminalTask).map((task) => task.id),
			lastEventSeq: scanSequence(loaded.manifest.eventsPath),
		});
	}
	return plans;
}

export async function applyRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">, registry?: MetricRegistry): Promise<void> {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);

	const hookReport = await executeHook("run_recovery", {
		runId: plan.runId,
		cwd: ctx.cwd,
	});
	appendHookEvent(loaded.manifest, hookReport);
	if (hookReport.outcome === "block") {
		appendEvent(loaded.manifest.eventsPath, {
			type: "crew.run.recovery_blocked",
			runId: plan.runId,
			message: `Recovery blocked by hook: ${hookReport.reason ?? "run_recovery hook blocked the operation."}`,
			data: { hookOutcome: "block", reason: hookReport.reason },
		});
		return;
	}

	const reset = new Set(plan.resumableTasks);
	const tasks = loaded.tasks.map((task) =>
		reset.has(task.id)
			? {
					...task,
					status: "queued" as const,
					startedAt: undefined,
					finishedAt: undefined,
					error: undefined,
					heartbeat: undefined,
				}
			: task,
	);
	saveRunTasks(loaded.manifest, tasks);
	appendEvent(loaded.manifest.eventsPath, {
		type: "crew.run.resumed",
		runId: plan.runId,
		message: `Recovered ${plan.resumableTasks.length} interrupted task(s).`,
		data: {
			recoveredFromSeq: plan.lastEventSeq,
			resumableTasks: plan.resumableTasks,
		},
	});
	registry?.counter("crew.run.count", "Total runs by status").inc({ status: "resumed" });
}

export function declineRecoveryPlan(plan: RecoveryPlan, ctx: Pick<ExtensionContext, "cwd">): void {
	const loaded = loadRunManifestById(ctx.cwd, plan.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
	if (!loaded) throw new Error(`Run '${plan.runId}' not found.`);
	// Log the event first — if appendEvent fails, state remains consistent.
	appendEvent(loaded.manifest.eventsPath, {
		type: "crew.run.recovery_declined",
		runId: plan.runId,
		message: "Interrupted run was not resumed.",
		data: { recoveredFromSeq: plan.lastEventSeq },
	});
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
		// Preserve plan-approval-blocked runs — they belong to their owner and are
		// waiting on a human decision, not orphaned by a dead owner process.
		if (isPlanApprovalPending(manifest)) {
			skipped.push(manifest.runId);
			continue;
		}

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
		const loaded = loadRunManifestById(cwd, manifest.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
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
			const fresh = loadRunManifestById(cwd, manifest.runId); // NOTE: inside withRunLockSync - consistent read
			if (!fresh) return;
			if (fresh.manifest.status !== "running" && fresh.manifest.status !== "blocked") {
				// Status changed between initial check (line 109) and acquiring the lock — normal concurrent update, not an orphan
				appendEvent(loaded.manifest.eventsPath, {
					type: "crew.run.orphan_skip",
					runId: manifest.runId,
					message: `Skipped orphan cancellation: status is '${fresh.manifest.status}' (was 'running'/'blocked' at initial scan)`,
					data: { currentStatus: fresh.manifest.status },
				});
				return;
			}

			const now_iso = new Date(now).toISOString();
			const repairedTasks = fresh.tasks.map((task) => {
				if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
					return {
						...task,
						status: "cancelled" as const,
						finishedAt: now_iso,
						error: `Orphaned run: owner session ${ownerId} no longer exists`,
					};
				}
				return task;
			});

			saveRunTasks(fresh.manifest, repairedTasks);
			for (const task of repairedTasks) {
				try {
					upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
				} catch {
					/* non-critical */
				}
			}
			updateRunStatus(fresh.manifest, "cancelled", `Orphaned run: owner session ${ownerId} no longer exists`);
			appendEvent(fresh.manifest.eventsPath, {
				type: "crew.run.orphan_cancelled",
				runId: manifest.runId,
				message: `Auto-cancelled orphaned run (owner: ${ownerId})`,
				data: {
					ownerSessionId: ownerId,
					cancelledTasks: repairedTasks.filter((t) => t.status === "cancelled").length,
				},
			});
			cancelled.push(manifest.runId);
			cancelledRun = true;
		});
		if (cancelledRun)
			void terminateLiveAgentsForRun(manifest.runId, "cancelled", appendEvent, loaded.manifest.eventsPath).catch((error) =>
				logInternalError("crash-recovery.orphan.terminate", error, `runId=${manifest.runId}`, "warn"),
			);
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
 * Age (ms) of the team-level heartbeat file for a run. The team-runner writes
 * `<stateRoot>/heartbeat.json` periodically while a workflow is executing
 * (startTeamHeartbeat), so a fresh heartbeat is strong evidence the run is alive
 * even when its recorded PID check is inconclusive or its active-run-index
 * entry's `updatedAt` was frozen at registration. Returns Infinity when absent.
 */
function heartbeatAgeMs(entry: { stateRoot: string }, now: number): number {
	try {
		const mtime = fs.statSync(path.join(entry.stateRoot, "heartbeat.json")).mtimeMs;
		return Number.isFinite(mtime) ? now - mtime : Infinity;
	} catch {
		return Infinity;
	}
}

/**
 * True if there is recent evidence the run is (or was very recently) alive, so
 * it must NOT be purged. Any one of these signals is sufficient:
 *   - on-disk `manifest.updatedAt` fresher than `staleThresholdMs` (rewritten on
 *     every task transition / status change), and/or
 *   - team-level `heartbeat.json` fresher than `staleThresholdMs`.
 * `entry.updatedAt` is intentionally NOT consulted: it is frozen at
 * registration and never refreshed during execution, which previously caused
 * long-running legitimate runs to be falsely purged — destroying their
 * stateRoot, and because saveRunTasks() silently no-ops once the state dir is
 * gone, hanging the workflow permanently at the current task with no
 * recoverable state ("Run not found").
 */
function hasRecentLifeEvidence(
	entry: { stateRoot: string },
	manifestUpdatedAt: string | undefined,
	now: number,
	staleThresholdMs: number,
): boolean {
	const manifestMs = manifestUpdatedAt ? new Date(manifestUpdatedAt).getTime() : NaN;
	if (Number.isFinite(manifestMs) && now - manifestMs <= staleThresholdMs) return true;
	const hbAge = heartbeatAgeMs(entry, now);
	if (Number.isFinite(hbAge) && hbAge <= staleThresholdMs) return true;
	return false;
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
		let manifest:
			| {
					status?: string;
					updatedAt?: string;
					async?: { pid?: number };
					ownerSessionId?: string;
			  }
			| undefined;
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

		// 5. Still "running" with an async worker PID — only purge when the worker
		// is actually dead AND there is no recent evidence of life. We must NOT
		// rely solely on `entry.updatedAt` (frozen at registration) nor on a single
		// dead-PID reading: a long-running worker (e.g. a 15-minute explorer)
		// legitimately keeps the run "running" while periodically rewriting the
		// on-disk manifest.updatedAt and heartbeat.json. Falsely purging such a run
		// destroys its stateRoot, and because saveRunTasks() silently no-ops once
		// the state dir is gone, the workflow then hangs permanently at the
		// current task with no recoverable state ("Run not found"). When we do mark
		// a run cancelled here, we KEEP its stateRoot so the run stays queryable/
		// resumable and its diagnostics survive; the finished-run pruner removes
		// the directory later on its normal schedule.
		if (manifest?.status === "running" && manifest.async?.pid !== undefined) {
			const pidAlive = checkProcessLiveness(manifest.async.pid).alive;
			if (!pidAlive && !hasRecentLifeEvidence(entry, manifest.updatedAt, now, staleThresholdMs)) {
				// Dead PID + no recent life evidence → cancel the manifest and unregister.
				// RT-F5: wrap load+modify+save in withRunLockSync so concurrent writers
				// (e.g. team-runner final saveRunTasks) cannot interleave between the
				// repaired-tasks write and the manifest-status flip. terminateLiveAgentsForRun
				// is fire-and-forget so it stays OUTSIDE the lock to avoid blocking the
				// critical section on async IPC.
				try {
					const fullLoaded = loadRunManifestById(entry.cwd, entry.runId);
					if (fullLoaded) {
						withRunLockSync(fullLoaded.manifest, () => {
							// Re-read under lock so the stale-best-effort load above
							// can't cause us to clobber a fresh status flip.
							const fresh = loadRunManifestById(entry.cwd, entry.runId);
							if (!fresh) return;
							if (fresh.manifest.status !== "running") return;
							const now_iso = new Date(now).toISOString();
							const repairedTasks = fresh.tasks.map((task) => {
								if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
									return {
										...task,
										status: "cancelled" as const,
										finishedAt: now_iso,
										error: "Orphaned run: worker process dead and no recent activity",
									};
								}
								return task;
							});
							saveRunTasks(fresh.manifest, repairedTasks);
							for (const task of repairedTasks) {
								try {
									upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
								} catch {
									/* non-critical */
								}
							}
							updateRunStatus(fresh.manifest, "cancelled", "Orphaned run: worker process dead and no recent activity");
						});
						void terminateLiveAgentsForRun(
							fullLoaded.manifest.runId,
							"cancelled",
							appendEvent,
							fullLoaded.manifest.eventsPath,
						).catch((error) =>
							logInternalError("crash-recovery.pid-dead.terminate", error, `runId=${fullLoaded.manifest.runId}`, "warn"),
						);
					}
				} catch {
					// Best-effort manifest cleanup
				}
				unregisterActiveRun(entry.runId);
				purged.push(entry.runId);
				continue;
			}
		}

		// 6. "running" but no async worker PID — possible orphaned run where the
		// manifest was never updated to a terminal status after the worker exited.
		// Uses the same life-evidence corroboration as condition 5; the stateRoot is
		// kept on cancel so the run stays queryable/resumable with diagnostics.
		if (manifest?.status === "running" && manifest.async === undefined) {
			if (!hasRecentLifeEvidence(entry, manifest.updatedAt, now, staleThresholdMs)) {
				try {
					const fullLoaded = loadRunManifestById(entry.cwd, entry.runId);
					if (fullLoaded && fullLoaded.manifest.status === "running") {
						withRunLockSync(fullLoaded.manifest, () => {
							const fresh = loadRunManifestById(entry.cwd, entry.runId);
							if (!fresh || fresh.manifest.status !== "running") return;
							const now_iso = new Date(now).toISOString();
							const repairedTasks = fresh.tasks.map((task) => {
								if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
									return {
										...task,
										status: "cancelled" as const,
										finishedAt: now_iso,
										error: "Orphaned run: workflow completed but manifest never updated to terminal status",
									};
								}
								return task;
							});
							saveRunTasks(fresh.manifest, repairedTasks);
							for (const task of repairedTasks) {
								try {
									upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
								} catch {
									/* non-critical */
								}
							}
							updateRunStatus(
								fresh.manifest,
								"cancelled",
								"Orphaned run: no async worker and no manifest update in over " +
									Math.round(staleThresholdMs / 60000) +
									" minutes",
							);
						});
						void terminateLiveAgentsForRun(
							fullLoaded.manifest.runId,
							"cancelled",
							appendEvent,
							fullLoaded.manifest.eventsPath,
						).catch((error) =>
							logInternalError("crash-recovery.pid-dead.terminate", error, `runId=${fullLoaded.manifest.runId}`, "warn"),
						);
					}
				} catch {
					// Best-effort
				}
				unregisterActiveRun(entry.runId);
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
	// Capture runIds to reconcile BEFORE acquiring locks — avoids TOCTOU between cache iteration and lock acquisition.
	const runIds = manifestCache
		.list(50)
		.filter((m) => m.status === "running" || m.status === "blocked")
		.map((m) => m.runId);
	for (const runId of runIds) {
		const cached = manifestCache.get(runId);
		if (!cached) continue;
		const loaded = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency
		if (!loaded) continue;
		// Use lock to prevent race with cancel/status handlers modifying the same run
		withRunLockSync(loaded.manifest, () => {
			// Re-read inside lock to get freshest data
			const fresh = loadRunManifestById(cwd, runId); // NOTE: inside withRunLockSync - consistent read
			if (!fresh || (fresh.manifest.status !== "running" && fresh.manifest.status !== "blocked")) return;
			// Belt-and-suspenders: reconcileStaleRun itself guards this, but the run
			// may have flipped to blocked+plan-approval between cache-list and lock
			// acquisition — re-check the freshest manifest under the lock.
			if (isPlanApprovalPending(fresh.manifest)) {
				results.push({
					runId,
					verdict: "blocked_awaiting_approval",
					repaired: false,
					detail: "Plan approval is pending; stale reconciliation skipped",
				});
				return;
			}
			const result = reconcileStaleRun(fresh.manifest, fresh.tasks, now);
			if (result.repaired || result.verdict === "result_exists") {
				if (result.repairedTasks) {
					saveRunTasks(fresh.manifest, result.repairedTasks);
					for (const task of result.repairedTasks) {
						try {
							upsertCrewAgent(fresh.manifest, recordFromTask(fresh.manifest, task, "scaffold"));
						} catch {
							/* non-critical */
						}
					}
				}
				updateRunStatus(fresh.manifest, "failed", `Stale run reconciled: ${result.detail}`);
				void terminateLiveAgentsForRun(fresh.manifest.runId, "failed", appendEvent, fresh.manifest.eventsPath).catch((error) =>
					logInternalError("crash-recovery.reconcile.terminate", error, `runId=${fresh.manifest.runId}`, "warn"),
				);
				appendEvent(fresh.manifest.eventsPath, {
					type: "crew.run.reconciled_stale",
					runId,
					message: result.detail,
					data: { verdict: result.verdict },
				});
			}
			if (result.verdict !== "healthy") {
				results.push(result);
			}
		});
	}
	return results;
}
