import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";

describe("MetricRegistry registerCounter", () => {
	it("registers a counter and retrieves it via get", () => {
		const registry = createMetricRegistry();
		const counter = registry.registerCounter("crew.test.count", "test counter");
		counter.inc({}, 5);
		assert.equal(counter.value(), 5);
		assert.ok(registry.get("crew.test.count"));
		registry.dispose();
	});

	it("throws on duplicate counter registration", () => {
		const registry = createMetricRegistry();
		registry.registerCounter("crew.dup.count", "first");
		assert.throws(() => registry.registerCounter("crew.dup.count", "second"), /already registered/);
	});

	it("throws on invalid metric name", () => {
		const registry = createMetricRegistry();
		assert.throws(() => registry.registerCounter("bad", "x"), /Invalid metric name/);
		assert.throws(() => registry.registerCounter("crew.", "x"), /Invalid metric name/);
	});
});

describe("MetricRegistry registerGauge", () => {
	it("registers a gauge and sets value", () => {
		const registry = createMetricRegistry();
		const gauge = registry.registerGauge("crew.test.value", "test gauge");
		gauge.set({ tag: "a" }, 42);
		assert.equal(gauge.value({ tag: "a" }), 42);
		registry.dispose();
	});

	it("throws on duplicate gauge registration", () => {
		const registry = createMetricRegistry();
		registry.registerGauge("crew.dup.value", "first");
		assert.throws(() => registry.registerGauge("crew.dup.value", "second"), /already registered/);
	});
});

describe("MetricRegistry registerHistogram", () => {
	it("registers a histogram and observes values", () => {
		const registry = createMetricRegistry();
		const hist = registry.registerHistogram("crew.test.duration", "test histogram", [1, 5, 10]);
		hist.observe({}, 3);
		hist.observe({}, 7);
		assert.equal(hist.count(), 2);
		registry.dispose();
	});

	it("throws on duplicate histogram registration", () => {
		const registry = createMetricRegistry();
		registry.registerHistogram("crew.dup.duration", "first");
		assert.throws(() => registry.registerHistogram("crew.dup.duration", "second"), /already registered/);
	});
});

describe("MetricRegistry counter (convenience)", () => {
	it("returns existing counter on subsequent calls", () => {
		const registry = createMetricRegistry();
		const first = registry.counter("crew.conv.count", "conv");
		const second = registry.counter("crew.conv.count", "conv");
		assert.equal(first, second);
	});

	it("throws if name is already used by a different type", () => {
		const registry = createMetricRegistry();
		registry.registerGauge("crew.conv.gauge", "g");
		assert.throws(() => registry.counter("crew.conv.gauge", "c"), /not a counter/);
	});
});

describe("MetricRegistry gauge (convenience)", () => {
	it("returns existing gauge on subsequent calls", () => {
		const registry = createMetricRegistry();
		const first = registry.gauge("crew.conv.val", "conv");
		const second = registry.gauge("crew.conv.val", "conv");
		assert.equal(first, second);
	});

	it("throws if name is already used by a different type", () => {
		const registry = createMetricRegistry();
		registry.registerCounter("crew.conv.count", "c");
		assert.throws(() => registry.gauge("crew.conv.count", "g"), /not a gauge/);
	});
});

describe("MetricRegistry histogram (convenience)", () => {
	it("returns existing histogram on subsequent calls", () => {
		const registry = createMetricRegistry();
		const first = registry.histogram("crew.conv.dur", "conv");
		const second = registry.histogram("crew.conv.dur", "conv");
		assert.equal(first, second);
	});

	it("throws if name is already used by a different type", () => {
		const registry = createMetricRegistry();
		registry.registerCounter("crew.conv.cnt", "c");
		assert.throws(() => registry.histogram("crew.conv.cnt", "h"), /not a histogram/);
	});
});

describe("MetricRegistry snapshot", () => {
	it("returns all registered metrics in snapshot", () => {
		const registry = createMetricRegistry();
		registry.registerCounter("crew.snap.count", "counter");
		registry.registerGauge("crew.snap.value", "gauge");
		registry.registerHistogram("crew.snap.duration", "histogram");
		const snap = registry.snapshot();
		assert.equal(snap.length, 3);
		const types = snap.map((s) => s.type);
		assert.ok(types.includes("counter"));
		assert.ok(types.includes("gauge"));
		assert.ok(types.includes("histogram"));
		registry.dispose();
	});
});

describe("MetricRegistry dispose", () => {
	it("clears all metrics", () => {
		const registry = createMetricRegistry();
		registry.registerCounter("crew.dispose.count", "c");
		registry.dispose();
		assert.equal(registry.snapshot().length, 0);
		assert.equal(registry.get("crew.dispose.count"), undefined);
	});
});

describe("MetricRegistry get", () => {
	it("returns undefined for unknown metric", () => {
		const registry = createMetricRegistry();
		assert.equal(registry.get("crew.unknown.metric"), undefined);
	});
});
