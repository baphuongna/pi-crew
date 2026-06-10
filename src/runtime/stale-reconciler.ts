import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { recordFromTask, upsertCrewAgent } from "./crew-agent-records.ts";
import { checkProcessLiveness } from "./process-status.ts";
import { saveRunManifest } from "../state/state-store.ts";

/** Age threshold for orphaned temp directory cleanup: 1 hour. */
const ORPHAN_TEMP_DIR_AGE_THRESHOLD_MS = 60 * 60 * 1000;
/** Defense-in-depth: cap the number of /tmp/pi-crew-* entries processed per
 * reconcile tick. With a few thousand accumulated dirs, processing them all
 * synchronously can block the main thread for many seconds, causing the
 * terminal to appear hung. We process in batches; the rest are handled on
 * subsequent ticks. */
const ORPHAN_TEMP_SCAN_BATCH_SIZE = 50;

/**
 * Result of reconciling a single stale run.
 */
export interface ReconcileResult {
	runId: string;
	/** What was found and what action was taken */
	verdict:
		| "healthy"
		| "result_exists"
		| "pid_dead"
		| "pid_alive_stale"
		| "no_status";
	/** Whether repair was applied */
	repaired: boolean;
	/** Human-readable detail */
	detail: string;
	/** Repaired task state, returned to a locked caller for persistence. */
	repairedTasks?: TeamTaskState[];
}

const STALE_ALIVE_PID_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACTIVE_EVIDENCE_TTL_MS = 5 * 60 * 1000;
/** For no-PID runs, repair when ALL running tasks have heartbeat stale beyond this threshold. */
const NO_PID_HEARTBEAT_STALE_MS = 5 * 60 * 1000; // 5 minutes — same as heartbeat-gradient deadMs

/**
 * Phase 1: Check if a result file already exists for the run.
 * If so, the run completed but status wasn't updated — repair it.
 */
function checkResultFile(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
): { found: boolean; repaired: boolean } {
	// Check if all tasks already have terminal status (result was written but manifest wasn't updated)
	const allTerminal =
		tasks.length > 0 &&
		tasks.every(
			(t) =>
				t.status === "completed" ||
				t.status === "failed" ||
				t.status === "cancelled" ||
				t.status === "skipped" ||
				t.status === "needs_attention",
		);
	if (allTerminal) {
		// All tasks are terminal but manifest status was not updated — repair it.
		// Persist manifest status change immediately to make checkResultFile self-contained.
		manifest.status = "completed";
		saveRunManifest(manifest);
		// Sync agent records even when tasks are already terminal
		// (e.g., a previous reconcile fixed tasks but crashed before updating agents)
		for (const task of tasks) {
			try {
				upsertCrewAgent(
					manifest,
					recordFromTask(manifest, task, "scaffold"),
				);
			} catch {
				/* non-critical */
			}
		}
		return { found: true, repaired: false };
	}
	return { found: false, repaired: false };
}

/**
 * Get process start time in milliseconds since boot from /proc/<pid>/stat.
 * Returns undefined if the process is gone or /proc is unavailable.
 *
 * Platform limitation: Relies on Linux's /proc filesystem. On macOS/Windows,
 * startTime will be undefined and PID reuse detection is weaker.
 *
 * The start time is in the 22nd field (index 21 after comm) of /proc/<pid>/stat.
 */
function getProcessStartTime(pid: number): number | undefined {
	try {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
		const lastParen = stat.lastIndexOf(")");
		if (lastParen === -1) return undefined;
		const fieldsAfterComm = stat.slice(lastParen + 1).trim().split(/\s+/);
		// starttime is at index 19 (the 20th field after comm)
		const startTimeClockTicks = Number(fieldsAfterComm[19]);
		if (!Number.isFinite(startTimeClockTicks)) return undefined;
		// Convert clock ticks to ms using ~100 ticks/sec (CLK_TCK).
		// The absolute value matters less than uniqueness per PID lifecycle.
		return Math.floor(startTimeClockTicks * 10);
	} catch {
		return undefined;
	}
}

