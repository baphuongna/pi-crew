#!/usr/bin/env node
/**
 * Compare test/bench/results.json against test/bench/baseline.json.
 *
 * Fails if any p95 metric regresses by more than the allowed threshold.
 *
 * Usage:
 *   npm run bench:check                      # default 15% threshold
 *   THRESHOLD_PCT=10 npm run bench:check     # tighter
 *   BASELINE=test/bench/baseline.json npm run bench:check
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const benchDir = path.join(root, "test", "bench");
const resultsPath = path.join(benchDir, "results.json");
const baselinePath = process.env.BASELINE ? path.resolve(process.env.BASELINE) : path.join(benchDir, "baseline.json");
const threshold = Number(process.env.THRESHOLD_PCT ?? 15) / 100;

if (!fs.existsSync(resultsPath)) {
	console.error(`[bench:check] missing ${resultsPath}; run \`npm run bench\` first.`);
	process.exit(2);
}
if (!fs.existsSync(baselinePath)) {
	console.error(`[bench:check] missing baseline ${baselinePath}.`);
	console.error("              Capture baseline with: npm run bench && cp test/bench/results.json test/bench/baseline.json");
	process.exit(2);
}

const results = JSON.parse(fs.readFileSync(resultsPath, "utf-8"));
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));

/**
 * Walk each bench's nested numeric metrics and pair with baseline.
 * Reports any p95 metric where current > baseline * (1 + threshold).
 */
const regressions = [];
const improvements = [];
for (const [benchName, current] of Object.entries(results.results)) {
	const base = baseline.results?.[benchName];
	if (!base) {
		console.log(`[bench:check] no baseline for ${benchName} — skipping`);
		continue;
	}
	for (const metric of metricKeys(current)) {
		const cur = readPath(current, metric);
		const ref = readPath(base, metric);
		if (typeof cur !== "number" || typeof ref !== "number" || ref === 0) continue;
		// Sub-ms metrics are dominated by GC / OS jitter — applying a strict
		// percentage gate causes false positives. Use absolute delta cap instead.
		if (ref < 1.0) {
			const absDelta = cur - ref;
			if (absDelta > 0.5) regressions.push({ bench: benchName, metric: metric.join("."), baseline: ref, current: cur, deltaPct: round(((cur - ref) / ref) * 100), reason: "abs > 0.5ms" });
			else if (absDelta < -0.05) improvements.push({ bench: benchName, metric: metric.join("."), baseline: ref, current: cur, deltaPct: round(((cur - ref) / ref) * 100) });
			continue;
		}
		const delta = (cur - ref) / ref;
		if (delta > threshold) regressions.push({ bench: benchName, metric: metric.join("."), baseline: ref, current: cur, deltaPct: round(delta * 100) });
		else if (delta < -0.05) improvements.push({ bench: benchName, metric: metric.join("."), baseline: ref, current: cur, deltaPct: round(delta * 100) });
	}
}

if (improvements.length) {
	console.log("[bench:check] improvements:");
	for (const item of improvements) console.log(`  ${item.bench}.${item.metric}: ${item.baseline} → ${item.current} (${item.deltaPct}%)`);
}
if (regressions.length) {
	console.error(`[bench:check] regressions (>${(threshold * 100).toFixed(0)}%):`);
	for (const item of regressions) console.error(`  ${item.bench}.${item.metric}: ${item.baseline} → ${item.current} (+${item.deltaPct}%)`);
	process.exit(1);
}
console.log(`[bench:check] all benches within ${(threshold * 100).toFixed(0)}% of baseline.`);

function metricKeys(obj, prefix = []) {
	const skip = new Set(["name", "unit", "iters", "tasks", "events", "eventsPerIter"]);
	const keys = [];
	for (const [k, v] of Object.entries(obj)) {
		if (skip.has(k)) continue;
		if (k === "p50" || k === "p95" || k === "p99" || k === "min" || k === "max") {
			// We only gate on p95; min/max printed but not enforced.
			if (k === "p95") keys.push([...prefix, k]);
			continue;
		}
		if (v && typeof v === "object" && !Array.isArray(v)) keys.push(...metricKeys(v, [...prefix, k]));
	}
	return keys;
}

function readPath(obj, parts) {
	let cur = obj;
	for (const p of parts) cur = cur?.[p];
	return cur;
}

function round(n) { return Math.round(n * 100) / 100; }
