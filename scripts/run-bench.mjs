#!/usr/bin/env node
/**
 * Run all benches, collect JSON output.
 *
 * Two suites:
 *   1. Legacy suite under test/bench/ — writes test/bench/results.json
 *      (consumed by `npm run bench:check` vs baseline.json).
 *   2. Performance suite under bench/b*.bench.ts — writes
 *      bench/results/<timestamp>.json with metadata (node, platform,
 *      date, PI_MODEL when set). Legacy `bench/child-pi-parse.bench.ts`
 *      is NOT JSON-emitting and is excluded from the glob.
 *
 * Each bench prints a single JSON line on stdout (NDJSON). Earlier lines may
 * be ignored. Failures abort the run.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const benchDir = path.join(root, "test", "bench");
const perfBenchDir = path.join(root, "bench");

/** Run one bench file, parse the last JSON line, return parsed object or null. */
function runBench(benchPath, benchName) {
	console.log(`[bench] running ${benchName}...`);
	const t0 = Date.now();
	const result = spawnSync(process.execPath, [
		"--experimental-strip-types",
		"--no-warnings",
		benchPath,
	], { encoding: "utf-8", cwd: root, timeout: 600_000 });
	if (result.status !== 0) {
		console.error(result.stderr || result.stdout);
		process.exit(result.status ?? 1);
	}
	const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
	const lines = result.stdout.trim().split("\n").filter(Boolean);
	let parsed;
	for (const line of lines.reverse()) {
		try { parsed = JSON.parse(line); break; } catch { /* skip non-JSON */ }
	}
	if (!parsed?.name) {
		console.error(`[bench] could not parse JSON output from ${benchName}\n${result.stdout}`);
		process.exit(2);
	}
	console.log(`[bench]   ${parsed.name} done in ${elapsed}s`);
	return parsed;
}

// --- Legacy suite (test/bench) ---------------------------------------------
const benches = fs.readdirSync(benchDir).filter((f) => f.endsWith(".bench.ts"));
const results = {};
for (const bench of benches) {
	const parsed = runBench(path.join(benchDir, bench), bench);
	results[parsed.name] = parsed;
}

const outPath = path.join(benchDir, "results.json");
const payload = { capturedAt: new Date().toISOString(), node: process.version, platform: process.platform, results };
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
console.log(`[bench] wrote ${outPath}`);

// --- Performance suite (bench/b*.bench.ts) ---------------------------------
const perfBenches = fs
	.readdirSync(perfBenchDir)
	.filter((f) => f.startsWith("b") && f.endsWith(".bench.ts"))
	.sort();

const perfResults = {};
for (const bench of perfBenches) {
	const parsed = runBench(path.join(perfBenchDir, bench), bench);
	perfResults[parsed.name] = parsed;
}

if (perfBenches.length > 0) {
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const resultsDir = path.join(perfBenchDir, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	const perfOutPath = path.join(resultsDir, `${ts}.json`);
	const perfPayload = {
		capturedAt: new Date().toISOString(),
		node: process.version,
		platform: process.platform,
		model: process.env.PI_MODEL ?? null,
		results: perfResults,
	};
	fs.writeFileSync(perfOutPath, JSON.stringify(perfPayload, null, 2) + "\n", "utf-8");
	console.log(`[bench] wrote ${perfOutPath}`);
} else {
	console.log("[bench] no perf benches found under bench/b*.bench.ts — skipped");
}
