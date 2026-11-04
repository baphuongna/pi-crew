import assert from "node:assert/strict";
import test from "node:test";
import { Counter, Gauge, getCardinalityEvictions, Histogram, labelKey } from "../../../src/observability/metrics-primitives.ts";

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

test("Counter MRU eviction: actively-used label survives cap", () => {
	const counter = new Counter("test.mru", "mru test");
	// Add "anchor" label first — this is the oldest
	counter.inc({ id: "anchor" }, 1);
	assert.equal(counter.value({ id: "anchor" }), 1);
	// Verify the anchor value is still accessible
	assert.equal(counter.value({ id: "anchor" }), 1);
});

test("Counter delete-then-set preserves value after re-insertion", () => {
	const counter = new Counter("test.preserve", "preserve test");
	counter.inc({ id: "x" }, 42);
	// Update existing key — should not lose value
	counter.inc({ id: "x" }, 8);
	assert.equal(counter.value({ id: "x" }), 50);
});

test("Gauge delete-then-set preserves value after re-insertion", () => {
	const gauge = new Gauge("test.gauge_preserve", "gauge preserve test");
	gauge.set({ id: "y" }, 100);
	gauge.set({ id: "y" }, 200);
	assert.equal(gauge.value({ id: "y" }), 200);
});

// ---------------------------------------------------------------- LABEL-GC
test("Counter.releaseLabelValues drops only matching series", () => {
	const counter = new Counter("test.release_counter", "release test");
	counter.inc({ runId: "r1", level: "healthy" }, 3);
	counter.inc({ runId: "r1", level: "dead" }, 1);
	counter.inc({ runId: "r2", level: "healthy" }, 5);

	assert.equal(
		counter.releaseLabelValues((labels) => labels.runId === "r1"),
		2,
		"both r1 series dropped",
	);
	const values = counter.snapshot().values;
	assert.equal(values.length, 1);
	assert.deepEqual(values[0]?.labels, { level: "healthy", runId: "r2" });
	assert.equal(counter.value({ runId: "r2", level: "healthy" }), 5, "non-matching value retained");
	assert.equal(counter.value({ runId: "r1", level: "healthy" }), 0, "matching value gone");
});

test("Gauge.releaseLabelValues drops only matching series", () => {
	const gauge = new Gauge("test.release_gauge", "release test");
	gauge.set({ runId: "r1", taskId: "t1" }, 10);
	gauge.set({ runId: "r2", taskId: "t2" }, 20);

	assert.equal(
		gauge.releaseLabelValues((labels) => labels.runId === "r1"),
		1,
	);
	const values = gauge.snapshot().values;
	assert.equal(values.length, 1);
	assert.deepEqual(values[0]?.labels, { runId: "r2", taskId: "t2" });
	assert.equal(gauge.value({ runId: "r2", taskId: "t2" }), 20);
});

test("Histogram.releaseLabelValues is a no-op (base default)", () => {
	const hist = new Histogram("test.release_hist", "release test", [10]);
	hist.observe({ runId: "r1" }, 3);
	assert.equal(
		hist.releaseLabelValues((labels) => labels.runId === "r1"),
		0,
	);
	assert.equal(hist.count({ runId: "r1" }), 1, "observation untouched");
});

test("releaseLabelValues does not count as a cardinality eviction", () => {
	const before = getCardinalityEvictions();
	const counter = new Counter("test.release_evictions", "release test");
	counter.inc({ runId: "r1" }, 1);
	counter.releaseLabelValues(() => true);
	assert.equal(getCardinalityEvictions(), before, "deliberate release is not an eviction");
});
