import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { checkProcessLiveness } from "./process-status.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { writeAtomicJson } from "../utils/atomic-write.ts";

/**
 * Result of reconciling a single stale run.
 */
export interface ReconcileResult {
	runId: string;
	/** What was found and what action was taken */
	verdict: "healthy" | "result_exists" | "pid_dead" | "pid_alive_stale" | "no_status";
	/** Whether repair was applied */
	repaired: boolean;
	/** Human-readable detail */
	detail: string;
}

const STALE_ALIVE_PID_MS = 24 * 60 * 60 * 1000; // 24 hours
const ACTIVE_EVIDENCE_TTL_MS = 5 * 60 * 1000;

/**
 * Phase 1: Check if a result file already exists for the run.
 * If so, the run completed but status wasn't updated — repair it.
 */
function checkResultFile(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
): { found: boolean; repaired: boolean } {
	// Check if all tasks already have terminal status (result was written but manifest wasn't updated)
	const allTerminal = tasks.length > 0 && tasks.every(
		(t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled" || t.status === "skipped",
	);
	if (allTerminal) {
		return { found: true, repaired: false };
	}
	return { found: false, repaired: false };
}

/**
 * Phase 2: Check PID liveness.
 */
function checkPidLiveness(pid: number | undefined): {
	alive: boolean;
	detail: string;
} {
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) {
		return { alive: false, detail: "no pid recorded" };
	}
	const liveness = checkProcessLiveness(pid);
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
		return { stale: true, reason: `alive_but_stale_${Math.round((now - updatedAt) / 3600_000)}h` };
	}
	return { stale: false, reason: "alive_and_recent" };
}

function hasRecentActiveEvidence(tasks: TeamTaskState[], now: number): boolean {
	return tasks.some((task) => {
		if (task.status !== "running" && task.status !== "waiting") return false;
		const heartbeatAt = task.heartbeat?.lastSeenAt ? new Date(task.heartbeat.lastSeenAt).getTime() : Number.NaN;
		if (task.heartbeat?.alive !== false && Number.isFinite(heartbeatAt) && now - heartbeatAt <= ACTIVE_EVIDENCE_TTL_MS) return true;
		const activityAt = task.agentProgress?.lastActivityAt ? new Date(task.agentProgress.lastActivityAt).getTime() : Number.NaN;
		return Number.isFinite(activityAt) && now - activityAt <= ACTIVE_EVIDENCE_TTL_MS;
	});
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
		if (task.status === "running" || task.status === "queued" || task.status === "waiting") {
			return {
				...task,
				status: "cancelled" as const,
				finishedAt: now,
				error: `Stale run reconciled: ${reason}`,
			};
		}
		return task;
	});

	// Write repaired tasks atomically
	const tasksPath = manifest.tasksPath;
	if (tasksPath) {
		try {
			writeAtomicJson(tasksPath, repairedTasks);
		} catch (error) {
			logInternalError("stale-reconciler.repair-tasks", error, `runId=${manifest.runId}`);
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
		return {
			runId,
			verdict: "result_exists",
			repaired: false,
			detail: "All tasks already terminal — no repair needed",
		};
	}

	// Phase 2: Check PID liveness
	const pid = manifest.async?.pid;
	const pidStatus = checkPidLiveness(pid);

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
		const updatedAt = new Date(manifest.updatedAt).getTime();
		if (Number.isFinite(updatedAt) && now - updatedAt > STALE_ALIVE_PID_MS) {
			const repaired = repairStaleRun(manifest, tasks, "no_pid_stale");
			return {
				runId,
				verdict: "no_status",
				repaired: true,
				detail: `No PID; stale ${Math.round((now - updatedAt) / 3600_000)}h; repaired ${repaired.filter((t) => t.status === "cancelled").length} tasks`,
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
	};
}
