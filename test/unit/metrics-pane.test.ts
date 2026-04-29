import test from "node:test";
import assert from "node:assert/strict";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { renderMetricsPane } from "../../src/ui/dashboard-panes/metrics-pane.ts";

test("renderMetricsPane reports unavailable or empty registry", () => {
	assert.match(renderMetricsPane(undefined)[0]!, /unavailable/);
	assert.match(renderMetricsPane(undefined, { registry: createMetricRegistry() })[0]!, /no metrics/);
});

test("renderMetricsPane renders counters and histogram p95", () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc({ status: "completed" });
	registry.histogram("crew.run.duration_ms", "duration").observe({ team: "x" }, 42);
	const text = renderMetricsPane(undefined, { registry }).join("\n");
	assert.match(text, /crew\.run\.count/);
	assert.match(text, /p95=/);
});
