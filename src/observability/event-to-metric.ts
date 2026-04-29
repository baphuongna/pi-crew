import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { MetricRegistry } from "./metric-registry.ts";

function recordValue(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export interface EventToMetricSubscription {
	dispose(): void;
}

export function wireEventToMetrics(events: ExtensionAPI["events"] | undefined, registry: MetricRegistry): EventToMetricSubscription {
	const runCount = registry.counter("crew.run.count", "Total runs by status");
	const taskCount = registry.counter("crew.task.count", "Total tasks by status");
	const subagentCount = registry.counter("crew.subagent.count", "Total subagent records by status");
	const mailboxCount = registry.counter("crew.mailbox.count", "Total mailbox messages by direction");
	registry.counter("crew.task.deadletter_total", "Deadletter triggers by reason");
	registry.gauge("crew.heartbeat.staleness_ms", "Heartbeat elapsed since last seen, milliseconds");
	const runDuration = registry.histogram("crew.run.duration_ms", "Run end-to-end duration, milliseconds");
	const taskDuration = registry.histogram("crew.task.duration_ms", "Task duration, milliseconds");
	registry.histogram("crew.task.retry_count", "Retries per task", [0, 1, 2, 3, 5, 10]);
	const tokenUsage = registry.histogram("crew.task.tokens_total", "Token usage per task");

	const handlers: Array<[string, (data: unknown) => void]> = [
		["crew.run.completed", (data) => { const item = recordValue(data); runCount.inc({ status: "completed" }); runDuration.observe({ team: stringValue(item.team, "unknown") }, numberValue(item.durationMs)); }],
		["crew.run.failed", () => runCount.inc({ status: "failed" })],
		["crew.run.cancelled", () => runCount.inc({ status: "cancelled" })],
		["crew.task.completed", (data) => { const item = recordValue(data); taskCount.inc({ status: "completed" }); taskDuration.observe({ role: stringValue(item.role, "unknown") }, numberValue(item.durationMs)); tokenUsage.observe({ role: stringValue(item.role, "unknown") }, numberValue(item.tokens)); }],
		["crew.task.failed", () => taskCount.inc({ status: "failed" })],
		["crew.task.retry_attempt", (data) => { const item = recordValue(data); taskCount.inc({ status: "retry" }); registry.counter("crew.task.retry_attempt_total", "Retry attempts by run and task").inc({ runId: stringValue(item.runId, "unknown"), taskId: stringValue(item.taskId, "unknown") }); }],
		["crew.task.deadletter", (data) => { const item = recordValue(data); registry.counter("crew.task.deadletter_total", "Deadletter triggers by reason").inc({ reason: stringValue(item.reason, "unknown") }); }],
		["crew.subagent.completed", (data) => { const item = recordValue(data); subagentCount.inc({ status: stringValue(item.status, "completed") }); }],
		["crew.subagent.failed", () => subagentCount.inc({ status: "failed" })],
		["crew.mailbox.message", (data) => { const item = recordValue(data); mailboxCount.inc({ direction: stringValue(item.direction, "unknown") }); }],
	];

	const unsubscribers: Array<() => void> = [];
	for (const [event, handler] of handlers) {
		const unsubscribe = events?.on?.(event, (data: unknown) => {
			try { handler(data); } catch { /* metric handlers must never break event delivery */ }
		});
		if (typeof unsubscribe === "function") unsubscribers.push(unsubscribe);
	}
	let disposed = false;
	return { dispose() { if (disposed) return; disposed = true; for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); } };
}
