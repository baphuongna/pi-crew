import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getRunMetricsSummary, loadRunMetrics, type RunMetrics, saveRunMetrics } from "../../../../src/state/stores/run-metrics.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const SAMPLE_METRICS: RunMetrics = {
	runId: "run-001",
	timestamp: "2026-06-04T00:00:00.000Z",
	taskCount: 5,
	completedCount: 4,
	failedCount: 1,
	totalTokens: 1000,
	totalCost: 0.05,
	durationMs: 5000,
	consistencyScore: 0.8,
};

describe("saveRunMetrics / loadRunMetrics", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-metrics-");
	});

	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("saves and loads metrics round-trip", () => {
		saveRunMetrics(tmpDir, SAMPLE_METRICS);
		const loaded = loadRunMetrics(tmpDir, "run-001");
		assert.ok(loaded);
		assert.equal(loaded.runId, "run-001");
		assert.equal(loaded.taskCount, 5);
		assert.equal(loaded.completedCount, 4);
		assert.equal(loaded.failedCount, 1);
		assert.equal(loaded.totalTokens, 1000);
		assert.equal(loaded.totalCost, 0.05);
		assert.equal(loaded.durationMs, 5000);
		assert.equal(loaded.consistencyScore, 0.8);
	});

	it("returns undefined for non-existent metrics", () => {
		assert.equal(loadRunMetrics(tmpDir, "nonexistent"), undefined);
	});

	it("creates metrics directory if it does not exist", () => {
		const subDir = path.join(tmpDir, "nested");
		fs.mkdirSync(subDir, { recursive: true });
		saveRunMetrics(subDir, SAMPLE_METRICS);
		const loaded = loadRunMetrics(subDir, "run-001");
		assert.ok(loaded);
	});

	it("overwrites existing metrics with same runId", () => {
		saveRunMetrics(tmpDir, SAMPLE_METRICS);
		const updated: RunMetrics = { ...SAMPLE_METRICS, totalTokens: 2000 };
		saveRunMetrics(tmpDir, updated);
		const loaded = loadRunMetrics(tmpDir, "run-001");
		assert.ok(loaded);
		assert.equal(loaded.totalTokens, 2000);
	});
});

describe("getRunMetricsSummary", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTrackedTempDir("pi-crew-metrics-summary-");
		fs.mkdirSync(path.join(tmpDir, ".crew"), { recursive: true });
	});

	afterEach(() => {
		removeTrackedTempDir(tmpDir);
	});

	it("returns empty array when no metrics saved", () => {
		assert.deepEqual(getRunMetricsSummary(tmpDir), []);
	});

	it("returns saved metrics sorted newest first", () => {
		saveRunMetrics(tmpDir, {
			runId: "run-a",
			timestamp: "2026-06-03T00:00:00.000Z",
			taskCount: 3,
			completedCount: 3,
			failedCount: 0,
			totalTokens: 500,
			totalCost: 0.01,
			durationMs: 3000,
			consistencyScore: 1.0,
		});
		saveRunMetrics(tmpDir, {
			runId: "run-b",
			timestamp: "2026-06-04T00:00:00.000Z",
			taskCount: 2,
			completedCount: 1,
			failedCount: 1,
			totalTokens: 200,
			totalCost: 0.02,
			durationMs: 1000,
			consistencyScore: 0.5,
		});
		const summary = getRunMetricsSummary(tmpDir);
		assert.equal(summary.length, 2);
		assert.equal(summary[0]!.runId, "run-b", "newest should be first");
		assert.equal(summary[1]!.runId, "run-a");
	});

	it("respects the limit parameter", () => {
		for (let i = 0; i < 5; i++) {
			saveRunMetrics(tmpDir, {
				runId: `run-${i}`,
				timestamp: `2026-06-04T00:0${i}:00.000Z`,
				taskCount: 1,
				completedCount: 1,
				failedCount: 0,
				totalTokens: 100,
				totalCost: 0,
				durationMs: 1000,
				consistencyScore: 1.0,
			});
		}
		const summary = getRunMetricsSummary(tmpDir, 3);
		assert.equal(summary.length, 3);
	});

	it("skips non-JSON files gracefully", () => {
		const metricsDir = path.join(tmpDir, ".crew", "state", "metrics");
		fs.mkdirSync(metricsDir, { recursive: true });
		fs.writeFileSync(path.join(metricsDir, "notes.txt"), "not json");
		saveRunMetrics(tmpDir, SAMPLE_METRICS);
		const summary = getRunMetricsSummary(tmpDir);
		assert.equal(summary.length, 1);
	});
});
