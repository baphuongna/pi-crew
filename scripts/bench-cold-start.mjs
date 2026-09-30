#!/usr/bin/env node
/**
 * Cold-start benchmark: bundle vs strip-types.
 *
 * Compares two entry paths from a fresh node process:
 *   - STRIP-TYPES: node --experimental-strip-types loads src/extension/register.ts
 *                   (or src/extension/index.ts via the package entry)
 *   - BUNDLE:      node loads dist/index.mjs (esbuild-bundled 1.6MB single file;
 *                  numbers re-measured 2026-09-30)
 *
 * For each path we spawn N child node processes and measure:
 *   - totalMs: time from process spawn to its exit
 *   - importMs: time the child reports for `await import(...)`
 *   - registerMs: time the child reports for registerPiTeams(mockPi)
 *
 * We report:
 *   - per-path median, p95, max for each metric
 *   - bundle vs strip-types speedup (negative = bundle faster)
 *
 * Usage:
 *   node scripts/bench-cold-start.mjs                  # default 10 iters
 *   node scripts/bench-cold-start.mjs --iters 20
 *
 * Output goes to stdout as JSON plus a human-readable summary.
 */
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
let iters = 10;
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--iters" && args[i + 1]) {
		iters = Number(args[i + 1]);
		i++;
	}
}

// Driver template. We capture wall-clock per sample using performance.now()
// and emit JSON lines (one per sample). The outer harness parses them.
const driverTemplate = (entrySpec, registerImport) => `
import { performance } from "node:perf_hooks";

const tSpawn = performance.now();

function createEvents() {
	const handlers = new Map();
	return {
		on(event, handler) {
			const set = handlers.get(event) ?? new Set();
			set.add(handler);
			handlers.set(event, set);
			return () => set.delete(handler);
		},
		emit(event, payload) {
			for (const h of handlers.get(event) ?? []) h(payload);
		},
	};
}

const mockPi = {
	cwd: process.cwd(),
	events: createEvents(),
	hasUI: false,
	getFlag: () => undefined,
	getAllFlags: () => ({}),
	settings: {},
	storage: undefined,
	on() {},
	registerTool() {},
	registerCommand() {},
	appendEntry: async () => undefined,
	sendMessage: async () => undefined,
	sendUserMessage: async () => undefined,
};

const tImport0 = performance.now();
const entry = await import(${JSON.stringify(entrySpec)});
const tImportMs = performance.now() - tImport0;

const register = ${registerImport};

const tReg0 = performance.now();
register(mockPi);
const tRegMs = performance.now() - tReg0;

const tTotal = performance.now();
process.stdout.write(JSON.stringify({
	total: tTotal - tSpawn,
	import: tImportMs,
	register: tRegMs,
	defaultKind: typeof entry.default,
	hasRegister: typeof ${registerImport === "entry.registerPiTeams" ? "entry.registerPiTeams" : "register"},
}) + "\\n");
`;

async function runPath(label, entrySpec, registerImport, itersCount) {
	const driverPath = path.join(root, `.bench-${label}-${process.pid}.mjs`);
	const driverSrc = driverTemplate(entrySpec, registerImport);
	fs.writeFileSync(driverPath, driverSrc, "utf-8");

	const cmd = label === "strip-types"
		? ["--experimental-strip-types", "--no-warnings", driverPath]
		: ["--no-warnings", driverPath];

	const samples = [];
	for (let i = 0; i < itersCount; i++) {
		const t0 = performance.now();
		const r = spawnSync(process.execPath, cmd, { encoding: "utf-8", cwd: root });
		const wall = performance.now() - t0;
		if (r.status !== 0) {
			console.error(`[bench:${label}] iter ${i} failed:`, r.stderr?.slice(0, 200));
			continue;
		}
		const lastLine = r.stdout.trim().split("\n").pop();
		try {
			const sample = JSON.parse(lastLine);
			samples.push({ ...sample, wall });
		} catch {
			console.error(`[bench:${label}] iter ${i} parse error:`, lastLine);
		}
	}

	fs.unlinkSync(driverPath);
	return samples;
}

function stats(arr) {
	const sorted = [...arr].sort((a, b) => a - b);
	const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
	return {
		n: sorted.length,
		min: sorted[0],
		p50: p(0.5),
		p95: p(0.95),
		max: sorted[sorted.length - 1],
		mean: sorted.reduce((s, x) => s + x, 0) / sorted.length,
	};
}

