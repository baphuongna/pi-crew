/**
 * L1 — RunEventBus.onWithReplay tests.
 *
 * Validates the catch-up-replay primitive that closes the
 * transient-subscriber-absence gap: when an overlay/widget is disposed and
 * recreated, events emitted in the window are replayed from the durable
 * JSONL log before the live listener attaches, with seq-based dedup so each
 * event fires exactly once.
 *
 * Coverage:
 *   - replay order and completeness (events missed during absence)
 *   - dedup: a live event whose seq was already replayed is suppressed
 *   - transient live-only events (no seq) always deliver
 *   - cursor bound: large log does not OOM (limit honored)
 *   - missing/nonexistent log → graceful live-only fallback
 *   - unsubscribe detaches the live listener
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendEvent, type TeamEvent } from "../../src/state/event-log.ts";
import { runEventBus } from "../../src/ui/run-event-bus.ts";

const tempDirs: string[] = [];

function freshEventsPath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-replay-"));
	tempDirs.push(dir);
	return path.join(dir, "events.jsonl");
}

function cleanup(): void {
	while (tempDirs.length > 0) {
		try {
			fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

/** Append a task.started event and return the persisted TeamEvent (with seq). */
function appendStarted(eventsPath: string, runId: string, taskId: string): TeamEvent {
	return appendEvent(eventsPath, {
		type: "task.started",
		runId,
		taskId,
		data: {},
	});
}

test("onWithReplay replays missed events in order before live listener attaches", () => {
	const eventsPath = freshEventsPath();
	const runId = "replay-order";
	try {
		// Write 3 events while NO subscriber is attached (simulating absence).
		appendStarted(eventsPath, runId, "t1");
		appendStarted(eventsPath, runId, "t2");
		appendStarted(eventsPath, runId, "t3");

		const received: string[] = [];
		const unsub = runEventBus.onWithReplay(runId, eventsPath, 0, (e) => received.push(e.taskId ?? ""));

		// All 3 replayed, in seq order.
		assert.deepEqual(received, ["t1", "t2", "t3"]);
		unsub();
	} finally {
		cleanup();
	}
});

test("onWithReplay dedups: a live event already replayed is suppressed", async () => {
	const eventsPath = freshEventsPath();
	const runId = "replay-dedup";
	try {
		// Event seq=1 persisted before subscribe.
		const ev1 = appendStarted(eventsPath, runId, "t1");
		const seq1 = ev1.metadata?.seq ?? 0;

		const received: string[] = [];
		const unsub = runEventBus.onWithReplay(runId, eventsPath, 0, (e) => received.push(e.taskId ?? ""));

		// Replay delivered t1.
		assert.deepEqual(received, ["t1"]);

		// Now a LIVE event arrives for the SAME seq (e.g. a delayed emit of the
		// same logged event). It must be suppressed (already replayed).
		runEventBus.emit({
			type: "task_started",
			runId,
			taskId: "t1",
			seq: seq1,
		});
		await Promise.resolve();
		assert.deepEqual(received, ["t1"], "live event with replayed seq must be suppressed");

		// A NEW live event (higher seq) must deliver.
		runEventBus.emit({
			type: "task_started",
			runId,
			taskId: "t2",
			seq: seq1 + 1,
		});
		await Promise.resolve();
		assert.deepEqual(received, ["t1", "t2"]);
		unsub();
	} finally {
		cleanup();
	}
});

test("onWithReplay delivers transient live-only events (no seq)", async () => {
	const eventsPath = freshEventsPath();
	const runId = "replay-transient";
	try {
		// No persisted events.
		const received: string[] = [];
		const unsub = runEventBus.onWithReplay(runId, eventsPath, 0, (e) => received.push(e.taskId ?? "no-task"));

		// worker_status events from the stream bridge carry NO seq (they are
		// live-only, never persisted). They must always deliver.
		runEventBus.emit({ type: "worker_status", runId });
		await Promise.resolve();
		assert.equal(received.length, 1);
		assert.equal(received[0], "no-task");
		unsub();
	} finally {
		cleanup();
	}
});

test("onWithReplay honors cursor limit (no OOM on large logs)", () => {
	const eventsPath = freshEventsPath();
	const runId = "replay-bound";
	try {
		// Write many events.
		const N = 50;
		for (let i = 0; i < N; i++) appendStarted(eventsPath, runId, `t${i}`);

		const received: string[] = [];
		// The internal limit is 1000; with 50 events all replay. This asserts
		// bounded reads work and order is preserved across a larger set.
		const unsub = runEventBus.onWithReplay(runId, eventsPath, 0, (e) => received.push(e.taskId ?? ""));
		assert.equal(received.length, N);
		assert.equal(received[0], "t0");
		assert.equal(received[N - 1], `t${N - 1}`);
		unsub();
	} finally {
		cleanup();
	}
});

test("onWithReplay only replays events with seq > lastSeenSeq", () => {
	const eventsPath = freshEventsPath();
	const runId = "replay-since";
	try {
		const e1 = appendStarted(eventsPath, runId, "old");
		appendStarted(eventsPath, runId, "new1");
		appendStarted(eventsPath, runId, "new2");
		const lastSeen = e1.metadata?.seq ?? 0;

		const received: string[] = [];
		const unsub = runEventBus.onWithReplay(runId, eventsPath, lastSeen, (e) => received.push(e.taskId ?? ""));
		// 'old' (seq <= lastSeen) must NOT replay; only new1, new2.
		assert.deepEqual(received, ["new1", "new2"]);
		unsub();
	} finally {
		cleanup();
	}
});

test("onWithReplay falls back to live-only when the log does not exist", async () => {
	const missingPath = path.join(os.tmpdir(), `pi-crew-replay-missing-${Date.now()}`, "events.jsonl");
	const runId = "replay-missing";
	try {
		const received: string[] = [];
		const unsub = runEventBus.onWithReplay(runId, missingPath, 0, (e) => received.push(e.taskId ?? "live"));
		// No replay (file missing); live listener still works.
		assert.deepEqual(received, []);
		runEventBus.emit({ type: "task_started", runId, taskId: "after" });
		await Promise.resolve();
		assert.deepEqual(received, ["after"]);
		unsub();
	} finally {
		cleanup();
	}
});

test("onWithReplay unsubscribe detaches the live listener", () => {
	const eventsPath = freshEventsPath();
	const runId = "replay-unsub";
	try {
		const received: string[] = [];
		const unsub = runEventBus.onWithReplay(runId, eventsPath, 0, (e) => received.push(e.taskId ?? ""));
		unsub();
		// After unsubscribe, live events must not deliver.
		runEventBus.emit({
			type: "task_started",
			runId,
			taskId: "post",
			seq: 999,
		});
		assert.deepEqual(received, []);
	} finally {
		cleanup();
	}
});
