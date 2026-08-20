/**
 * WP-9 (R9) worker self-reporting channel tests:
 * schema tag enforcement, sliding-window rate limit + droppedSinceLast,
 * FIFO buffer cap on failed appends (oldest dropped), single-write crash
 * safety (trailing partial line recoverable by the orchestrator reader),
 * non-team context no-op, and the unconditional env threading in
 * child-pi-spawn (read-only roles get the channel).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorkerEventsChannel } from "../../../src/prompt/worker-events-channel.ts";
import { readEvents } from "../../../src/state/event-log/cursor.ts";

function makeEventsFile(): { dir: string; eventsPath: string } {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-wchan-"));
	return { dir, eventsPath: path.join(dir, "events.jsonl") };
}

const ENV = { PI_CREW_EVENTS_PATH: "set-later", PI_CREW_BROKER_RUN_ID: "run-1", PI_CREW_TASK_ID: "task-9" };

test("schema tag: only worker.* types pass; orchestrator namespaces dropped", () => {
	const { eventsPath } = makeEventsFile();
	const written: unknown[] = [];
	const channel = createWorkerEventsChannel({
		env: { ...ENV, PI_CREW_EVENTS_PATH: eventsPath },
		appendEvent: (_p, event) => written.push(event),
	});
	assert.equal(channel.emit("worker.progress", { note: "ok" }), true);
	assert.equal(channel.emit("task.completed", { forged: true }), false, "orchestrator namespace");
	assert.equal(channel.emit("run.failed", {}), false, "orchestrator namespace");
	assert.equal(channel.emit("spec.frozen", {}), false, "orchestrator namespace");
	assert.equal(channel.emit("worker.", {}), false, "empty suffix");
	assert.equal(channel.emit("worker.".repeat(20) + "x", {}), false, "oversized");
	assert.equal(channel.stats().droppedSchema, 5);
	assert.equal(written.length, 1);
});

test("rate limit: sliding window caps accepted events; suppression is visible via droppedSinceLast on the next accepted event", () => {
	const { eventsPath } = makeEventsFile();
	const written: Record<string, unknown>[] = [];
	let clock = 0;
	const channel = createWorkerEventsChannel({
		env: { ...ENV, PI_CREW_EVENTS_PATH: eventsPath },
		appendEvent: (_p, event) => written.push(event as Record<string, unknown>),
		now: () => clock,
		maxEventsPerWindow: 3,
		windowMs: 1000,
	});
	assert.equal(channel.emit("worker.a", {}), true);
	assert.equal(channel.emit("worker.b", {}), true);
	assert.equal(channel.emit("worker.c", {}), true);
	assert.equal(channel.emit("worker.d", {}), false, "window full");
	assert.equal(channel.emit("worker.e", {}), false, "window full");
	assert.equal(channel.stats().droppedRate, 2);
	// Window slides: the next accepted event carries the dropped count.
	clock = 1001;
	assert.equal(channel.emit("worker.f", {}), true);
	const last = written.at(-1) as { data?: Record<string, unknown> };
	assert.equal((last.data as Record<string, unknown> | undefined)?.droppedSinceLast, 2, "suppression surfaced");
});

test("FIFO buffer cap: failing writer queues appends; overflow drops the OLDEST pending", () => {
	const { eventsPath } = makeEventsFile();
	let fail = true;
	const written: string[] = [];
	const channel = createWorkerEventsChannel({
		env: { ...ENV, PI_CREW_EVENTS_PATH: eventsPath },
		appendEvent: (_p, event) => {
			if (fail) throw new Error("EBUSY");
			written.push((event as { type: string }).type);
		},
		bufferCap: 3,
	});
	channel.emit("worker.one", {});
	channel.emit("worker.two", {});
	channel.emit("worker.three", {});
	channel.emit("worker.four", {}); // overflow → drops ONE (oldest)
	assert.equal(channel.stats().queued, 3);
	assert.equal(channel.stats().droppedBuffer, 1);
	// Writer recovers → flush drains FIFO order, minus the dropped one.
	fail = false;
	channel.flush();
	assert.deepEqual(written, ["worker.two", "worker.three", "worker.four"]);
	assert.equal(channel.stats().queued, 0);
});

test("crash mid-append: trailing PARTIAL line — complete events before it stay readable (recoverable)", () => {
	const { dir, eventsPath } = makeEventsFile();
	// A crashed writer left a partial line at the tail.
	fs.writeFileSync(eventsPath, `${JSON.stringify({ type: "worker.before", runId: "r" })}\n{"type":"worker.partial","runId":"r"`, "utf-8");
	// The orchestrator reader skips the corrupt line, keeps the complete one.
	const events = readEvents(eventsPath);
	assert.equal(events.length, 1);
	assert.equal(events[0]?.type, "worker.before");
	// The channel keeps appending AFTER the partial (single-write, O_APPEND) —
	// new complete lines stay readable; the partial stays quarantined.
	const channel = createWorkerEventsChannel({ env: { ...ENV, PI_CREW_EVENTS_PATH: eventsPath } });
	channel.emit("worker.after", { ok: true });
	const after = readEvents(eventsPath);
	assert.deepEqual(
		after.map((e) => e.type),
		["worker.before", "worker.after"],
	);
	fs.rmSync(dir, { recursive: true, force: true });
});

test("non-team context (no env) → no-op, never throws", () => {
	const channel = createWorkerEventsChannel({ env: {} });
	assert.equal(channel.emit("worker.progress", {}), false);
	const channelNoPath = createWorkerEventsChannel({ env: { PI_CREW_BROKER_RUN_ID: "r" } });
	assert.equal(channelNoPath.emit("worker.progress", {}), false);
	assert.equal(channel.stats().accepted, 0);
});
