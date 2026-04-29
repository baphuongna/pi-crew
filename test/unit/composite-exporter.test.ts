import test from "node:test";
import assert from "node:assert/strict";
import { CompositeExporter, type MetricExporter } from "../../src/observability/exporters/adapter.ts";

test("CompositeExporter pushes to all exporters and disposes all", async () => {
	const calls: string[] = [];
	const exporter = (name: string, fail = false): MetricExporter => ({ name, async push() { calls.push(`push:${name}`); if (fail) throw new Error("boom"); }, dispose() { calls.push(`dispose:${name}`); } });
	const composite = new CompositeExporter([exporter("a"), exporter("b", true)]);
	await composite.push([]);
	composite.dispose();
	assert.deepEqual(calls.sort(), ["dispose:a", "dispose:b", "push:a", "push:b"].sort());
});
