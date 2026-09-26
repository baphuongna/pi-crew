import type { MetricRegistry } from "../observability/metric-registry.ts";
import { classifyHeartbeat, heartbeatAgeMs } from "../runtime/heartbeat/heartbeat-gradient.ts";
import { isTerminalRunStatus } from "../state/contracts.ts";
import type { TeamTaskState } from "../state/types.ts";
import type { RunUiSnapshot } from "./snapshot-types.ts";

export interface HeartbeatSummary {
	runId: string;
	totalTasks: number;
	healthy: number;
	stale: number;
	dead: number;
	missing: number;
	worstStaleMs: number;
	gradient: { healthy: number; warn: number; stale: number; dead: number };
}

export interface HeartbeatSummaryOptions {
	staleMs?: number;
	deadMs?: number;
	now?: number | Date;
	registry?: MetricRegistry;
}

function nowMs(now: number | Date | undefined): number {
	if (typeof now === "number") return now;
	if (now instanceof Date) return now.getTime();
	return Date.now();
}

function isActiveTask(task: TeamTaskState): boolean {
	return task.status === "running";
}

/**
 * FINDING 5 (2026-09-23 battery): health ticks must count task statuses from
 * DISK truth, not the (possibly lagging) snapshot cache. A worker parked on
 * `ask` transitions running → waiting on disk while the cached snapshot can
 * still show `running` — in that window the parked worker counted as
 * active-without-heartbeat and fired a false "dead worker" notification (live:
 * run team_20260923100114, 01_explore parked on ask, later answered+resumed).
 *
 * Overlay FRESH task statuses (and heartbeats) from disk onto the cached
 * snapshot before summarizing. Returns the ORIGINAL snapshot object when
 * nothing diverged (cheap identity check — callers use it to decide cache
 * invalidation), or a shallow copy with the diverging tasks replaced.
 */
export function overlayFreshTaskStatuses(snapshot: RunUiSnapshot, freshTasks: TeamTaskState[]): RunUiSnapshot {
	if (freshTasks.length === 0) return snapshot;
	const freshById = new Map(freshTasks.map((task) => [task.id, task]));
	let diverged = false;
	const tasks = snapshot.tasks.map((task) => {
		const fresh = freshById.get(task.id);
		if (!fresh || (fresh.status === task.status && fresh.heartbeat === task.heartbeat)) return task;
		diverged = true;
		return { ...task, status: fresh.status, heartbeat: fresh.heartbeat };
	});
	return diverged ? { ...snapshot, tasks } : snapshot;
}

export function summarizeHeartbeats(snapshot: RunUiSnapshot, opts: HeartbeatSummaryOptions = {}): HeartbeatSummary {
	const staleMs = opts.staleMs ?? 60_000;
	const deadMs = opts.deadMs ?? 5 * 60_000;
	const current = nowMs(opts.now);
	const summary: HeartbeatSummary = {
		runId: snapshot.runId,
		totalTasks: snapshot.tasks.length,
		healthy: 0,
		stale: 0,
		dead: 0,
		missing: 0,
		worstStaleMs: 0,
		gradient: { healthy: 0, warn: 0, stale: 0, dead: 0 },
	};
	// bug-026 sub-issue C: a terminal run must never report dead/missing/stale
	// workers. isActiveTask below already skips terminal tasks (the primary
	// task-level gate — locked in by regression tests), but a stale snapshot can
	// carry "running" task statuses that lag the run manifest's terminal
	// transition. Defense-in-depth: skip ALL task counting when the run manifest
	// itself is terminal. Runs with a non-terminal manifest are unaffected.
	const runTerminal = isTerminalRunStatus(snapshot.manifest.status);
	for (const task of snapshot.tasks) {
		if (runTerminal || !isActiveTask(task)) continue;
		// Guest-child tasks (delegate subagents, agent === "delegate") have no
		// heartbeat channel — they never write task.heartbeat and complete in
		// seconds; their lifecycle is owned by delegate.requested/admitted/
		// completed broker events. Counting them here fired a false "N worker(s)
		// missing heartbeat" ambient for every delegate-using run (live:
		// team_20260926033657_2b6c6d2610b26d9d, 2026-09-26 battery — same
		// gc-blindness root shape as the heartbeat-watcher fix).
		if (task.agent === "delegate") continue;
		const heartbeat = task.heartbeat;
		if (!heartbeat) {
			summary.missing += 1;
			summary.gradient.dead += 1;
			continue;
		}
		const age = heartbeatAgeMs(heartbeat, current);
		if (!Number.isFinite(age)) {
			summary.missing += 1;
			summary.gradient.dead += 1;
			continue;
		}
		summary.worstStaleMs = Math.max(summary.worstStaleMs, age);
		const level = classifyHeartbeat(heartbeat, { warnMs: Math.max(1, Math.floor(staleMs / 2)), staleMs, deadMs }, current);
		summary.gradient[level] += 1;
		opts.registry
			?.gauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds")
			.set({ runId: snapshot.runId, taskId: task.id }, age);
		opts.registry?.counter("crew.heartbeat.level_total", "Heartbeat classifications by level").inc({ runId: snapshot.runId, level });
		if (level === "dead") summary.dead += 1;
		else if (level === "stale") summary.stale += 1;
		else summary.healthy += 1;
	}
	return summary;
}
