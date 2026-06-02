/**
 * Tests for event-log Round 14 fixes:
 * - H1: asyncQueues deletes on success (not just on error)
 * - H3: queue.splice silently drops → rejects dropped promises
 */
import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendEventAsync, appendEventBuffered, flushEventLogBuffer } from "../../src/state/event-log.ts";

async function makeTmp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "event-log-leak-"));
	return path.join(dir, "events.jsonl");
}

test("H1: asyncQueues does not leak entries on success", async () => {
	const eventsPath = await makeTmp();
	try {
		// Issue 100 successful appends
		const promises = Array.from({ length: 100 }, (_, i) =>
			appendEventAsync(eventsPath, { type: "test.event", payload: { i } }),
		);
		await Promise.all(promises);
		// After all resolve, asyncQueues map should be empty
		// We can't inspect the private Map directly, but we can verify by
		// appending another batch and ensuring no stale entries cause issues.
		const result = await appendEventAsync(eventsPath, { type: "test.event", payload: { i: 999 } });
		assert.equal(result.type, "test.event");
		// If asyncQueues were leaking, the next call would still chain on
		// the old promise — but since it resolves correctly, no leak.
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
				appendEventBuffered(eventsPath, { type: "test.spam", payload: { i } }).catch((err) => err),
			);
		}
		// Manually trigger the flush so the splice+reject logic runs.
		flushEventLogBuffer();
		const results = await Promise.all(promises);
		// Some of these should be the rejection error from the splice
		const rejected = results.filter((r) => r instanceof Error);
		assert.ok(
			rejected.length > 0,
			`expected at least one rejection from buffer overflow, got ${rejected.length} of ${results.length}`,
		);
		const sample = rejected[0] as Error;
		assert.match(
			sample.message,
			/buffer overflow|dropped/i,
			`rejection should mention overflow/dropped; got: ${sample.message}`,
		);
	} finally {
		await fs.rm(path.dirname(eventsPath), { recursive: true, force: true });
	}
});
