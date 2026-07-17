/**
 * Bench: registerPiTeams cold load.
 *
 * Measures the cost of `registerPiTeams(piMock)` from a fresh module graph.
 * Uses a child node-process per iteration so the module cache stays cold.
 * Reports p50/p95/p99 in ms.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

const ITERS = Number(process.env.BENCH_ITERS ?? 20);
const registerImportSpec = pathToFileURL(path.join(root, "src/extension/register.ts")).href;
const driverSrc = `
import { performance } from "node:perf_hooks";
const t0 = performance.now();
const { registerPiTeams } = await import(${JSON.stringify(registerImportSpec)});
const tImport = performance.now() - t0;

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
function createPi(events) {
	return {
		events,
		on(_e, _h) {},
		registerCommand() {},
		registerTool() {},
		appendEntry() {},
		getSessionName() { return undefined; },
		setSessionName() {},
	};
}

const t1 = performance.now();
const events = createEvents();
const pi = createPi(events);
registerPiTeams(pi);
const tRegister = performance.now() - t1;
process.stdout.write(JSON.stringify({ tImport, tRegister }) + "\\n");
`;
const driverPath = path.join(os.tmpdir(), `pi-crew-bench-register-${process.pid}.mjs`);
fs.writeFileSync(driverPath, driverSrc, "utf-8");

const samplesImport: number[] = [];
const samplesRegister: number[] = [];
for (let i = 0; i < ITERS; i++) {
	const result = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", driverPath], {
		encoding: "utf-8",
		cwd: root,
		timeout: 30_000,
	});
	if (result.status !== 0) {
		fs.unlinkSync(driverPath);
		throw new Error(`driver failed: ${result.stderr}`);
	}
	const line = result.stdout.trim().split("\n").pop()!;
	const parsed = JSON.parse(line) as { tImport: number; tRegister: number };
	samplesImport.push(parsed.tImport);
	samplesRegister.push(parsed.tRegister);
}
fs.unlinkSync(driverPath);

samplesImport.sort((a, b) => a - b);
samplesRegister.sort((a, b) => a - b);

const summary = (samples: number[]) => ({
	min: round(samples[0]),
	p50: round(percentile(samples, 0.5)),
	p95: round(percentile(samples, 0.95)),
	p99: round(percentile(samples, 0.99)),
	max: round(samples[samples.length - 1]),
});

const out = {
	name: "register-startup",
	unit: "ms",
	iters: ITERS,
	import: summary(samplesImport),
	register: summary(samplesRegister),
};
process.stdout.write(JSON.stringify(out) + "\n");

function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
	return sorted[idx];
}
function round(n: number): number {
	return Math.round(n * 100) / 100;
}