/**
 * Phase 2: Check PID liveness.
 * Uses process.kill(pid, 0) for the authoritative check, but also verifies
 * startTime before and after to detect PID recycling. If the OS recycles
 * the PID between the kill(0) call and the repair action, a newly spawned
 * unrelated process could be incorrectly identified as the async worker.
 * The heartbeat file is used as corroborating evidence when the process
 * appears dead per kill(0).
 */
function checkPidLiveness(
	pid: number | undefined,
	stateRoot?: string,
): {
	alive: boolean;
	detail: string;
} {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
		return { alive: false, detail: "no pid recorded" };
	}
	// Capture startTime before kill(0) to detect PID recycling.
	const startTimeBefore = getProcessStartTime(pid);
	const liveness = checkProcessLiveness(pid);
	// Re-verify startTime after kill(0) to close the TOCTOU window.
	// If startTime changed, the PID was recycled to a different process.
	const startTimeAfter = getProcessStartTime(pid);
	if (
		startTimeBefore !== undefined &&
		startTimeAfter !== undefined &&
		startTimeBefore !== startTimeAfter
	) {
		// PID was recycled — treat as dead to avoid acting on wrong process.
		return { alive: false, detail: "pid_recycled" };
	}
	// If process is alive per kill(0), we're done.
	if (liveness.alive) return { alive: true, detail: liveness.detail };
	// Process is dead per kill(0). Check heartbeat as corroborating evidence.
	if (stateRoot) {
		const heartbeatPath = path.join(stateRoot, "heartbeat.json");
		try {
			if (fs.existsSync(heartbeatPath)) {
				const hb = JSON.parse(
					fs.readFileSync(heartbeatPath, "utf-8"),
				) as { pid?: number; at?: number };
				if (hb?.pid === pid && hb?.at) {
					const ageMs = Date.now() - hb.at;
					// Heartbeat written < 5 min ago → process was alive recently.
					// Don't repair yet; let the next reconciliation cycle catch it.
					if (ageMs < 5 * 60_000) {
						return {
							alive: true,
							detail: `process dead but heartbeat ${Math.round(ageMs / 1000)}s old`,
						};
					}
				}
			}
		} catch {
			/* ignore — best-effort */
		}
	}
	return { alive: liveness.alive, detail: liveness.detail };
}

/**
 * Phase 3: For dead PIDs, repair immediately.
 * For alive PIDs, only mark stale if status hasn't updated in STALE_ALIVE_PID_MS.
 */
function evaluateStaleness(
	manifest: TeamRunManifest,
	pidAlive: boolean,
	now: number,
): { stale: boolean; reason: string } {
	if (!pidAlive) {
		return { stale: true, reason: "pid_dead" };
	}
	const updatedAt = new Date(manifest.updatedAt).getTime();
	if (!Number.isFinite(updatedAt)) {
		return { stale: false, reason: "updated_at_invalid" };
	}
	if (now - updatedAt > STALE_ALIVE_PID_MS) {
		return {
			stale: true,
			reason: `alive_but_stale_${Math.round((now - updatedAt) / 3600_000)}h`,
		};
	}
	return { stale: false, reason: "alive_and_recent" };
}

function hasRecentActiveEvidence(tasks: TeamTaskState[], now: number): boolean {
	return tasks.some((task) => {
		if (task.status !== "running" && task.status !== "waiting")
			return false;
		const heartbeatAt = task.heartbeat?.lastSeenAt
			? new Date(task.heartbeat.lastSeenAt).getTime()
			: Number.NaN;
		if (
			task.heartbeat?.alive !== false &&
			Number.isFinite(heartbeatAt) &&
			now - heartbeatAt <= ACTIVE_EVIDENCE_TTL_MS
		)
			return true;
		const activityAt = task.agentProgress?.lastActivityAt
			? new Date(task.agentProgress.lastActivityAt).getTime()
			: Number.NaN;
		return (
			Number.isFinite(activityAt) &&
			now - activityAt <= ACTIVE_EVIDENCE_TTL_MS
		);
	});
}

