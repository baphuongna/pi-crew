import test from "node:test";
import assert from "node:assert/strict";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { wireEventToMetrics } from "../../src/observability/event-to-metric.ts";

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
		count(channel: string) { return handlers.get(channel)?.size ?? 0; },
	};
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
