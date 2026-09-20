/**
 * BR-08 regression: `readEventsCursor` with `fromByteOffset` + `limit` must
 * never hand back a continuation anchor that skips undelivered events.
 *
 * BUG (docs/archive/2026-09-18-backlog-bottlenecks-review.md BR-08): the
 * fromByteOffset branch read the WHOLE delta via readJsonlSince, delivered
 * `merged.slice(0, limit)`, but returned `nextByteOffset = newState.byteOffset`
 * — the offset after the ENTIRE delta, undelivered tail included. A caller
 * resuming from it silently skipped every event past the limit (the delta read
 * then returns an empty tail). The correct anchor is `nextSeq` (max seq among
 * DELIVERED events), with `total > events.length` signalling "more remains".
 *
 * FIX: `nextByteOffset` is only returned when the call delivered the whole
 * delta; under `limit` truncation it is OMITTED so it cannot be misused, and
 * `nextSeq`/`total` are the documented continuation/backpressure contract.
 * No production caller passes `fromByteOffset` (only tests), so the default
 * path is unchanged.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { appendEvent, readEventsCursor, type TeamEvent } from "../../../../src/state/event-log/event-log.ts";

function seqsOf(result: { events: TeamEvent[] }): number[] {
	return result.events.map((event) => event.metadata?.seq ?? 0);
}

describe("BR-08: cursor continuation anchors never skip the undelivered tail", () => {
	let tmpDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "br08-cursor-"));
		eventsPath = path.join(tmpDir, "events.jsonl");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function seed(count: number): void {
		for (let i = 1; i <= count; i++) {
			appendEvent(eventsPath, {
				type: "task.progress",
				runId: "run-br08",
				taskId: `t${i}`,
				data: { i },
			});
		}
	}

	it("a limit-truncated fromByteOffset read exposes NO nextByteOffset, and nextSeq delivers the tail", () => {
		seed(10);
		const first = readEventsCursor(eventsPath, { fromByteOffset: 0, limit: 4 });

		assert.deepEqual(seqsOf(first), [1, 2, 3, 4], "delivery is the first 4 events");
		assert.equal(first.total, 10, "total reports everything available for this read");
		assert.ok(first.total > first.events.length, "total > events.length signals more remains");
		assert.equal(first.nextSeq, 4, "nextSeq is the max seq among DELIVERED events");

		// RED pre-fix: this was `newState.byteOffset` — an offset past the whole
		// delta, so `readEventsCursor(path, { fromByteOffset: first.nextByteOffset })`
		// returned an EMPTY tail and events 5..10 were lost.
		assert.equal(
			first.nextByteOffset,
			undefined,
			"a truncated byte-offset read must not return a byte anchor past the undelivered tail",
		);

		// The documented continuation path (sinceSeq = nextSeq) delivers the tail
		// with nothing skipped and nothing duplicated.
		const second = readEventsCursor(eventsPath, { sinceSeq: first.nextSeq, limit: 4 });
		const third = readEventsCursor(eventsPath, { sinceSeq: second.nextSeq, limit: 4 });
		assert.deepEqual(seqsOf(second), [5, 6, 7, 8]);
		assert.deepEqual(seqsOf(third), [9, 10]);
		assert.deepEqual(
			[...seqsOf(first), ...seqsOf(second), ...seqsOf(third)],
			[1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
			"nextSeq pagination delivers every event exactly once",
		);
		assert.ok(third.total <= third.events.length, "drained read reports no remainder");
	});

	it("a NON-truncating limit keeps nextByteOffset (byte-offset streaming still works)", () => {
		seed(3);
		const whole = readEventsCursor(eventsPath, { fromByteOffset: 0, limit: 10 });
		assert.deepEqual(seqsOf(whole), [1, 2, 3]);
		assert.equal(whole.total, 3, "limit above the available count truncates nothing");
		assert.equal(typeof whole.nextByteOffset, "number", "whole-delta read keeps the byte-advance accelerator");

		// Deltas only: the returned offset is a sound resume anchor here.
		seed(5); // seqs 4..8
		const delta = readEventsCursor(eventsPath, { fromByteOffset: whole.nextByteOffset });
		assert.deepEqual(seqsOf(delta), [4, 5, 6, 7, 8], "resuming from a whole-delta offset must not skip events");
	});

	it("an unlimited fromByteOffset read keeps nextByteOffset (pre-existing behavior)", () => {
		seed(2);
		const first = readEventsCursor(eventsPath, { fromByteOffset: 0 });
		assert.deepEqual(seqsOf(first), [1, 2]);
		assert.equal(first.nextSeq, 2);
		assert.equal(typeof first.nextByteOffset, "number");
		const second = readEventsCursor(eventsPath, { fromByteOffset: first.nextByteOffset });
		assert.deepEqual(second.events, [], "no new events ⇒ empty delta");
	});
});
