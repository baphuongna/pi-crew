import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MetricRegistry } from "./metric-registry.ts";

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

const CANCELLATION_REASON_LABELS = new Set([
	"caller_cancelled",
	"leader_interrupted",
	"provider_timeout",
	"worker_timeout",
	"tool_timeout",
	"shutdown",
	"unknown",
]);

function cancellationReasonLabel(value: unknown): string {
	const raw = stringValue(value, "unknown");
	return CANCELLATION_REASON_LABELS.has(raw) ? raw : "unknown";
}

export interface EventToMetricSubscription {
	dispose(): void;
}

export function wireEventToMetrics(events: ExtensionAPI["events"] | undefined, registry: MetricRegistry): EventToMetricSubscription {
	const runCount = registry.counter("crew.run.count", "Total runs by status");
	const taskCount = registry.counter("crew.task.count", "Total tasks by status");
	const subagentCount = registry.counter("crew.subagent.count", "Total subagent records by status");
	const mailboxCount = registry.counter("crew.mailbox.count", "Total mailbox messages by direction");
	const retryAttemptCount = registry.counter("crew.task.retry_attempt_total", "Total retry attempts");
	const deadletterCount = registry.counter("crew.task.deadletter_total", "Deadletter triggers by reason");
	const overflowCount = registry.counter("crew.task.overflow_phase_total", "Overflow recovery phase transitions");
	const supervisorContactCount = registry.counter("crew.task.supervisor_contact_total", "Supervisor contact requests by reason");
	registry.gauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds");
	const runDuration = registry.histogram(
		"crew.run.duration_ms",
		"Run end-to-end duration, milliseconds",
		[1000, 5000, 15000, 30000, 60000, 300000, 600000, 1800000],
	);
	const taskDuration = registry.histogram(
		"crew.task.duration_ms",
		"Task duration, milliseconds",
		[50, 200, 500, 1000, 5000, 30000, 120000],
	);
	registry.histogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]);
	const tokenUsage = registry.histogram("crew.task.tokens_total", "Token usage per task", [100, 500, 2000, 10000, 50000, 200000]);

	const handlers: Array<[string, (data: unknown) => void]> = [
		[
			"crew.run.completed",
			(data) => {
				const item = recordValue(data);
				runCount.inc({ status: "completed" });
				runDuration.observe({ team: stringValue(item.team, "unknown") }, numberValue(item.durationMs));
			},
		],
		["crew.run.failed", () => runCount.inc({ status: "failed" })],
		[
			"crew.run.cancelled",
			(data) => {
				const item = recordValue(data);
				runCount.inc({
					status: "cancelled",
					reason: cancellationReasonLabel(item.reason),
				});
			},
		],
		[
			"crew.task.completed",
			(data) => {
				const item = recordValue(data);
				taskCount.inc({ status: "completed" });
				taskDuration.observe({ role: stringValue(item.role, "unknown") }, numberValue(item.durationMs));
				tokenUsage.observe({ role: stringValue(item.role, "unknown") }, numberValue(item.tokens));
			},
		],
		["crew.task.failed", () => taskCount.inc({ status: "failed" })],
		["crew.task.needs_attention", () => taskCount.inc({ status: "needs_attention" })],
		[
			"crew.task.retry_attempt",
			(data) => {
				taskCount.inc({ status: "retry" });
				// Per-run/task detail lives in the event log (crew.task.retry_attempt).
				// Using runId/taskId as METRIC labels would blow up cardinality (each unique
				// run+task pair = a new series, silently LRU-evicted at MAX_LABEL_COMBINATIONS
				// = 10_000), making the counter unreliable for aggregation.
				retryAttemptCount.inc({});
			},
		],
		[
			"crew.task.deadletter",
			(data) => {
				const item = recordValue(data);
				deadletterCount.inc({
					reason: stringValue(item.reason, "unknown"),
				});
			},
		],
		[
			"crew.task.overflow",
			(data) => {
				const item = recordValue(data);
				overflowCount.inc({
					phase: stringValue(item.phase, "unknown"),
					previous_phase: stringValue(item.previousPhase, "none"),
				});
			},
		],
		[
			"supervisor.contact",
			(data) => {
				const item = recordValue(data);
				supervisorContactCount.inc({
					// reason is low-cardinality; taskId is NOT (unique per task) — dropped to
					// avoid cardinality blowup (OBS-1). Per-task detail is in the event log.
					reason: stringValue(item.reason, "unknown"),
				});
			},
		],
		[
			"crew.subagent.completed",
			(data) => {
				const item = recordValue(data);
				subagentCount.inc({
					status: stringValue(item.status, "completed"),
				});
			},
		],
		["crew.subagent.failed", () => subagentCount.inc({ status: "failed" })],
		[
			"crew.mailbox.message",
			(data) => {
				const item = recordValue(data);
				mailboxCount.inc({
					direction: stringValue(item.direction, "unknown"),
				});
			},
		],
	];

	const unsubscribers: Array<() => void> = [];
	for (const [event, handler] of handlers) {
		const unsubscribe = events?.on?.(event, (data: unknown) => {
			try {
				handler(data);
			} catch {
				/* metric handlers must never break event delivery */
			}
		});
		if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
	}
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
		},
	};
}