/**
 * Check if a single task is stale (heartbeat AND activity both stale beyond
 * NO_PID_HEARTBEAT_STALE_MS). Tasks with no heartbeat AND no agent progress
 * are considered NOT stale (they may be newly spawned and haven't reported yet).
 */
function isTaskHeartbeatStale(task: TeamTaskState, now: number): boolean {
	const heartbeatAt = task.heartbeat?.lastSeenAt
		? new Date(task.heartbeat.lastSeenAt).getTime()
		: Number.NaN;
	const activityAt = task.agentProgress?.lastActivityAt
		? new Date(task.agentProgress.lastActivityAt).getTime()
		: Number.NaN;
	// If no heartbeat AND no activity, we can't determine staleness — not stale
	if (!Number.isFinite(heartbeatAt) && !Number.isFinite(activityAt))
		return false;
	// Compute elapsed from both sources and use the fresher (minimum) one,
	// mirroring heartbeat-watcher logic: if either source has recent activity,
	// the task is not stale even if the other is stale.
	const heartbeatAge = Number.isFinite(heartbeatAt) ? now - heartbeatAt : Infinity;
	const activityAge = Number.isFinite(activityAt) ? now - activityAt : Infinity;
	const elapsed = Math.min(heartbeatAge, activityAge);
	return elapsed > NO_PID_HEARTBEAT_STALE_MS;
}

/**
 * For no-PID runs: check if ALL running tasks have heartbeats stale beyond
 * the no-PID heartbeat threshold, and return the list of individually stale
 * task IDs. This detects zombie tasks where the worker process died but no
 * PID was recorded (e.g. live-session /tmp/ workspaces).
 * Merged from the former allRunningTasksHeartbeatStale and
 * findIndividuallyStaleTaskIds to avoid redundant duplicate checks.
 */
function getRunningTaskStaleness(
	tasks: TeamTaskState[],
	now: number,
): { allStale: boolean; staleTaskIds: string[] } {
	const runningTasks = tasks.filter(
		(t) => t.status === "running" || t.status === "waiting",
	);
	if (runningTasks.length === 0) return { allStale: false, staleTaskIds: [] };
	const staleTaskIds: string[] = [];
	for (const task of runningTasks) {
		if (isTaskHeartbeatStale(task, now)) {
			staleTaskIds.push(task.id);
		}
	}
	return {
		allStale: staleTaskIds.length === runningTasks.length,
		staleTaskIds,
	};
}

/**
 * Repair a stale run by marking it as failed and cancelling running tasks.
 */
function repairStaleRun(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	reason: string,
): TeamTaskState[] {
	const now = new Date().toISOString();
	const repairedTasks = tasks.map((task) => {
		if (
			task.status === "running" ||
			task.status === "queued" ||
			task.status === "waiting"
		) {
			return {
				...task,
				status: "cancelled" as const,
				finishedAt: now,
				error: `Stale run reconciled: ${reason}`,
			};
		}
		return task;
	});
	// Update agent records so widget sees cancelled status immediately
	for (const task of repairedTasks) {
		try {
			upsertCrewAgent(
				manifest,
				recordFromTask(manifest, task, "scaffold"),
			);
		} catch {
			/* non-critical */
		}
	}
	return repairedTasks;
}

