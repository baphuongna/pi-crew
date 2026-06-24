/**
 * Bench: appendEvent throughput (HB-003 perf baseline).
 *
 * Measures the cost of `appendEvent` (the durable event-log path). Every
 * task.transition / worker.spawn / task.progress writes one event; long runs
 * append thousands. The append path takes a sync file lock + fsync, so a
 * regression here shows up as run slowdown on event-heavy workloads.
 *
 * Two scenarios:
 *   - serial: append N events back-to-back to one events.jsonl (lock contention)
 *   - small-batch: append N events to N different files (no contention, pure IO)
 */
import { performance } from "node:perf_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent } from "../../src/state/event-log.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

const ITERS = Number(process.env.BENCH_ITERS ?? 200);

function fakeManifest(eventsPath: string): TeamRunManifest {
	const now = new Date().toISOString();
	const cwd = path.dirname(path.dirname(eventsPath));
	return {
		schemaVersion: 1,
		runId: "bench-evt",
		team: "bench",
		workflow: "default",
		goal: "bench",
		status: "running",
		workspaceMode: "single",
		createdAt: now,
		updatedAt: now,
		cwd,
		stateRoot: path.dirname(eventsPath),
		artifactsRoot: path.join(cwd, "art"),
		tasksPath: path.join(cwd, "tasks.json"),
		eventsPath,
		artifacts: [],
	};
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-bench-evt-"));
try {
	fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n", "utf-8");
	fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });

	// Scenario 1: serial appends to ONE file (lock contention + growing file).
	const serialPath = path.join(tmpRoot, "serial", "events.jsonl");
	fs.mkdirSync(path.dirname(serialPath), { recursive: true });
	fs.writeFileSync(serialPath, "");
	const serialManifest = fakeManifest(serialPath);
	const serial: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		const t0 = performance.now();
		appendEvent(serialPath, { type: "task.progress", runId: serialManifest.runId, data: { i } });
		serial.push(performance.now() - t0);
	}
	serial.sort((a, b) => a - b);

	// Scenario 2: one append per file (no contention, cold fsync each time).
	const batch: number[] = [];
	for (let i = 0; i < ITERS; i++) {
		const fp = path.join(tmpRoot, "batch", `evt-${i}.jsonl`);
		fs.mkdirSync(path.dirname(fp), { recursive: true });
		fs.writeFileSync(fp, "");
		const t0 = performance.now();
		appendEvent(fp, { type: "task.progress", runId: "bench-evt", data: { i } });
		batch.push(performance.now() - t0);
	}
	batch.sort((a, b) => a - b);

	const out = {
		name: "event-append",
		iters: ITERS,
		serial: stats(serial),
		batch: stats(batch),
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
