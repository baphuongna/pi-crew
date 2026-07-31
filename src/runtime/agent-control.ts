import { randomUUID } from "node:crypto";
import type { PiTeamsConfig } from "../config/config.ts";
import type { ControlReservation, TeamRunManifest } from "../state/types.ts";
import { appendTaskAttentionEvent } from "./attention-events.ts";
import { upsertCrewAgent } from "./crew-agent-records.ts";
import type { CrewAgentRecord } from "./crew-agent-runtime.ts";

export interface CrewControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	consecutiveFailureThreshold: number;
	longRunningMinutes: number;
}

const DEFAULT_NEEDS_ATTENTION_MS = 60_000;
const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;
const DEFAULT_LONG_RUNNING_MINUTES = 10;

function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveCrewControlConfig(config: PiTeamsConfig | undefined): CrewControlConfig {
	const raw = config as
		| (PiTeamsConfig & {
				control?: {
					enabled?: unknown;
					needsAttentionAfterMs?: unknown;
					consecutiveFailureThreshold?: unknown;
					longRunningMinutes?: unknown;
				};
		  })
		| undefined;
	return {
		enabled: raw?.control?.enabled !== false,
		needsAttentionAfterMs: positiveInt(raw?.control?.needsAttentionAfterMs) ?? DEFAULT_NEEDS_ATTENTION_MS,
		consecutiveFailureThreshold: positiveInt(raw?.control?.consecutiveFailureThreshold) ?? DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
		longRunningMinutes: positiveInt(raw?.control?.longRunningMinutes) ?? DEFAULT_LONG_RUNNING_MINUTES,
	};
}

export function activityAgeMs(agent: CrewAgentRecord, now = Date.now()): number | undefined {
	const timestamp = agent.progress?.lastActivityAt ?? agent.startedAt;
	if (!timestamp) return undefined;
	const ms = now - new Date(timestamp).getTime();
	return Number.isFinite(ms) ? Math.max(0, ms) : undefined;
}

export function formatActivityAge(agent: CrewAgentRecord, now = Date.now()): string | undefined {
	const age = activityAgeMs(agent, now);
	if (age === undefined) return undefined;
	if (age < 1000) return "active now";
	const seconds = Math.floor(age / 1000);
	if (seconds < 60) return agent.progress?.activityState === "needs_attention" ? `no activity for ${seconds}s` : `active ${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	return agent.progress?.activityState === "needs_attention" ? `no activity for ${minutes}m` : `active ${minutes}m ago`;
}

export function applyAttentionState(
	manifest: TeamRunManifest,
	agent: CrewAgentRecord,
	config: CrewControlConfig,
	now = Date.now(),
): CrewAgentRecord {
	if (!config.enabled || agent.status !== "running") return agent;
	const age = activityAgeMs(agent, now);
	if (age === undefined || age <= config.needsAttentionAfterMs) return agent;
	if (agent.progress?.activityState === "needs_attention") return agent;
	const updated: CrewAgentRecord = {
		...agent,
		progress: {
			...(agent.progress ?? {
				recentTools: [],
				recentOutput: [],
				toolCount: agent.toolUses ?? 0,
			}),
			activityState: "needs_attention",
		},
	};
	upsertCrewAgent(manifest, updated);
	appendTaskAttentionEvent({
		manifest,
		taskId: agent.taskId,
		message: `${agent.agent} needs attention (no observed activity for ${Math.floor(age / 1000)}s).`,
		data: {
			activityState: "needs_attention",
			reason: "idle",
			elapsedMs: age,
			taskId: agent.taskId,
			agentName: agent.agent,
			suggestedAction: "Check worker status, wait, steer, or cancel if needed.",
		},
	});
	return updated;
}

/** @internal */
function applyLongRunningCheck(
	manifest: TeamRunManifest,
	agent: CrewAgentRecord,
	config: CrewControlConfig,
	now = Date.now(),
): CrewAgentRecord {
	if (!config.enabled || agent.status !== "running") return agent;
	if (agent.progress?.activityState === "needs_attention") return agent;

	const startedAt = agent.startedAt ? new Date(agent.startedAt).getTime() : undefined;
	if (!startedAt) return agent;

	const runtimeMs = now - startedAt;
	const thresholdMs = config.longRunningMinutes * 60 * 1000;
	if (runtimeMs <= thresholdMs) return agent;

	// Already flagged as long_running
	if (agent.progress?.activityState === "active_long_running") return agent;

	const updated: CrewAgentRecord = {
		...agent,
		progress: {
			...(agent.progress ?? {
				recentTools: [],
				recentOutput: [],
				toolCount: agent.toolUses ?? 0,
			}),
			activityState: "active_long_running",
		},
	};
	upsertCrewAgent(manifest, updated);
	appendTaskAttentionEvent({
		manifest,
		taskId: agent.taskId,
		message: `${agent.agent} has been running for ${Math.floor(runtimeMs / 60000)}m (threshold: ${config.longRunningMinutes}m).`,
		data: {
			activityState: "active_long_running",
			reason: "idle",
			elapsedMs: runtimeMs,
			taskId: agent.taskId,
			agentName: agent.agent,
			suggestedAction: "Check worker progress, steer, or cancel if needed.",
		},
	});
	return updated;
}

/** @internal */
function trackConsecutiveToolFailure(
	manifest: TeamRunManifest,
	agent: CrewAgentRecord,
	toolName: string,
	error: string | undefined,
	config: CrewControlConfig,
): CrewAgentRecord {
	if (!config.enabled || agent.status !== "running") return agent;

	const failures = agent.progress?.consecutiveFailures ?? 0;
	const newFailures = failures + 1;

	const updated: CrewAgentRecord = {
		...agent,
		progress: {
			...(agent.progress ?? {
				recentTools: [],
				recentOutput: [],
				toolCount: agent.toolUses ?? 0,
			}),
			consecutiveFailures: newFailures,
		},
	};

	if (newFailures >= config.consecutiveFailureThreshold) {
		upsertCrewAgent(manifest, updated);
		appendTaskAttentionEvent({
			manifest,
			taskId: agent.taskId,
			message: `${agent.agent} has ${newFailures} consecutive tool failures (threshold: ${config.consecutiveFailureThreshold}). Last: ${toolName}${error ? ` - ${error.slice(0, 100)}` : ""}`,
			data: {
				activityState: "needs_attention",
				reason: "tool_failures",
				taskId: agent.taskId,
				agentName: agent.agent,
				suggestedAction: "Investigate tool failures, steer, or cancel if needed.",
			},
		});
	} else {
		upsertCrewAgent(manifest, updated);
	}

	return updated;
}

/** @internal */
function resetConsecutiveToolFailures(manifest: TeamRunManifest, agent: CrewAgentRecord): void {
	if (!agent.progress?.consecutiveFailures) return;
	const updated: CrewAgentRecord = {
		...agent,
		progress: {
			...agent.progress,
			consecutiveFailures: 0,
		},
	};
	upsertCrewAgent(manifest, updated);
}

/**
 * Reserve a control channel for a task before spawning its worker.
 * This ensures cancel/steer requests can be queued immediately
 * while the worker is still starting up.
 */
export function reserveControlChannel(taskId: string, runId: string): ControlReservation {
	return {
		reservedAt: new Date().toISOString(),
		controllerId: `ctrl:${taskId}:${randomUUID()}`,
		acceptsControlEvents: true,
	};
}