function pctDelta(newer, older) {
	// positive = newer is slower than older
	return (((newer - older) / older) * 100).toFixed(1);
}

console.log(`[bench] Running ${iters} iters per path...`);
console.log("");

const stripSpec = pathToFileURL(path.join(root, "src/extension/register.ts")).href;
const stripRegister = "(await import(" + JSON.stringify(stripSpec) + ")).registerPiTeams";
const stripSamples = await runPath("strip-types", stripSpec, stripRegister, iters);

const bundleSpec = pathToFileURL(path.join(root, "dist/index.mjs")).href;
const bundleRegister = "(await import(" + JSON.stringify(bundleSpec) + ")).registerPiTeams";
const bundleSamples = await runPath("bundle", bundleSpec, bundleRegister, iters);

if (stripSamples.length === 0 || bundleSamples.length === 0) {
	console.error("[bench] insufficient samples; aborting");
	process.exit(1);
}

const summary = {
	timestamp: new Date().toISOString(),
	iters,
	strip: {
		total: stats(stripSamples.map((s) => s.total)),
		import: stats(stripSamples.map((s) => s.import)),
		register: stats(stripSamples.map((s) => s.register)),
		wall: stats(stripSamples.map((s) => s.wall)),
	},
	bundle: {
		total: stats(bundleSamples.map((s) => s.total)),
		import: stats(bundleSamples.map((s) => s.import)),
		register: stats(bundleSamples.map((s) => s.register)),
		wall: stats(bundleSamples.map((s) => s.wall)),
	},
};

// Speedup = strip - bundle (positive = bundle faster)
summary.speedup = {
	total: summary.strip.total.p50 - summary.bundle.total.p50,
	totalPct: pctDelta(summary.bundle.total.p50, summary.strip.total.p50),
	import: summary.strip.import.p50 - summary.bundle.import.p50,
	importPct: pctDelta(summary.bundle.import.p50, summary.strip.import.p50),
	register: summary.strip.register.p50 - summary.bundle.register.p50,
	registerPct: pctDelta(summary.bundle.register.p50, summary.strip.register.p50),
	wall: summary.strip.wall.p50 - summary.bundle.wall.p50,
	wallPct: pctDelta(summary.bundle.wall.p50, summary.strip.wall.p50),
};

// Print human-readable summary
console.log("=== Cold-start benchmark: strip-types vs bundle ===\n");

const printPath = (label, data) => {
	console.log(`  ${label}:`);
	console.log(`    total (child process wall-clock):  p50=${data.total.p50.toFixed(1)}ms  p95=${data.total.p95.toFixed(1)}ms  min=${data.total.min.toFixed(1)}ms`);
	console.log(`    import (await import(...)):         p50=${data.import.p50.toFixed(1)}ms  p95=${data.import.p95.toFixed(1)}ms`);
	console.log(`    register (registerPiTeams(mockPi)): p50=${data.register.p50.toFixed(1)}ms  p95=${data.register.p95.toFixed(1)}ms`);
	console.log("");
};

printPath("STRIP-TYPES (--experimental-strip-types + 520 .ts files)", summary.strip);
printPath("BUNDLE      (dist/index.mjs, 1.6MB single file)", summary.bundle);

console.log(`  Speedup (bundle vs strip-types, p50):`);
console.log(`    total:        ${summary.speedup.total >= 0 ? "FASTER" : "SLOWER"} by ${Math.abs(summary.speedup.total).toFixed(1)}ms (${summary.speedup.totalPct}%)`);
console.log(`    import:       ${summary.speedup.import >= 0 ? "FASTER" : "SLOWER"} by ${Math.abs(summary.speedup.import).toFixed(1)}ms (${summary.speedup.importPct}%)`);
console.log(`    register:     ${summary.speedup.register >= 0 ? "FASTER" : "SLOWER"} by ${Math.abs(summary.speedup.register).toFixed(1)}ms (${summary.speedup.registerPct}%)`);
console.log(`    outer wall:   ${summary.speedup.wall >= 0 ? "FASTER" : "SLOWER"} by ${Math.abs(summary.speedup.wall).toFixed(1)}ms (${summary.speedup.wallPct}%)`);

const benchDir = path.join(root, ".bench");
fs.mkdirSync(benchDir, { recursive: true });
const outFile = path.join(benchDir, `cold-start-${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + "\n", "utf-8");
console.log(`\n[bench] Raw results: ${outFile}`);