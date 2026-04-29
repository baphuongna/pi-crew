import test from "node:test";
import assert from "node:assert/strict";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { formatPrometheus } from "../../src/observability/exporters/prometheus-exporter.ts";

test("formatPrometheus renders counter, gauge, histogram and escaped labels", () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc({ status: "completed" });
	registry.gauge("crew.heartbeat.staleness_ms", "stale").set({ taskId: "a\"b" }, 5);
	registry.histogram("crew.run.duration_ms", "duration", [10]).observe({ team: "x" }, 8);
	const text = formatPrometheus(registry.snapshot());
	assert.match(text, /# TYPE crew_run_count counter/);
	assert.match(text, /crew_run_count\{status="completed"\} 1/);
	assert.match(text, /taskId="a\\"b"/);
	assert.match(text, /crew_run_duration_ms_bucket/);
});
