/**
 * FIND-04 regression test: getRunMetricsSummary must sort dirents by
 * mtime DESCENDING and read ONLY `limit` files (not MAX_METRIC_FILES_TO_SCAN).
 *
 * Previously the function read up to MAX_METRIC_FILES_TO_SCAN (500) files
 * via loadRunMetrics (readFileSync + JSON.parse) BEFORE sorting+slicing
 * to `limit` (default 25). On a hot dashboard path with hundreds of runs,
 * this was 475 wasted file reads per call.
 *
 * The fix:
 *   1. Sort dirents by mtimeMs descending (with filename tiebreaker for
 *      determinism), with a total cap of MAX_METRIC_FILES_TO_SCAN
 *      considered for the sort (safety valve).
 *   2. Read ONLY the first `limit` entries from the sorted list.
 *
 * Test strategy: spy on fs.readFileSync to count how many metric files
 * were actually opened during a limit=5 query against 30 metric files
 * with different mtimes. The test must observe exactly 5 reads (not 30
 * and not 500).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as path from "node:path";
import test from "node:test";
import { getRunMetricsSummary, type RunMetrics, saveRunMetrics } from "../../src/state/run-metrics.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../fixtures/test-tempdir.ts";

/**
 * Count fs.readFileSync calls that target a metric file
 * (path ending in `.json` inside the test's metrics dir). The original
 * readFileSync is preserved and restored in the returned cleanup. The
 * swap is done via the default-export view of node:fs (the named-export
 * namespace is read-only; syncBuiltinESMExports() refreshes it after the
 * default is mutated).
 */
