import type { WorkerHeartbeatState } from "./worker-heartbeat.ts";

export type HeartbeatLevel = "healthy" | "warn" | "stale" | "dead";

export interface GradientThresholds {
	warnMs: number;
	staleMs: number;
	deadMs: number;
}

export const DEFAULT_GRADIENT_THRESHOLDS: GradientThresholds = { warnMs: 30_000, staleMs: 60_000, deadMs: 300_000 };

export function heartbeatAgeMs(heartbeat: WorkerHeartbeatState | undefined, now = Date.now()): number {
	if (!heartbeat) return Number.POSITIVE_INFINITY;
	const lastSeen = Date.parse(heartbeat.lastSeenAt);
	return Number.isFinite(lastSeen) ? Math.max(0, now - lastSeen) : Number.POSITIVE_INFINITY;
}

export function classifyHeartbeat(heartbeat: WorkerHeartbeatState | undefined, thresholds: GradientThresholds = DEFAULT_GRADIENT_THRESHOLDS, now = Date.now()): HeartbeatLevel {
	if (!heartbeat) return "dead";
	if (heartbeat.alive === false) return "dead";
	const elapsed = heartbeatAgeMs(heartbeat, now);
	if (!Number.isFinite(elapsed)) return "dead";
	if (elapsed > thresholds.deadMs) return "dead";
	if (elapsed > thresholds.staleMs) return "stale";
	if (elapsed > thresholds.warnMs) return "warn";
	return "healthy";
}
