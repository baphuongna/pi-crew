import test from "node:test";
import assert from "node:assert/strict";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";

test("MetricRegistry registers, snapshots, and disposes metrics", () => {
	const registry = createMetricRegistry();
	registry.registerCounter("crew.run.count", "runs").inc({ status: "completed" });
	registry.registerGauge("crew.heartbeat.staleness_ms", "stale").set({ taskId: "a" }, 10);
	assert.equal(registry.snapshot().length, 2);
	assert.ok(registry.get("crew.run.count"));
	registry.dispose();
	assert.equal(registry.snapshot().length, 0);
	assert.equal(registry.get("crew.run.count"), undefined);
});

test("MetricRegistry rejects invalid and duplicate names", () => {
	const registry = createMetricRegistry();
	assert.throws(() => registry.registerCounter("bad.name", "bad"), /Invalid metric name/);
	registry.registerCounter("crew.run.count", "runs");
	assert.throws(() => registry.registerCounter("crew.run.count", "again"), /already registered/);
});

test("MetricRegistry convenience accessors reuse existing typed metrics", () => {
	const registry = createMetricRegistry();
	const first = registry.counter("crew.task.count", "tasks");
	const second = registry.counter("crew.task.count", "tasks");
	assert.equal(first, second);
});
