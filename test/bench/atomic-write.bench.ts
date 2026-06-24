/**
 * Bench: atomicWriteJson throughput (HB-003 perf baseline).
 *
 * Measures the cost of `atomicWriteJson` (the durable state-write path used by
 * manifest/task/event persistence) under serial load. The temp-file → fsync →
 * rename dance is on the hot path of every run transition, so a regression
 * here directly slows down every multi-task run.
 *
 * Two scenarios:
 *   - cold: first write to a fresh path (temp file creation + fsync)
 *   - warm: overwrite an existing file (fsync only, no create)
 */
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson } from "../../src/state/atomic-write.ts";

const ITERS = Number(process.env.BENCH_ITERS ?? 200);
const PAYLOAD = { runId: "bench", status: "running", tasks: Array.from({ length: 20 }, (_v, i) => ({ id: `t-${i}` })), updatedAt: "2026-06-24T00:00:00.000Z" };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-bench-aw-"));
try {
	const targetCold = path.join(tmpRoot, "cold.json");
	const targetWarm = path.join(tmpRoot, "warm.json");
	// Pre-create the warm target so the first measured write is an overwrite.
	atomicWriteJson(targetWarm, PAYLOAD);

	const cold: number[] = [];
	const warm: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		const t0 = performance.now();
		atomicWriteJson(targetCold, { ...PAYLOAD, i });
		cold.push(performance.now() - t0);

		const t1 = performance.now();
		atomicWriteJson(targetWarm, { ...PAYLOAD, i });
		warm.push(performance.now() - t1);
	}
	cold.sort((a, b) => a - b);
	warm.sort((a, b) => a - b);

	const out = {
		name: "atomic-write-json",
		iters: ITERS,
		payloadBytes: JSON.stringify(PAYLOAD).length,
		cold: stats(cold),
		warm: stats(warm),
	};
	process.stdout.write(JSON.stringify(out) + "\n");
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

function stats(samples: number[]) {
	return {
		min: round(samples[0]),
		p50: round(percentile(samples, 0.5)),
		p95: round(percentile(samples, 0.95)),
		p99: round(percentile(samples, 0.99)),
		max: round(samples[samples.length - 1]),
	};
}
function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
	return sorted[idx];
}
function round(n: number): number { return Math.round(n * 100) / 100; }
