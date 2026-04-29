import type { TeamTaskState } from "../state/types.ts";
import { classifyHeartbeat, heartbeatAgeMs } from "../runtime/heartbeat-gradient.ts";
import type { MetricRegistry } from "../observability/metric-registry.ts";
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
	return task.status === "running" || task.status === "queued";
}

export function summarizeHeartbeats(snapshot: RunUiSnapshot, opts: HeartbeatSummaryOptions = {}): HeartbeatSummary {
	const staleMs = opts.staleMs ?? 60_000;
	const deadMs = opts.deadMs ?? 5 * 60_000;
	const current = nowMs(opts.now);
	const summary: HeartbeatSummary = { runId: snapshot.runId, totalTasks: snapshot.tasks.length, healthy: 0, stale: 0, dead: 0, missing: 0, worstStaleMs: 0, gradient: { healthy: 0, warn: 0, stale: 0, dead: 0 } };
	for (const task of snapshot.tasks) {
		if (!isActiveTask(task)) continue;
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
		opts.registry?.gauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds").set({ runId: snapshot.runId, taskId: task.id }, age);
		opts.registry?.counter("crew.heartbeat.level_total", "Heartbeat classifications by level").inc({ runId: snapshot.runId, level });
		if (level === "dead") summary.dead += 1;
		else if (level === "stale") summary.stale += 1;
		else summary.healthy += 1;
	}
	return summary;
}
