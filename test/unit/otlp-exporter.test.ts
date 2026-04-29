import test from "node:test";
import assert from "node:assert/strict";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { convertToOTLP, OTLPExporter } from "../../src/observability/exporters/otlp-exporter.ts";

test("convertToOTLP produces resource metrics", () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc({ status: "completed" });
	assert.match(JSON.stringify(convertToOTLP(registry.snapshot())), /resourceMetrics/);
});

test("OTLPExporter pushes via fetch and disposes timer", async () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc();
	const previous = globalThis.fetch;
	let called = 0;
	globalThis.fetch = async () => { called += 1; return new Response("ok"); };
	try {
		const exporter = new OTLPExporter({ endpoint: "http://collector/v1/metrics", intervalMs: 60_000, timeoutMs: 100 }, registry);
		await exporter.push(registry.snapshot());
		exporter.start();
		exporter.dispose();
		assert.equal(called, 1);
	} finally {
		globalThis.fetch = previous;
	}
});
