/**
 * b3 — state store JSONL write/read benchmark.
 *
 * Measures the JSONL persistence primitives used by pi-crew state stores:
 *   - raw JSONL append (one line per entry) — the pattern behind event-log
 *     and task-state persistence
 *   - atomicWriteJson (temp-file + rename) — used by run-metrics snapshots,
 *     observation-store, run-graph save
 *   - read-back + JSON.parse of the whole file
 *
 * Sizes: 10, 100, 1000 entries. All I/O in a temp dir, cleaned in `finally`.
 *
 * CAVEAT (audit): benchJsonlWrite does ONE bulk writeFileSync of all lines at
 * once — this measures "write whole file", NOT the append-many-per-event
 * pattern that event-log actually uses (open fd, append per line). So the
 * jsonlWriteMs numbers are a lower bound for the real append workload; do not
 * compare them to event-log append rates without noting this.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b3-state-store-jsonl.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { atomicWriteJson } from "../src/state/atomic-write.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-b3-"));
const linePath = path.join(tmpRoot, "entries.jsonl");
const atomicPath = path.join(tmpRoot, "snapshot.json");

function makeEntry(i: number): Record<string, unknown> {
	return {
		seq: i,
		time: new Date().toISOString(),
		type: "task.progress",
		runId: "b3-run",
		taskId: `task-${i}`,
		message: "benchmark entry ".repeat(5),
		usage: { input: 100 + i, output: 50 + i, cost: 0.001, turns: 1 },
	};
}

function benchJsonlWrite(count: number): { writeMs: number; bytes: number; entriesPerSec: number } {
	const lines: string[] = [];
	for (let i = 0; i < count; i++) lines.push(JSON.stringify(makeEntry(i)));
	const start = performance.now();
	fs.writeFileSync(linePath, lines.join("\n") + "\n", "utf-8");
	const writeMs = performance.now() - start;
	return { writeMs, bytes: fs.statSync(linePath).size, entriesPerSec: round(count / (writeMs / 1000)) };
}

function benchJsonlRead(count: number): { readMs: number; entriesPerSec: number } {
	const start = performance.now();
	const content = fs.readFileSync(linePath, "utf-8");
	const entries = content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	const readMs = performance.now() - start;
	return { readMs, entriesPerSec: round(count / (readMs / 1000)) };
}

function benchAtomicWrite(count: number): { writeMs: number; bytes: number; entriesPerSec: number } {
	const value = { entries: Array.from({ length: count }, (_, i) => makeEntry(i)) };
	const start = performance.now();
	atomicWriteJson(atomicPath, value);
	const writeMs = performance.now() - start;
	return { writeMs, bytes: fs.statSync(atomicPath).size, entriesPerSec: round(count / (writeMs / 1000)) };
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function main(): void {
	const rssBefore = process.memoryUsage().rss;
	const cases: Record<string, unknown> = {};
	for (const count of [10, 100, 1000]) {
		const jsonl = benchJsonlWrite(count);
		const read = benchJsonlRead(count);
		const atomic = benchAtomicWrite(count);
		cases[`n${count}`] = {
			jsonlWriteMs: round(jsonl.writeMs),
			jsonlReadMs: round(read.readMs),
			atomicWriteMs: round(atomic.writeMs),
			bytes: jsonl.bytes,
			atomicBytes: atomic.bytes,
			entriesPerSecWrite: jsonl.entriesPerSec,
			entriesPerSecRead: read.entriesPerSec,
		};
		console.log(
			`b3 n=${count}: jsonl write=${round(jsonl.writeMs)}ms read=${round(read.readMs)}ms atomic=${round(atomic.writeMs)}ms (${jsonl.bytes}B)`,
		);
	}

	const result = {
		name: "b3.state-store-jsonl",
		unit: "ms",
		sizes: [10, 100, 1000],
		cases,
		rssDeltaBytes: process.memoryUsage().rss - rssBefore,
	};
	console.log(JSON.stringify(result));
}

try {
	main();
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
