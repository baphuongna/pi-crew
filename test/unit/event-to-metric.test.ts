import assert from "node:assert/strict";
import test from "node:test";
import { wireEventToMetrics } from "../../src/observability/event-to-metric.ts";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";

function eventBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, handler: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => set.delete(handler);
		},
		emit(channel: string, data: unknown) {
			for (const handler of handlers.get(channel) ?? []) handler(data);
		},
		count(channel: string) {
			return handlers.get(channel)?.size ?? 0;
		},
	};
}

function counterValue(registry: ReturnType<typeof createMetricRegistry>, name: string, labels: Record<string, string>): number {
	const metric = registry.get(name);
	const value = metric?.snapshot().values.find((entry) => JSON.stringify(entry.labels) === JSON.stringify(labels));
	return value && "value" in value ? value.value : 0;
}

test("wireEventToMetrics maps core crew events and disposes subscribers", () => {
	const bus = eventBus();
	const registry = createMetricRegistry();
	const sub = wireEventToMetrics(bus, registry);
	bus.emit("crew.run.completed", { team: "research", durationMs: 12 });
	bus.emit("crew.mailbox.message", { direction: "inbox" });
	assert.match(JSON.stringify(registry.snapshot()), /crew\.run\.count/);
	assert.ok(bus.count("crew.run.completed") > 0);
	sub.dispose();
	assert.equal(bus.count("crew.run.completed"), 0);
	sub.dispose();
});

test("wireEventToMetrics labels cancelled runs by structured reason", () => {
	const bus = eventBus();
	const registry = createMetricRegistry();
	wireEventToMetrics(bus, registry);
	bus.emit("crew.run.cancelled", { reason: "leader_interrupted" });
	bus.emit("crew.run.cancelled", { reason: "unexpected-provider-text" });
	assert.equal(
		counterValue(registry, "crew.run.count", {
			reason: "leader_interrupted",
			status: "cancelled",
		}),
		1,
	);
	assert.equal(
		counterValue(registry, "crew.run.count", {
			reason: "unknown",
			status: "cancelled",
		}),
		1,
	);
});

test("wireEventToMetrics does NOT use high-cardinality runId/taskId as metric labels (OBS-1)", () => {
	const bus = eventBus();
	const registry = createMetricRegistry();
	wireEventToMetrics(bus, registry);
	// 100 distinct run+task pairs must aggregate into ONE series, not 100 — otherwise
	// each unique pair creates a metric series that silently LRU-evicts at the 10k cap.
	for (let i = 0; i < 100; i++) {
		bus.emit("crew.task.retry_attempt", { runId: `run-${i}`, taskId: `task-${i}` });
		bus.emit("supervisor.contact", { reason: "stuck", taskId: `task-${i}` });
	}
	const retryValues = (registry.get("crew.task.retry_attempt_total")?.snapshot().values ?? []) as Array<{ value: number }>;
	const supervisorValues = (registry.get("crew.task.supervisor_contact_total")?.snapshot().values ?? []) as Array<{
		value: number;
	}>;
	assert.equal(retryValues.length, 1, "retry counter must be label-less (1 series), not per-run/task");
	assert.equal(retryValues[0]?.value, 100);
	assert.equal(supervisorValues.length, 1, "supervisor counter must group by reason only (taskId dropped)");
	assert.equal(supervisorValues[0]?.value, 100);
});
