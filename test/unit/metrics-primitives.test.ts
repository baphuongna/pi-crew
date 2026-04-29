import test from "node:test";
import assert from "node:assert/strict";
import { Counter, Gauge, Histogram, labelKey } from "../../src/observability/metrics-primitives.ts";

test("metric labels are stable regardless of insertion order", () => {
	assert.equal(labelKey({ b: 2, a: "x" }), labelKey({ a: "x", b: 2 }));
});

test("Counter increments labeled values", () => {
	const counter = new Counter("crew.run.count", "runs");
	counter.inc({ status: "completed" });
	counter.inc({ status: "completed" }, 2);
	assert.equal(counter.value({ status: "completed" }), 3);
	assert.equal(counter.snapshot().values.length, 1);
});

test("Gauge set and add update labeled values", () => {
	const gauge = new Gauge("crew.heartbeat.staleness_ms", "stale");
	gauge.set({ taskId: "a" }, 10);
	gauge.add({ taskId: "a" }, 5);
	assert.equal(gauge.value({ taskId: "a" }), 15);
});

test("Histogram observes values and computes approximate quantiles", () => {
	const hist = new Histogram("crew.run.duration_ms", "duration", [10, 100, 1000]);
	for (const value of [1, 5, 10, 20, 50, 100, 500]) hist.observe({ team: "x" }, value);
	assert.equal(hist.count({ team: "x" }), 7);
	assert.ok(hist.quantile({ team: "x" }, 0.5) >= 10);
	assert.ok(hist.quantile({ team: "x" }, 0.95) <= 1000);
	assert.equal(Number.isNaN(hist.quantile({ team: "missing" }, 0.5)), true);
});