/**
 * Three-phase stale run reconciliation.
 *
 * 1. Check if result already exists → use it
 * 2. Check PID liveness
 * 3. Dead PID → repair immediately; alive PID → only fail if stale > 24h
 *
 * NOTE: Callers must provide locking via withRunLock/withRunLockSync when
 * calling from contexts where concurrent reconciliation of the same runId
 * could occur (e.g., the auto-repair timer). The crash-recovery.ts caller
 * already provides this. The reconcileOrphanedTempWorkspaces caller handles
 * /tmp workspaces where concurrent access is a known benign race (separate
 * dirs, low consequence of redundant repair).
 */
export function reconcileStaleRun(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	now = Date.now(),
): ReconcileResult {
	const runId = manifest.runId;

	// Phase 1: Check if results already exist
	const phase1 = checkResultFile(manifest, tasks);
	if (phase1.found) {
		// checkResultFile sets manifest.status='completed' and saves it,
		// but we re-save to ensure the completed status is persisted
		// before returning (avoids TOCTOU where caller might re-read stale data)
		saveRunManifest(manifest);
		return {
			runId,
			verdict: "result_exists",
			repaired: false,
			detail: "All tasks already terminal — no repair needed",
		};
	}

	// Phase 2: Check PID liveness
	const pid = manifest.async?.pid;
	const pidStatus = checkPidLiveness(pid, manifest.stateRoot);

	if (pidStatus.detail === "no pid recorded") {
		// No async PID may be a foreground/live run. Preserve it if task heartbeat
		// or agent progress proves active work even when manifest.updatedAt is old.
		if (hasRecentActiveEvidence(tasks, now)) {
			return {
				runId,
				verdict: "no_status",
				repaired: false,
				detail: "No PID recorded, but recent task heartbeat/progress exists; not repairing",
			};
		}
		// No PID and no recent activity. If ALL running tasks have stale heartbeats
		// (beyond NO_PID_HEARTBEAT_STALE_MS = 5min), repair immediately — the worker
		// process is dead but we have no PID to check. This handles /tmp/ live-session
		// workspaces where agents exit without calling submit_result.
		// Merged with individual stale task check to avoid redundant duplicate checks.
		const { allStale, staleTaskIds } = getRunningTaskStaleness(tasks, now);
		if (allStale) {
			const repaired = repairStaleRun(
				manifest,
				tasks,
				"no_pid_heartbeat_stale",
			);
			return {
				runId,
				verdict: "no_status",
				repaired: true,
				detail: `No PID; all running task heartbeats stale >${Math.round(NO_PID_HEARTBEAT_STALE_MS / 60_000)}min; repaired ${repaired.filter((t) => t.status === "cancelled").length} tasks`,
				repairedTasks: repaired,
			};
		}
		// Check for individually stale tasks even when not all are stale.
		// This handles the case where task A is healthy but task B is a zombie.
		// We repair only the zombie tasks, not the whole run.
		// NOTE: Individual stale task repair (this branch) is intentionally
		// separate from run-level repair (the allStale branch above). Both
		// paths can coexist — the allStale path cancels the entire run when
		// ALL tasks are zombies, while this path repairs only the zombie
		// subset when some tasks are still healthy.
		if (staleTaskIds.length > 0) {
			const repaired = repairStaleRun(manifest, tasks, "no_pid_individual_stale_task");
			// Only return the individually repaired tasks in detail
			return {
				runId,
				verdict: "no_status",
				repaired: true,
				detail: `No PID; ${staleTaskIds.length} individually stale task(s) repaired: ${staleTaskIds.join(", ")}`,
				repairedTasks: repaired.filter((t) => staleTaskIds.includes(t.id)),
			};
		}
		// Fall through: no recent activity but not all tasks stale enough yet.
		// Check the longer STALE_ALIVE_PID_MS threshold for very old runs.
		const updatedAt = new Date(manifest.updatedAt).getTime();
		if (
			Number.isFinite(updatedAt) &&
			now - updatedAt > STALE_ALIVE_PID_MS
		) {
			const repaired = repairStaleRun(manifest, tasks, "no_pid_stale");
			return {
				runId,
				verdict: "no_status",
				repaired: true,
				detail: `No PID; stale ${Math.round((now - updatedAt) / 3600_000)}h; repaired ${repaired.filter((t) => t.status === "cancelled").length} tasks`,
				repairedTasks: repaired,
			};
		}
		return {
			runId,
			verdict: "no_status",
			repaired: false,
			detail: "No PID recorded; not stale enough to repair",
		};
	}

	// Phase 3: Evaluate staleness
	const staleness = evaluateStaleness(manifest, pidStatus.alive, now);
	if (!staleness.stale) {
		return {
			runId,
			verdict: "healthy",
			repaired: false,
			detail: `PID ${pid}: ${pidStatus.detail}, ${staleness.reason}`,
		};
	}

	// Repair
	const repaired = repairStaleRun(manifest, tasks, staleness.reason);
	return {
		runId,
		verdict: pidStatus.alive ? "pid_alive_stale" : "pid_dead",
		repaired: true,
		detail: `PID ${pid}: ${pidStatus.detail}; ${staleness.reason}; repaired ${repaired.filter((t) => t.status === "cancelled").length} tasks`,
		repairedTasks: repaired,
	};
}

