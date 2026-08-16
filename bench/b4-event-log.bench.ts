/**
 * b4 — event-log append + retention benchmark.
 *
 * Measures the three append paths of src/state/event-log/event-log.ts:
 *   - appendEvent       (sync: mkdirlock + sleepSync retry + fsync per event — BLOCKS event loop)
 *   - appendEventAsync  (async queue + alock — non-blocking, awaited sequentially here)
 *   - appendEventBuffered (batch/coalesced — one flush per buffer window)
 *
 * Sizes: 100, 1000, 10000 events. Also measures rotation/compaction cost
 * (`compactEventLog`) on a grown file (retention path).
 *
 * A temp eventsPath is used per case; temp dir cleaned in `finally`.
 * `seqCounters.clear()` is called between modes to clear global counters.
 *
 * NOTE (learned): the sync path uses sleepSync which blocks the event loop —
 * this is a known finding reported in docs/perf-report.md, not a bug here.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b4-event-log.bench.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import type { AppendTeamEvent } from "../src/state/event-log/event-log.ts";
import { appendEvent, appendEventAsync, appendEventBuffered } from "../src/state/event-log/event-log.ts";
import { compactEventLog } from "../src/state/event-log/event-log-rotation.ts";
import { seqCounters } from "../src/state/event-log/sequence-cache.ts";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-b4-"));

function makeEvent(i: number): AppendTeamEvent {
	return {
		type: "task.progress",
		runId: "b4-run",
		taskId: `task-${i % 10}`,
		message: `benchmark event ${i}`,
	};
}

function benchSyncAppend(count: number): { wallMs: number; eventsPerSec: number; maxBlockMs: number; skipped?: string } {
	const eventsPath = path.join(tmpRoot, `sync-${count}`, "events.jsonl");
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	seqCounters.clear();

	const blockSamples: number[] = [];
	let last = performance.now();
	const sampler = setInterval(() => {
		const now = performance.now();
		blockSamples.push(now - last);
		last = now;
	}, 1);

	const start = performance.now();
	for (let i = 0; i < count; i++) {
		appendEvent(eventsPath, makeEvent(i));
	}
	const wallMs = performance.now() - start;
	clearInterval(sampler);
	const maxBlockMs = blockSamples.length > 0 ? Math.max(...blockSamples) : 0;
	return { wallMs, eventsPerSec: round(count / (wallMs / 1000)), maxBlockMs: round(maxBlockMs) };
}

async function benchAsyncAppend(count: number): Promise<{ wallMs: number; eventsPerSec: number; maxBlockMs: number }> {
	const eventsPath = path.join(tmpRoot, `async-${count}`, "events.jsonl");
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	seqCounters.clear();

	const blockSamples: number[] = [];
	let last = performance.now();
	const sampler = setInterval(() => {
		const now = performance.now();
		blockSamples.push(now - last);
		last = now;
	}, 1);

	const start = performance.now();
	for (let i = 0; i < count; i++) {
		await appendEventAsync(eventsPath, makeEvent(i));
	}
	const wallMs = performance.now() - start;
	clearInterval(sampler);
	const maxBlockMs = blockSamples.length > 0 ? Math.max(...blockSamples) : 0;
	return { wallMs, eventsPerSec: round(count / (wallMs / 1000)), maxBlockMs: round(maxBlockMs) };
}

async function benchBufferedAppend(count: number): Promise<{ wallMs: number; eventsPerSec: number; skipped?: string }> {
	if (count > 1000) {
		return { wallMs: 0, eventsPerSec: 0, skipped: "buffered append has a 1000-entry buffer cap — 10000 would overflow" };
	}
	const eventsPath = path.join(tmpRoot, `buffered-${count}`, "events.jsonl");
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	seqCounters.clear();

	const start = performance.now();
	const pending: Promise<unknown>[] = [];
	for (let i = 0; i < count; i++) {
		pending.push(appendEventBuffered(eventsPath, makeEvent(i), 200));
	}
	await Promise.all(pending);
	// Give the buffer timer a chance to flush before the next case reuses modes.
	await new Promise((r) => setTimeout(r, 250));
	const wallMs = performance.now() - start;
	return { wallMs, eventsPerSec: round(count / (wallMs / 1000)) };
}

async function benchCompaction(count: number): Promise<{ wallMs: number; originalSize: number; compactedSize: number }> {
	const eventsPath = path.join(tmpRoot, `compact-${count}`, "events.jsonl");
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	// Build the file with the async path (sync path is ~14ms/event — too slow for 10k).
	for (let i = 0; i < count; i++) {
		await appendEventAsync(eventsPath, makeEvent(i));
	}
	const originalSize = fs.statSync(eventsPath).size;
	const start = performance.now();
	const result = compactEventLog(eventsPath);
	const wallMs = performance.now() - start;
	const compactedSize = result ? result.compactedSize : fs.statSync(eventsPath).size;
	return { wallMs, originalSize, compactedSize };
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

async function main(): Promise<void> {
	const rssBefore = process.memoryUsage().rss;
	const cases: Record<string, unknown> = {};
	for (const count of [100, 1000, 10000]) {
		const sync =
			count <= 1000
				? benchSyncAppend(count)
				: { wallMs: 0, eventsPerSec: 0, maxBlockMs: 0, skipped: "sync append is ~14ms/event (lock+fsync) — 10k would take ~145s" };
		const asyncRes = await benchAsyncAppend(count);
		const buffered = await benchBufferedAppend(count);
		const compact = await benchCompaction(count);
		cases[`n${count}`] = {
			syncAppendMs: round(sync.wallMs),
			syncEventsPerSec: sync.eventsPerSec,
			syncMaxBlockMs: sync.maxBlockMs,
			syncSkipped: sync.skipped ?? null,
			asyncAppendMs: round(asyncRes.wallMs),
			asyncEventsPerSec: asyncRes.eventsPerSec,
			asyncMaxBlockMs: asyncRes.maxBlockMs,
			bufferedAppendMs: round(buffered.wallMs),
			bufferedEventsPerSec: buffered.eventsPerSec,
			bufferedSkipped: buffered.skipped ?? null,
			compactionMs: round(compact.wallMs),
			compactionOriginalBytes: compact.originalSize,
			compactionCompactedBytes: compact.compactedSize,
		};
		console.log(
			`b4 n=${count}: sync=${round(sync.wallMs)}ms (${sync.eventsPerSec}/s, block ${sync.maxBlockMs}ms) async=${round(asyncRes.wallMs)}ms buffered=${round(buffered.wallMs)}ms compact=${round(compact.wallMs)}ms`,
		);
	}

	const result = {
		name: "b4.event-log",
		unit: "ms",
		sizes: [100, 1000, 10000],
		cases,
		rssDeltaBytes: process.memoryUsage().rss - rssBefore,
	};
	console.log(JSON.stringify(result));
}

try {
	await main();
} finally {
	seqCounters.clear();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}
