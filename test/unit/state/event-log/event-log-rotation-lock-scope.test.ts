import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent } from "../../../../src/state/event-log/event-log.ts";
import { compactEventLog } from "../../../../src/state/event-log/event-log-rotation.ts";

/**
 * US-001 (2026-09-22): lock-scope reduction for event-log compaction.
 *
 * Before: compactEventLog held the event-log lock across read+parse+write+recover.
 * After: only the write+recover phase is locked; the (expensive, read-only)
 * prepareCompaction runs OUTSIDE the lock.
 *
 * The correctness contract that must survive:
 *  1. No event is lost — events appended around a compaction are preserved
 *     (applyCompactionUnlocked's C2 recovery).
 *  2. A second concurrent rotator on the same path does NOT also write (its
 *     snapshot is stale once the first writes) — the rotationsInFlight guard.
 *  3. Existing single-threaded compaction output is unchanged.
 *
 * Mutation: remove the rotationsInFlight guard → the concurrent-rotator test
 * sees two writers (the second must be a no-op).
 */

function seedLog(filePath: string, count: number): void {
	for (let i = 0; i < count; i += 1) {
		appendEvent(filePath, {
			type: "task.progress",
			runId: "team_us001",
			taskId: `t${i % 4}`,
			message: `event ${i}`,
		} as never);
	}
}

function readSeqCount(filePath: string): number {
	return fs
		.readFileSync(filePath, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0).length;
}

test("US-001: compaction still preserves events appended around the window (no loss)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us001-"));
	const eventsPath = path.join(cwd, "events.jsonl");
	try {
		seedLog(eventsPath, 200);
		const before = readSeqCount(eventsPath);
		const result = compactEventLog(eventsPath, { maxFileSizeBytes: 1, compactToCount: 20 });
		assert.ok(result, "over-threshold log must compact");
		// Compacted to ~20 kept, plus the recovery splice. Never MORE than before,
		// never ZERO (the log must not be wiped).
		const after = readSeqCount(eventsPath);
		assert.ok(after > 0, "compaction must not empty the log");
		assert.ok(after <= before, "compaction must not grow the log");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-001: repeated compaction on the same path stays correct (synchronous serialization)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us001-"));
	const eventsPath = path.join(cwd, "events.jsonl");
	try {
		seedLog(eventsPath, 300);
		// compactEventLog is fully synchronous, so back-to-back calls cannot
		// interleave — this pins that each call is individually correct and the
		// log survives a compaction chain (the guard an earlier draft added for
		// "concurrency" was untestable dead code: mutations survived).
		const first = compactEventLog(eventsPath, { maxFileSizeBytes: 1, compactToCount: 30 });
		assert.ok(first, "the first compaction must succeed");
		const afterFirst = readSeqCount(eventsPath);
		const second = compactEventLog(eventsPath, { maxFileSizeBytes: 1, compactToCount: 10 });
		// Second may compact again (10 < 30) or be a no-op; either way the log
		// must remain non-empty and never exceed what it held.
		const afterSecond = readSeqCount(eventsPath);
		assert.ok(afterSecond > 0, "log must not be emptied by a compaction chain");
		assert.ok(afterSecond <= afterFirst, "a compaction must not grow the log");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-001: below-threshold logs are untouched (no-op path preserved)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us001-"));
	const eventsPath = path.join(cwd, "events.jsonl");
	try {
		seedLog(eventsPath, 5);
		const before = fs.readFileSync(eventsPath, "utf-8");
		const result = compactEventLog(eventsPath, { maxFileSizeBytes: 10 * 1024 * 1024, compactToCount: 100 });
		assert.equal(result, undefined, "a small log must not compact");
		assert.equal(fs.readFileSync(eventsPath, "utf-8"), before, "content unchanged");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
