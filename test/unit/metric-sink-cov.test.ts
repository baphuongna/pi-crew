import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { createMetricFileSink } from "../../src/observability/metric-sink.ts";
import {
	createTrackedTempDir,
	removeTrackedTempDir,
} from "../fixtures/test-tempdir.ts";

describe("createMetricFileSink", () => {
	it("writes a snapshot to a JSONL file", () => {
		const dir = createTrackedTempDir("pi-crew-sink-");
		try {
			const registry = createMetricRegistry();
			registry.registerCounter("crew.sink.count", "test counter").inc({}, 1);
			const sink = createMetricFileSink({ crewRoot: dir, registry, intervalMs: 60_000 });
			sink.writeSnapshot(registry.snapshot());
			sink.dispose();

			const metricsDir = path.join(dir, "state", "metrics");
			const files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".jsonl"));
			assert.equal(files.length, 1);
			const content = fs.readFileSync(path.join(metricsDir, files[0]!), "utf-8");
			assert.ok(content.includes("crew.sink.count"));
			assert.ok(content.includes("exportedAt"));
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("redacts secrets from snapshots", () => {
		const dir = createTrackedTempDir("pi-crew-sink-");
		try {
			const registry = createMetricRegistry();
			registry.counter("crew.sink.count", "test").inc({ api_key: "super-secret-123" }, 1);
			const sink = createMetricFileSink({ crewRoot: dir, registry, intervalMs: 60_000 });
			sink.writeSnapshot(registry.snapshot());
			sink.dispose();

			const metricsDir = path.join(dir, "state", "metrics");
			const files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".jsonl"));
			const content = fs.readFileSync(path.join(metricsDir, files[0]!), "utf-8");
			assert.ok(!content.includes("super-secret-123"));
			assert.ok(content.includes("***"));
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("handles multiple write calls", () => {
		const dir = createTrackedTempDir("pi-crew-sink-");
		try {
			const registry = createMetricRegistry();
			const counter = registry.registerCounter("crew.multi.count", "multi");
			const sink = createMetricFileSink({ crewRoot: dir, registry, intervalMs: 60_000 });

			counter.inc({}, 1);
			sink.writeSnapshot(registry.snapshot());
			counter.inc({}, 2);
			sink.writeSnapshot(registry.snapshot());
			sink.dispose();

			const metricsDir = path.join(dir, "state", "metrics");
			const files = fs.readdirSync(metricsDir).filter((f) => f.endsWith(".jsonl"));
			assert.equal(files.length, 1);
			const content = fs.readFileSync(path.join(metricsDir, files[0]!), "utf-8");
			const lines = content.trim().split("\n");
			assert.equal(lines.length, 2);
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("rotates old files based on retentionDays", () => {
		const dir = createTrackedTempDir("pi-crew-sink-");
		try {
			const metricsDir = path.join(dir, "state", "metrics");
			fs.mkdirSync(metricsDir, { recursive: true });

			// Create an old file
			const oldFile = path.join(metricsDir, "2020-01-01.jsonl");
			fs.writeFileSync(oldFile, '{"old": true}\n', "utf-8");
			// Set mtime to 30 days ago
			const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000;
			fs.utimesSync(oldFile, new Date(oldTime), new Date(oldTime));

			const registry = createMetricRegistry();
			registry.registerCounter("crew.rotate.count", "rotate");
			const sink = createMetricFileSink({
				crewRoot: dir,
				registry,
				retentionDays: 7,
				intervalMs: 60_000,
			});
			sink.writeSnapshot(registry.snapshot());
			sink.dispose();

			const files = fs.readdirSync(metricsDir);
			assert.ok(!files.includes("2020-01-01.jsonl"), "old file should be rotated");
			assert.ok(files.some((f) => f !== "2020-01-01.jsonl"), "new file should exist");
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("creates metrics directory if it does not exist", () => {
		const dir = createTrackedTempDir("pi-crew-sink-");
		try {
			const registry = createMetricRegistry();
			registry.registerCounter("crew.mkdir.count", "mkdir");
			const sink = createMetricFileSink({ crewRoot: dir, registry, intervalMs: 60_000 });
			sink.writeSnapshot(registry.snapshot());
			sink.dispose();

			const metricsDir = path.join(dir, "state", "metrics");
			assert.ok(fs.existsSync(metricsDir));
		} finally {
			removeTrackedTempDir(dir);
		}
	});

	it("dispose is idempotent and does not throw", () => {
		const dir = createTrackedTempDir("pi-crew-sink-");
		try {
			const registry = createMetricRegistry();
			const sink = createMetricFileSink({ crewRoot: dir, registry, intervalMs: 60_000 });
			sink.writeSnapshot(registry.snapshot());
			sink.dispose();
			// Second dispose should not throw
			assert.doesNotThrow(() => sink.dispose());
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
