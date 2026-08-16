/**
 * b7 — startup (module init) benchmark.
 *
 * Measures the cost of loading pi-crew's pre-built bundle `dist/index.mjs`
 * (the DEFAULT entry point since v0.9.17 — see .crew/knowledge.md):
 *   - wall time to `await import('../dist/index.mjs')`
 *   - RSS delta + heapUsed after load
 *
 * 3–5 iterations; first iteration is cold (OS page cache / module eval),
 * subsequent iterations benefit from warm module cache.
 *
 * Also measures a child-process cold load (`node -e "import('dist/index.mjs')"`)
 * which is the realistic "start a detached pi-crew worker" cost.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b7-startup.bench.ts
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

const bundlePath = path.resolve(import.meta.dirname, "..", "dist", "index.mjs");
const ITERATIONS = 3;

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function measureChild(): { loadMs: number; rssDelta: number } {
	const rssBefore = process.memoryUsage().rss;
	const t0 = performance.now();
	const res = spawnSync(
		process.execPath,
		["--no-warnings", "-e", `import('${bundlePath}').then(()=>process.exit(0)).catch(()=>process.exit(1))`],
		{
			encoding: "utf-8",
			timeout: 60_000,
			stdio: "ignore",
		},
	);
	const loadMs = performance.now() - t0;
	if (res.status !== 0) {
		throw new Error(`child bundle import failed: exit ${res.status ?? res.signal}`);
	}
	return { loadMs, rssDelta: process.memoryUsage().rss - rssBefore };
}

async function main(): Promise<void> {
	if (!fs.existsSync(bundlePath)) {
		console.log(
			JSON.stringify({ name: "b7.startup", unit: "ms", skipped: true, limitation: `dist/index.mjs not found at ${bundlePath}` }),
		);
		return;
	}
	const bundleBytes = fs.statSync(bundlePath).size;

	const iterations: Array<{ loadMs: number; rssDelta: number; heapDelta: number }> = [];
	for (let i = 0; i < ITERATIONS; i++) {
		const rssBefore = process.memoryUsage().rss;
		const heapBefore = process.memoryUsage().heapUsed;
		const t0 = performance.now();
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		await import(bundlePath);
		const loadMs = performance.now() - t0;
		const mem = process.memoryUsage();
		const entry = { loadMs, rssDelta: mem.rss - rssBefore, heapDelta: mem.heapUsed - heapBefore };
		iterations.push(entry);
		console.log(`b7 iter ${i + 1}: ${round(loadMs)}ms rssDelta=${entry.rssDelta}B`);
	}

	let child: { loadMs: number; rssDelta: number };
	try {
		child = measureChild();
	} catch (err) {
		child = { loadMs: -1, rssDelta: 0 };
	}

	const loadMsArr = iterations.map((i) => i.loadMs);
	const result = {
		name: "b7.startup",
		unit: "ms",
		iterations: loadMsArr.map(round),
		// CAVEAT (audit): loadMsAvg mixes cold (iter 1 ~1.3s) with warm (iter 2-3
		// ~0ms due to module cache) → the average is NOT physically meaningful.
		// Use loadMsFirst or childProcessLoadMs for a real cold-start figure.
		loadMsAvg: round(loadMsArr.reduce((a, b) => a + b, 0) / loadMsArr.length),
		loadMsMin: round(Math.min(...loadMsArr)),
		loadMsFirst: round(loadMsArr[0] ?? 0),
		rssDeltaAvg: Math.round(iterations.reduce((a, i) => a + i.rssDelta, 0) / iterations.length),
		heapUsedDeltaAvg: Math.round(iterations.reduce((a, i) => a + i.heapDelta, 0) / iterations.length),
		childProcessLoadMs: round(child.loadMs),
		childRssDeltaBytes: child.rssDelta,
		bundleExists: true,
		bundleBytes,
	};
	console.log(
		`b7: direct avg=${round(loadMsArr.reduce((a, b) => a + b, 0) / loadMsArr.length)}ms child=${round(child.loadMs)}ms (${bundleBytes}B bundle)`,
	);
	console.log(JSON.stringify(result));
}

await main();
