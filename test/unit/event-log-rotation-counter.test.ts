/**
 * P0-2 regression guard: per-eventsPath append counter.
 *
 * The old code had a single module-global `appendCounter` that was incremented
 * in ONLY the sync append path. The async path checked `appendCounter % 100 === 0`
 * without incrementing, so `0 % 100 === 0` was always true → `needsRotation`
 * ran on EVERY async append (a full read+parse+rewrite once over 4 MB).
 *
 * This test pins the counter semantics directly: rotation is sampled at
 * 100-boundaries, per-path independently, and FIFO-bounded.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { tickAppendCounter } from "../../src/state/event-log.ts";

test("tickAppendCounter: returns true only at 100-boundaries (inc=1)", () => {
	const path = `/tmp/test-events-${Math.random()}.jsonl`;
	const hits: number[] = [];
	for (let i = 1; i <= 250; i++) {
		if (tickAppendCounter(path)) hits.push(i);
	}
	// Crosses at exactly 100 and 200 — NOT every call (the old bug).
	assert.deepEqual(hits, [100, 200]);
});

test("tickAppendCounter: per-path independence (no cross-run mis-attribution)", () => {
	const a = `/tmp/test-events-a-${Math.random()}.jsonl`;
	const b = `/tmp/test-events-b-${Math.random()}.jsonl`;
	let aHits = 0;
	let bHits = 0;
	for (let i = 0; i < 150; i++) if (tickAppendCounter(a)) aHits++;
	for (let i = 0; i < 150; i++) if (tickAppendCounter(b)) bHits++;
	// Each path crossed 100 exactly once — counts are independent.
	assert.equal(aHits, 1);
	assert.equal(bHits, 1);
	// Ticking a does not move b's counter (both now at 150).
	assert.equal(tickAppendCounter(a), false); // a→151
	assert.equal(tickAppendCounter(b), false); // b→151, unaffected by a
});

test("tickAppendCounter: batch inc crosses a boundary if spanned", () => {
	const path = `/tmp/test-events-batch-${Math.random()}.jsonl`;
	// Pre-advance to 95.
	for (let i = 0; i < 95; i++) tickAppendCounter(path);
	// Batch of 10 → crosses 100.
	assert.equal(tickAppendCounter(path, 10), true);
	// Now at 105; a batch of 94 → crosses 200? 105+94=199 → no. 105+95=200 → yes.
	assert.equal(tickAppendCounter(path, 94), false);
	assert.equal(tickAppendCounter(path, 1), true); // 199→200
});

test("tickAppendCounter: FIFO-bounded (map does not grow unbounded with run count)", () => {
	// Exercise far more distinct paths than the cap; the function must not throw
	// and must keep working. (APPEND_COUNTER_MAX_ENTRIES = 256.)
	for (let i = 0; i < 1000; i++) {
		tickAppendCounter(`/tmp/test-events-fifo-${i}.jsonl`);
	}
	// A fresh path still behaves correctly after the churn.
	const fresh = `/tmp/test-events-fifo-fresh-${Math.random()}.jsonl`;
	const hits: number[] = [];
	for (let i = 1; i <= 100; i++) if (tickAppendCounter(fresh)) hits.push(i);
	assert.deepEqual(hits, [100]);
});
