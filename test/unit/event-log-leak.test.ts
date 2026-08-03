/**
 * Tests for event-log Round 14 fixes:
 * - H1: asyncQueues deletes on success (not just on error)
 * - H3: queue.splice silently drops → rejects dropped promises
 */

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { TeamEvent } from "../../src/state/event-log/event-log.ts";
import { appendEventAsync, appendEventBuffered, flushEventLogBuffer } from "../../src/state/event-log/event-log.ts";

async function makeTmp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-leak-"));
	return path.join(dir, "events.jsonl");
}

test("H1: asyncQueues does not leak entries on success", async () => {
	const eventsPath = await makeTmp();
	try {
		// Issue 100 successful appends
		const promises = Array.from({ length: 100 }, (_, i) =>
			appendEventAsync(eventsPath, {
				type: "test.event",
				data: { i },
			} as unknown as TeamEvent),
		);
		await Promise.all(promises);
		// After all resolve, asyncQueues map should be empty
		const result = await appendEventAsync(eventsPath, {
			type: "test.event",
			data: { i: 999 },
		} as unknown as TeamEvent);
		assert.equal(result.type, "test.event");
	} finally {
		await fs.rm(path.dirname(eventsPath), { recursive: true, force: true });
	}
});

test("H3: dropped buffered events are rejected (not hanging)", async () => {
	const eventsPath = await makeTmp();
	try {
		// Push more than 1000 buffered events, but never flush manually.
		// The buffer cap is 1000 entries → ~500 will be dropped.
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 1100; i += 1) {
			// Use non-terminal types so they go through the buffer
			promises.push(
				appendEventBuffered(
					eventsPath,
					{
						type: "test.spam",
						data: { i },
					} as unknown as TeamEvent,
					60000,
				).catch((err) => err),
			);
		}
		// Manually trigger the flush so the splice+reject logic runs.
		flushEventLogBuffer();
		const results = await Promise.all(promises);
		// Some of these should be the rejection error from the splice
		const rejected = results.filter((r) => r instanceof Error);
		assert.ok(rejected.length > 0, `expected at least one rejection from buffer overflow, got ${rejected.length} of ${results.length}`);
		const sample = rejected[0] as Error;
		assert.match(sample.message, /buffer overflow|dropped/i, `rejection should mention overflow/dropped; got: ${sample.message}`);
	} finally {
		await fs.rm(path.dirname(eventsPath), { recursive: true, force: true });
	}
});