/**
 * Result of orphaned temp workspace reconciliation.
 */
export interface OrphanReconcileResult {
	/** Number of runs repaired (manifests cancelled). */
	repaired: number;
	/** Number of /tmp/pi-crew-* directories removed. */
	cleanedDirs: number;
}

/**
 * Scan /tmp (os.tmpdir()) for orphaned pi-crew-* workspaces and reconcile
 * any stale runs found. This catches runs created by tests or crashed sessions
 * that the per-CWD auto-repair timer would miss.
 *
 * When `cleanupOrphanedTempDirs` is not explicitly set to `false`, directories
 * older than 1 hour with no remaining running manifests are deleted after
 * their runs are reconciled.
 *
 * @returns Number of runs repaired and directories cleaned.
 */
export function reconcileOrphanedTempWorkspaces(
	now = Date.now(),
	options?: { cleanupOrphanedTempDirs?: boolean },
): OrphanReconcileResult {
	const tmpDir = getSafeTempDir();
	if (!tmpDir) return { repaired: 0, cleanedDirs: 0 };
	let repaired = 0;
	let cleanedDirs = 0;
	try {
		const entries = fs.readdirSync(tmpDir, { withFileTypes: true });
		// Sort for deterministic order; cap to ORPHAN_TEMP_SCAN_BATCH_SIZE per
		// tick to avoid main-thread stalls when /tmp has thousands of
		// pi-crew-* dirs from past interrupted test runs.
		const candidates = entries
			.filter((e) => e.isDirectory() && e.name.startsWith("pi-crew-"))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, ORPHAN_TEMP_SCAN_BATCH_SIZE);
		for (const entry of candidates) {
			if (!entry.isDirectory() || !entry.name.startsWith("pi-crew-"))
				continue;
			const workspaceDir = path.join(tmpDir, entry.name);
			const crewDir = path.join(workspaceDir, ".crew");
			if (!fs.existsSync(crewDir)) continue;
			const stateRunsDir = path.join(crewDir, "state", "runs");
			if (!fs.existsSync(stateRunsDir)) continue;
			let hasRunning = false;
			try {
				for (const runDir of fs.readdirSync(stateRunsDir)) {
					const manifestPath = path.join(
						stateRunsDir,
						runDir,
						"manifest.json",
					);
					const tasksPath = path.join(
						stateRunsDir,
						runDir,
						"tasks.json",
					);
					if (
						!fs.existsSync(manifestPath) ||
						!fs.existsSync(tasksPath)
					)
						continue;
					try {
						const manifest: TeamRunManifest = JSON.parse(
							fs.readFileSync(manifestPath, "utf-8"),
						);
						if (manifest.status !== "running") continue;
						const tasks: TeamTaskState[] = JSON.parse(
							fs.readFileSync(tasksPath, "utf-8"),
						);
						const result = reconcileStaleRun(manifest, tasks, now);
						if (result.repaired && result.repairedTasks) {
							// Persist repaired tasks
							fs.writeFileSync(
								tasksPath,
								JSON.stringify(result.repairedTasks, null, 2),
							);
							// Update manifest status
							const updated = {
								...manifest,
								status: "cancelled" as const,
								updatedAt: new Date(now).toISOString(),
								summary: `Stale run reconciled: ${result.detail}`,
							};
							fs.writeFileSync(
								manifestPath,
								JSON.stringify(updated, null, 2),
							);
							// Update agent records
							for (const task of result.repairedTasks) {
								try {
									upsertCrewAgent(
										updated,
										recordFromTask(
											updated,
											task,
											"scaffold",
										),
									);
								} catch {
									/* non-critical */
								}
							}
							repaired++;
						}
						// Persist result_exists manifest status update
							if (result.verdict === "result_exists") {
								// checkResultFile (called by reconcileStaleRun at line 518)
								// already saved manifest.status='completed' at line 66.
								// No additional manifest write needed here — avoids TOCTOU
								// window between checkResultFile save and re-write.
								// Sync agent records (checkResultFile also does this but
								// we sync here for consistency)
								for (const task of tasks) {
									try {
										upsertCrewAgent(
											manifest,
											recordFromTask(manifest, task, "scaffold"),
										);
									} catch {
										/* non-critical */
									}
								}
							}
							// If still running after reconciliation attempt, mark for dir-preserving
							if (
								result.verdict === "healthy" ||
								(result.verdict === "no_status" && !result.repaired)
							) {
								hasRunning = true;
							}
					} catch (err) {
						// Log warning when skipping a directory due to error.
						// Note: manifestPath here refers to the variable defined in the
						// for loop at line 442 (outer scope of this catch block).
						const scanManifestPath = manifestPath;
						console.warn(
							`[stale-reconciler] Skipping manifest due to parse error: ${scanManifestPath}: ${err}`,
						);
					}
				}
			} catch (err) {
				// Cannot determine running state — treat as if running to prevent
				// premature cleanup of a potentially active workspace.
				hasRunning = true;
				console.warn(
					`[stale-reconciler] Skipping unreadable runs dir: ${stateRunsDir}: ${err}`,
				);
			}

			// Post-loop: check if this workspace dir can be cleaned up.
			// Eligible when cleanup is enabled, no running manifests remain, and
			// the directory is older than the age threshold.
			// Re-scan manifests to confirm no running runs remain BEFORE the
			// cleanup decision (fixes TOCTOU race where a manifest may have
			// transitioned from 'running' to 'completed' between the main loop
			// and this re-scan).
			//
			// TOCTOU fix: Create a sentinel file before the re-scan. New run
			// creation should check for this sentinel and refuse/wait if present.
			// Additionally, do a final check right before cleanup to catch any
			// new runs created between the re-scan and the cleanup decision.
			const sentinelPath = path.join(workspaceDir, ".cleanup-in-progress");
			let canCleanup = !hasRunning;

			// FIX: Capture dirAge BEFORE creating the sentinel file, because writing
			// .cleanup-in-progress inside workspaceDir updates its mtime, making the
			// directory appear fresh and defeating the age check.
			const cleanupEnabled = options?.cleanupOrphanedTempDirs !== false;
			let dirAge = 0;
			if (cleanupEnabled && !hasRunning) {
				try {
					const stat = fs.statSync(workspaceDir);
					dirAge = now - stat.mtimeMs;
				} catch {
					// Directory disappeared
				}
			}
			if (canCleanup) {
				// Create sentinel file before re-scan to signal cleanup in progress.
				// O_EXCL requires workspaceDir to exist — ensure it before writing.
				try {
					if (!fs.existsSync(workspaceDir)) {
						fs.mkdirSync(workspaceDir, { recursive: true });
					}
					fs.writeFileSync(sentinelPath, JSON.stringify({ startedAt: now }), {
						flag: "wx",
					});
				} catch {
					// Sentinel already exists (another cleanup in progress) — skip
					canCleanup = false;
				}
			}
			if (canCleanup) {
				if (fs.existsSync(stateRunsDir)) {
					try {
						for (const runDir of fs.readdirSync(stateRunsDir)) {
							const manifestPath = path.join(
								stateRunsDir,
								runDir,
								"manifest.json",
							);
							if (!fs.existsSync(manifestPath)) continue;
							let manifest: TeamRunManifest | undefined;
							try {
								manifest = JSON.parse(
									fs.readFileSync(manifestPath, "utf-8"),
								);
							} catch (err) {
								// Log warning when skipping a directory due to error
								console.warn(
									`[stale-reconciler] Skipping manifest due to parse error: ${manifestPath}: ${err}`,
								);
								continue;
							}
							if (manifest?.status === "running") {
								canCleanup = false;
								break;
							}
						}
					} catch (err) {
						console.warn(
							`[stale-reconciler] Skipping unreadable runs dir: ${stateRunsDir}: ${err}`,
						);
					}
				}
			}
			if (canCleanup) {
				if (dirAge > ORPHAN_TEMP_DIR_AGE_THRESHOLD_MS) {
					// Final check: re-verify no running manifests appeared since re-scan.
					let stillClean = true;
					if (fs.existsSync(stateRunsDir)) {
						try {
							for (const runDir of fs.readdirSync(stateRunsDir)) {
								const manifestPath = path.join(
									stateRunsDir,
									runDir,
									"manifest.json",
								);
								if (!fs.existsSync(manifestPath)) continue;
								try {
									const manifest: TeamRunManifest = JSON.parse(
										fs.readFileSync(manifestPath, "utf-8"),
									);
									if (manifest.status === "running") {
										stillClean = false;
										break;
									}
								} catch {
									/* skip on parse error */
								}
							}
						} catch {
							stillClean = false;
						}
					}
					if (stillClean) {
						fs.rmSync(workspaceDir, {
							recursive: true,
							force: true,
						});
						cleanedDirs++;
					}
				}
				// Clean up sentinel file regardless of outcome
				try {
					fs.unlinkSync(sentinelPath);
				} catch {
					/* ignore if already gone */
				}
			} else if (canCleanup) {
				// Sentinel already existed — another cleanup attempt is in progress.
				// Perform a simplified TOCTOU check: if any manifest is running,
				// do NOT remove the sentinel (let the first attempt finish its scan).
				let hasRunningManifest = false;
				if (fs.existsSync(stateRunsDir)) {
					try {
						for (const runDir of fs.readdirSync(stateRunsDir)) {
							const manifestPath = path.join(
								stateRunsDir,
								runDir,
								"manifest.json",
							);
							if (!fs.existsSync(manifestPath)) continue;
							try {
								const m = JSON.parse(
									fs.readFileSync(manifestPath, "utf-8"),
								) as TeamRunManifest;
								if (m.status === "running") {
									hasRunningManifest = true;
									break;
								}
							} catch {
								/* skip on parse error */
							}
						}
					} catch {
						/* skip if runs dir unreadable */
					}
				}
				// Only clean up sentinel if no running manifests exist
				if (!hasRunningManifest) {
					try {
						fs.unlinkSync(sentinelPath);
					} catch {
						/* ignore if already gone */
					}
				}
			}
		}
	} catch {
		/* skip if tmpdir unreadable */
	}
	return { repaired, cleanedDirs };
}

function getSafeTempDir(): string | undefined {
	try {
		return fs.existsSync(os.tmpdir()) ? os.tmpdir() : undefined;
	} catch {
		return undefined;
	}
}
