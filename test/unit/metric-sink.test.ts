import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { createMetricFileSink } from "../../src/observability/metric-sink.ts";

test("metric file sink writes redacted daily JSONL snapshots", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-metric-sink-"));
	try {
		const registry = createMetricRegistry();
		registry.counter("crew.run.count", "runs").inc({ auth_token: "secret" });
		const sink = createMetricFileSink({
			crewRoot: root,
			registry,
			intervalMs: 60_000,
		});
		sink.writeSnapshot(registry.snapshot());
		// OBS-2: writeSnapshot is now async (fire-and-forget fs.write). Wait one
		// event-loop tick for the callback to flush to disk before reading.
		await new Promise<void>((resolve) => setImmediate(resolve));
		sink.dispose();
		const dir = path.join(root, "state", "metrics");
		const files = fs.readdirSync(dir);
		assert.equal(files.length, 1);
		const text = fs.readFileSync(path.join(dir, files[0]!), "utf-8");
		assert.match(text, /crew\.run\.count/);
		assert.doesNotMatch(text, /secret/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
