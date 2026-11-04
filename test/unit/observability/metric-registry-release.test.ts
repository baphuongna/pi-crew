import assert from "node:assert/strict";
import test from "node:test";
import { createMetricRegistry } from "../../../src/observability/metric-registry.ts";
import type { MetricSnapshot } from "../../../src/observability/metrics-primitives.ts";

/** Labels of every stored series for one metric in a registry snapshot. */
function labelSets(snapshot: MetricSnapshot[], name: string): Record<string, unknown>[] {
	const metric = snapshot.find((entry) => entry.name === name);
	assert.ok(metric, `metric ${name} present`);
	return (metric.values as { labels: Record<string, unknown> }[]).map((point) => point.labels);
}

/**
 * FIX 2 (LABEL-GC): run-scoped metric label values must be droppable through
 * the registry (runId labels otherwise accumulate forever — the
 * MAX_LABEL_COMBINATIONS FIFO cap is never reached at realistic volumes).
 */
test("MetricRegistry.releaseLabels drops matching series from counters AND gauges", () => {
	const registry = createMetricRegistry();
	const levels = registry.counter("crew.heartbeat.level_total", "levels");
	levels.inc({ runId: "r1", level: "healthy" });
	levels.inc({ runId: "r2", level: "dead" });
	const staleness = registry.gauge("crew.heartbeat.staleness_ms", "stale");
	staleness.set({ runId: "r1", taskId: "t1" }, 10);
	staleness.set({ runId: "r2", taskId: "t2" }, 20);
	// Histograms are not run-scoped and must be untouched by a release.
	registry.histogram("crew.task.duration_ms", "duration", [10]).observe({ runId: "r1" }, 3);

	assert.equal(
		registry.releaseLabels((labels) => labels.runId === "r1"),
		2,
		"counter series + gauge series",
	);

	const snapshot = registry.snapshot();
	assert.deepEqual(labelSets(snapshot, "crew.heartbeat.level_total"), [{ level: "dead", runId: "r2" }]);
	assert.deepEqual(labelSets(snapshot, "crew.heartbeat.staleness_ms"), [{ runId: "r2", taskId: "t2" }]);
	assert.equal(labelSets(snapshot, "crew.task.duration_ms").length, 1, "histogram observation retained");
});

test("MetricRegistry.releaseLabels is a no-op when no series matches", () => {
	const registry = createMetricRegistry();
	registry.counter("crew.heartbeat.level_total", "levels").inc({ runId: "r1", level: "healthy" });
	assert.equal(
		registry.releaseLabels((labels) => labels.runId === "absent"),
		0,
	);
	assert.equal(labelSets(registry.snapshot(), "crew.heartbeat.level_total").length, 1);
});

test("MetricRegistry.releaseLabels returns 0 on an empty registry", () => {
	assert.equal(
		createMetricRegistry().releaseLabels(() => true),
		0,
	);
});