function countMetricReads(metricsDir: string): { count: () => number; restore: () => void } {
	const fsDefault = (fs as unknown as { default?: typeof fs }).default ?? (fs as unknown as typeof fs);
	const original = (fsDefault as { readFileSync: typeof fs.readFileSync }).readFileSync;
	let calls = 0;
	const wrapped = ((target: fs.PathLike, ...rest: unknown[]) => {
		try {
			const resolved = path.resolve(typeof target === "string" ? target : target.toString());
			if (resolved.startsWith(path.resolve(metricsDir) + path.sep) && resolved.endsWith(".json")) {
				calls++;
			}
		} catch {
			/* ignore path normalization errors */
		}
		return (original as (...a: unknown[]) => string | Buffer).call(fsDefault, target, ...rest);
	}) as typeof fs.readFileSync;
	(fsDefault as { readFileSync: typeof fs.readFileSync }).readFileSync = wrapped;
	syncBuiltinESMExports();
	return {
		count: () => calls,
		restore: () => {
			(fsDefault as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
			syncBuiltinESMExports();
		},
	};
}

function makeMetric(runId: string, timestamp: string): RunMetrics {
	return {
		runId,
		timestamp,
		taskCount: 1,
		completedCount: 1,
		failedCount: 0,
		totalTokens: 100,
		totalCost: 0.01,
		durationMs: 1000,
		consistencyScore: 1.0,
	};
}

test("getRunMetricsSummary only reads `limit` files (not MAX_METRIC_FILES_TO_SCAN)", () => {
	const tmpDir = createTrackedTempDir("pi-crew-metrics-scan-");
	fs.mkdirSync(path.join(tmpDir, ".crew"), { recursive: true });
	try {
		// Create 30 metric files with different mtimes. The mtime ordering
		// is created by writing the files in order (each write bumps
		// mtime) — but we explicitly set mtime via utimes to make the
		// ordering deterministic and independent of write timing.
		const metricsDir = path.join(tmpDir, ".crew", "state", "metrics");
		fs.mkdirSync(metricsDir, { recursive: true });
		const total = 30;
		const newestFirst: string[] = [];
		for (let i = 0; i < total; i++) {
			// Oldest first (i=0 oldest, i=29 newest).
			const runId = `team_20260720${String(i).padStart(6, "0")}_aaaa${i}`;
			const ts = new Date(Date.UTC(2026, 6, 20, 0, 0, i)).toISOString();
			saveRunMetrics(tmpDir, makeMetric(runId, ts));
			// Force mtime so the sort sees the intended order regardless
			// of saveRunMetrics' atomic-write (which uses rename and may
			// collapse multiple writes to the same second).
			const filePath = path.join(metricsDir, `${runId}.json`);
			const baseMtime = Date.UTC(2026, 6, 20, 0, 0, 0) + i * 1000; // 1s apart
			fs.utimesSync(filePath, new Date(baseMtime), new Date(baseMtime));
			newestFirst.unshift(runId); // newest is i=29 → pushed first
		}

		const counter = countMetricReads(metricsDir);
		try {
			// request only 5; we must observe exactly 5 metric-file reads
			const summary = getRunMetricsSummary(tmpDir, 5);
			const reads = counter.count();
			assert.equal(summary.length, 5, "limit=5 must return 5 entries");
			assert.equal(reads, 5, `expected exactly 5 metric-file reads (limit=5 against ${total} files); got ${reads}`);
			// The 5 returned must be the 5 newest (mtime DESC). We don't
			// assume the exact newestFirst[0..5] because the safety cap
			// (MAX_METRIC_FILES_TO_SCAN) and the sort tiebreaker could
			// shuffle — but we DO assert the 5 returned are the top-5 of
			// the 30 we created (in mtime order).
			const summaryIds = summary.map((m) => m.runId);
			const top5 = newestFirst.slice(0, 5);
			for (const id of top5) {
				assert.ok(summaryIds.includes(id), `top-5 must include ${id}; got ${summaryIds.join(",")}`);
			}
		} finally {
			counter.restore();
		}
	} finally {
		removeTrackedTempDir(tmpDir);
	}
});

test("getRunMetricsSummary counts malformed newest files against the strict read limit", () => {
	const tmpDir = createTrackedTempDir("pi-crew-metrics-scan-invalid-");
	fs.mkdirSync(path.join(tmpDir, ".crew"), { recursive: true });
	try {
		const metricsDir = path.join(tmpDir, ".crew", "state", "metrics");
		fs.mkdirSync(metricsDir, { recursive: true });
		const base = Date.UTC(2026, 6, 20, 0, 0, 0);

		for (let i = 0; i < 3; i++) {
			const runId = `valid-${i}`;
			saveRunMetrics(tmpDir, makeMetric(runId, new Date(base + i * 1000).toISOString()));
			fs.utimesSync(path.join(metricsDir, `${runId}.json`), new Date(base + (i + 1) * 1000), new Date(base + (i + 1) * 1000));
		}
		for (let i = 0; i < 2; i++) {
			const filePath = path.join(metricsDir, `invalid-newest-${i}.json`);
			fs.writeFileSync(filePath, "not valid JSON", "utf-8");
			fs.utimesSync(filePath, new Date(base + (i + 4) * 1000), new Date(base + (i + 4) * 1000));
		}

		const strictCounter = countMetricReads(metricsDir);
		try {
			const summary = getRunMetricsSummary(tmpDir, 3);
			assert.equal(strictCounter.count(), 3, "limit=3 must read exactly the three newest files, including malformed files");
			assert.equal(summary.length, 1, "two malformed files in the selected window reduce the result count to one");
			assert.equal(summary[0]?.runId, "valid-2", "the only valid file in the newest-three window is returned");
		} finally {
			strictCounter.restore();
		}

		const fullCounter = countMetricReads(metricsDir);
		try {
			const summary = getRunMetricsSummary(tmpDir, 5);
			assert.equal(fullCounter.count(), 5, "limit=5 reads all five selected files, including malformed files");
			assert.equal(summary.length, 3, "all three valid metrics are returned when all five files are selected");
		} finally {
			fullCounter.restore();
		}
	} finally {
		removeTrackedTempDir(tmpDir);
	}
});

test("getRunMetricsSummary with limit > file count reads every file (no padding)", () => {
	const tmpDir = createTrackedTempDir("pi-crew-metrics-scan-pad-");
	fs.mkdirSync(path.join(tmpDir, ".crew"), { recursive: true });
	try {
		for (let i = 0; i < 3; i++) {
			saveRunMetrics(tmpDir, makeMetric(`run-${i}`, new Date(Date.UTC(2026, 6, 20, 0, 0, i)).toISOString()));
		}

		const metricsDir = path.join(tmpDir, ".crew", "state", "metrics");
		const counter = countMetricReads(metricsDir);
		try {
			const summary = getRunMetricsSummary(tmpDir, 100);
			assert.equal(summary.length, 3, "limit=100 against 3 files must return all 3");
			assert.equal(counter.count(), 3, "must read every file when count < limit");
		} finally {
			counter.restore();
		}
	} finally {
		removeTrackedTempDir(tmpDir);
	}
});

test("getRunMetricsSummary returns newest first by mtime (not by filename)", () => {
	const tmpDir = createTrackedTempDir("pi-crew-metrics-scan-order-");
	fs.mkdirSync(path.join(tmpDir, ".crew"), { recursive: true });
	try {
		// 3 metrics with carefully reversed mtimes: filename order
		// (run-a < run-b < run-c) but mtime order (run-c oldest, run-a
		// newest). The function must sort by mtime, returning run-a first.
		const metricsDir = path.join(tmpDir, ".crew", "state", "metrics");
		fs.mkdirSync(metricsDir, { recursive: true });
		saveRunMetrics(tmpDir, makeMetric("run-a", "2026-07-20T00:00:00.000Z"));
		saveRunMetrics(tmpDir, makeMetric("run-b", "2026-07-20T00:00:01.000Z"));
		saveRunMetrics(tmpDir, makeMetric("run-c", "2026-07-20T00:00:02.000Z"));
		// Force mtimes: run-a newest, run-c oldest.
		const base = Date.UTC(2026, 6, 20, 0, 0, 0);
		fs.utimesSync(path.join(metricsDir, "run-a.json"), new Date(base + 3000), new Date(base + 3000));
		fs.utimesSync(path.join(metricsDir, "run-b.json"), new Date(base + 2000), new Date(base + 2000));
		fs.utimesSync(path.join(metricsDir, "run-c.json"), new Date(base + 1000), new Date(base + 1000));

		const summary = getRunMetricsSummary(tmpDir, 5);
		assert.equal(summary.length, 3);
		assert.equal(summary[0].runId, "run-a", "newest mtime must be first");
		assert.equal(summary[1].runId, "run-b");
		assert.equal(summary[2].runId, "run-c", "oldest mtime must be last");
	} finally {
		removeTrackedTempDir(tmpDir);
	}
});
