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

test("OTLPExporter.dispose() awaits in-flight push (Round 23 resource cleanup)", async () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc();
	const previous = globalThis.fetch;
	let resolveFetch: ((value: Response) => void) | undefined;
	const fetchPromise = new Promise<Response>((resolve) => { resolveFetch = resolve; });
	globalThis.fetch = async () => fetchPromise;
	try {
		const exporter = new OTLPExporter({ endpoint: "http://collector/v1/metrics", intervalMs: 60_000, timeoutMs: 5_000 }, registry);

		// Start a push but don't await it — it's now in-flight.
		const pushPromise = exporter.push(registry.snapshot());
		// Give the microtask queue a chance to assign inFlight.
		await new Promise((resolve) => setImmediate(resolve));

		// dispose() should now return a Promise that resolves AFTER the
		// in-flight push completes.
		const disposePromise = exporter.dispose();

		// Resolve the fetch — the in-flight push will then complete.
		if (resolveFetch) resolveFetch(new Response("ok"));
		await pushPromise;
		await disposePromise;

		// If we got here without timing out, dispose() correctly awaited inFlight.
		assert.ok(true, "dispose() awaited in-flight push before resolving");
	} finally {
		globalThis.fetch = previous;
	}
});
