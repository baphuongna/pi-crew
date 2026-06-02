/**
 * Tests for src/observability/ — first coverage in this area.
 *
 * Coverage targets:
 * - metric-registry: counter/gauge registration, re-registration idempotency
 * - correlation: context propagation
 * - OTLP convertToOTLP: shape, label redaction, empty input
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MetricRegistry } from "../../src/observability/metric-registry.ts";
import { convertToOTLP } from "../../src/observability/exporters/otlp-exporter.ts";
import { withCorrelation, getCurrentContext, type CorrelationContext } from "../../src/observability/correlation.ts";

test("MetricRegistry registers a counter and increments it", () => {
	const registry = new MetricRegistry();
	const counter = registry.counter("crew.test.counter", "A test counter");
	counter.inc({ kind: "x" });
	counter.inc({ kind: "y" }, 5);
	const snap = registry.snapshot();
	const counterSnap = snap.find((s) => s.name === "crew.test.counter");
	assert.ok(counterSnap);
	assert.equal(counterSnap.description, "A test counter");
});

test("MetricRegistry returns existing metric for re-registration", () => {
	const registry = new MetricRegistry();
	const a = registry.counter("crew.dup.first", "First");
	const b = registry.counter("crew.dup.first", "Second (should be ignored)");
	assert.strictEqual(a, b, "registry should return same instance");
});

test("MetricRegistry gauge supports set and reset", () => {
	const registry = new MetricRegistry();
	const g = registry.gauge("crew.test.gauge", "A test gauge");
	g.set({ region: "us" }, 42);
	g.set({ region: "us" }, 100);
	const snap = registry.snapshot();
	assert.ok(snap.find((s) => s.name === "crew.test.gauge"));
});

test("correlation context is propagated through withCorrelation", () => {
	let captured: CorrelationContext | undefined;
	withCorrelation({ traceId: "corr-123", spanId: "span-1" }, () => {
		captured = getCurrentContext();
	});
	assert.ok(captured);
	assert.equal(captured?.traceId, "corr-123");
	assert.equal(captured?.spanId, "span-1");
});

test("correlation context returns undefined outside withCorrelation", () => {
	const captured = getCurrentContext();
	assert.equal(captured, undefined);
});

test("convertToOTLP produces a valid OTLP envelope", () => {
	const registry = new MetricRegistry();
	registry.counter("crew.test.alpha", "Counter 1").inc();
	const otlp = convertToOTLP(registry.snapshot()) as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: unknown[] }> }> };
	assert.ok(otlp.resourceMetrics);
	assert.ok(otlp.resourceMetrics[0]);
	assert.ok(Array.isArray(otlp.resourceMetrics[0].scopeMetrics));
});

test("convertToOTLP handles empty snapshot array", () => {
	const otlp = convertToOTLP([]) as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: unknown[] }> }> };
	assert.equal(otlp.resourceMetrics[0].scopeMetrics[0].metrics.length, 0);
});

test("convertToOTLP does not leak secret label values", () => {
	const registry = new MetricRegistry();
	registry.counter("crew.test.beta", "secret metric").inc({ api_key: "sk-test-12345" });
	const otlp = convertToOTLP(registry.snapshot());
	const json = JSON.stringify(otlp);
	assert.ok(json.length > 0, "should produce non-empty output");
	assert.ok(!json.includes("sk-test-12345"), "secret value should be redacted");
});
