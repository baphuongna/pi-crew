/**
 * B7 regression test: concurrent append paths must produce unique sequence numbers.
 *
 * The three append paths — sync `appendEvent` (withEventLogLockSync),
 * buffered `appendEventBuffered` (asyncLocks), and direct `appendEventAsync`
 * (asyncQueues) — use DIFFERENT locks. The old `nextSequence()` read-sidecar /
 * compute / persist-sidecar logic raced across these paths, producing duplicate
 * seq numbers (no data loss — only the counter collided).
 *
 * This test fires events through all three paths concurrently and asserts
 * that every resulting seq is unique.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { appendEvent, appendEventAsync, appendEventBuffered, flushEventLogBuffer, resetEventLogMode } from "../../src/state/event-log.ts";

function makeEvent(taskId: string) {
	return { type: "task.progress" as const, runId: "b7-test", taskId, data: {} };
}

describe("B7: cross-path seq uniqueness", () => {
	let tmpDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "b7-seq-"));
		eventsPath = path.join(tmpDir, "events.jsonl");
	});

	afterEach(() => {
		resetEventLogMode();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("seq numbers are unique across concurrent sync/async/buffered appends", async () => {
		const N = 20;
		const tasks = Array.from({ length: N }, (_, i) => `t${i}`);

		// Fire all three paths concurrently, interleaved.
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < N; i++) {
			const task = tasks[i];
			const ev = makeEvent(task);
			if (i % 3 === 0) {
				// sync path
				appendEvent(eventsPath, ev);
			} else if (i % 3 === 1) {
				// direct async path
				promises.push(appendEventAsync(eventsPath, ev));
			} else {
				// buffered path
				promises.push(appendEventBuffered(eventsPath, ev));
			}
		}
		await Promise.all(promises);
		// FIX (CI flake): Explicitly flush the buffered events so their 20ms
		// timer doesn't keep the test pending past --test-force-exit's window.
		await flushEventLogBuffer();

		// Parse all events and collect seqs.
		const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
		assert.equal(lines.length, N, `expected ${N} events, got ${lines.length}`);

		const seqs: number[] = [];
		for (const line of lines) {
			const ev = JSON.parse(line);
			assert.ok(ev.metadata?.seq > 0, `seq must be positive: ${ev.metadata?.seq}`);
			seqs.push(ev.metadata.seq);
		}

		// Assert all seqs are unique.
		const unique = new Set(seqs);
		assert.equal(unique.size, seqs.length, `duplicate seqs found: ${seqs.join(", ")}`);

		// Assert seqs form a contiguous range from 1..N (no gaps).
		const sorted = [...seqs].sort((a, b) => a - b);
		for (let i = 0; i < N; i++) {
			assert.equal(sorted[i], i + 1, `expected seq ${i + 1}, got ${sorted[i]}`);
		}
	});

	it("no duplicate seqs under high concurrency", async () => {
		const N = 50;
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < N; i++) {
			const ev = makeEvent(`h${i}`);
			if (i % 3 === 0) {
				appendEvent(eventsPath, ev);
			} else if (i % 3 === 1) {
				promises.push(appendEventAsync(eventsPath, ev));
			} else {
				promises.push(appendEventBuffered(eventsPath, ev));
			}
		}
		await Promise.all(promises);
		// FIX (CI flake): Explicitly flush the buffered events so their 20ms
		// timer doesn't keep the test pending past --test-force-exit's window.
		await flushEventLogBuffer();

		const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
		assert.equal(lines.length, N, `expected ${N} events, got ${lines.length}`);

		const seqs = lines.map((l) => JSON.parse(l).metadata.seq);
		const unique = new Set(seqs);
		assert.equal(unique.size, seqs.length, `duplicate seqs found: ${seqs.join(", ")}`);
	});

	it("explicit pre-assigned seqs don't collide with auto-assigned ones", async () => {
		// Pre-assigned seqs at high values; auto-assigned should not overlap.
		const ev1 = { ...makeEvent("pre1"), metadata: { seq: 100 } } as any;
		const ev2 = { ...makeEvent("pre2"), metadata: { seq: 200 } } as any;

		const auto1 = makeEvent("auto1");
		const auto2 = makeEvent("auto2");

		// Mix explicit and auto assignments across paths.
		const promises: Promise<unknown>[] = [
			Promise.resolve(appendEvent(eventsPath, ev1)),
			appendEventAsync(eventsPath, auto1),
			appendEventBuffered(eventsPath, auto2),
			Promise.resolve(appendEvent(eventsPath, ev2)),
		];
		await Promise.all(promises);
		// FIX (CI flake): Explicitly flush the buffered event so its 20ms timer
		// doesn't keep the test pending past --test-force-exit's window. Without
		// this, the test was occasionally cancelled by parent after ~9ms.
		await flushEventLogBuffer();

		const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
		const seqs = lines.map((l) => JSON.parse(l).metadata.seq);
		const unique = new Set(seqs);
		assert.equal(unique.size, seqs.length, `duplicate seqs found: ${seqs.join(", ")}`);
	});
});
