import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendEvent, appendEventAsync, appendEventBuffered, readEvents, resetEventLogMode } from "../../src/state/event-log/event-log.ts";

test.beforeEach(() => {
	resetEventLogMode();
});

test("non-terminal events via appendEventAsync are written directly (no buffering since v0.9.26)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-async-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Since v0.9.26, appendEventAsync does NOT buffer — it writes directly.
		// The buffer was reverted because mixing sync and async lock mechanisms
		// caused deadlocks. appendEventBuffered is still available for explicit
		// coalesced writes.
		const p1 = appendEventAsync(eventsPath, { type: "task.progress", runId: "r1", taskId: "t1", data: { step: 1 } });
		const p2 = appendEventAsync(eventsPath, { type: "task.checkpoint", runId: "r1", taskId: "t1", data: { step: 2 } });

		// Await both promises — events are written directly (not buffered)
		const r1 = await p1;
		const r2 = await p2;

		const events = readEvents(eventsPath);
		assert.equal(events.length, 2, "both events written directly");
		// Seq should be monotonic
		assert.ok((r1.metadata?.seq ?? 0) < (r2.metadata?.seq ?? 0), "seq should be monotonic");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("terminal events via appendEventAsync bypass buffer and are written immediately", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-terminal-async-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const result = await appendEventAsync(eventsPath, { type: "run.completed", runId: "r1" });
		assert.ok(result.metadata?.seq, "terminal event should have a seq");

		// Terminal event should be on disk immediately (not buffered)
		const events = readEvents(eventsPath);
		assert.equal(events.length, 1, "terminal event written immediately");
		assert.equal(events[0].type, "run.completed");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("terminal events via appendEvent bypass buffer and are written immediately (sync)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-terminal-sync-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const result = appendEvent(eventsPath, { type: "task.failed", runId: "r1", taskId: "t1" });
		assert.ok(result.metadata?.seq, "terminal event should have a seq");

		const events = readEvents(eventsPath);
		assert.equal(events.length, 1, "terminal event written immediately");
		assert.equal(events[0].type, "task.failed");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("non-terminal events via appendEvent sync path are written directly (not buffered)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-nonterminal-sync-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Non-terminal events via sync appendEvent go through the direct sync path
		// (appendEvent cannot use the buffer because sleepSync blocks the event loop)
		const r1 = appendEvent(eventsPath, { type: "task.progress", runId: "r1", taskId: "t1", data: { i: 1 } });
		const r2 = appendEvent(eventsPath, { type: "worker.lifecycle", runId: "r1", taskId: "t1", data: { state: "running" } });

		assert.ok(r1.metadata?.seq, "event 1 should have a seq");
		assert.ok(r2.metadata?.seq, "event 2 should have a seq");
		assert.ok(r1.metadata!.seq < r2.metadata!.seq, "seq should be monotonic");

		const events = readEvents(eventsPath);
		assert.equal(events.length, 2, "both events on disk after sync calls");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("terminal event flushes pending buffered events before writing (via appendEventBuffered)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-flush-before-terminal-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Queue non-terminal events with long buffer timeout
		void appendEventBuffered(eventsPath, { type: "task.progress", runId: "r1", taskId: "t1" }, 60_000);
		void appendEventBuffered(eventsPath, { type: "task.progress", runId: "r1", taskId: "t2" }, 60_000);

		// Wait a tick to ensure they're queued but not flushed
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(fs.existsSync(eventsPath), false, "buffered events not written yet");

		// Terminal event should flush buffer first, then write itself
		const terminal = await appendEventBuffered(eventsPath, { type: "run.completed", runId: "r1" });

		const events = readEvents(eventsPath);
		assert.equal(events.length, 3, "2 buffered + 1 terminal = 3 events");
		// All events should be present
		const types = events.map((e) => e.type).sort();
		assert.deepEqual(types, ["run.completed", "task.progress", "task.progress"], "all event types present");
		assert.ok(terminal.metadata?.seq, "terminal event has seq");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("mixed terminal and non-terminal events maintain unique monotonic seqs", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-mixed-seq-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => undefined, 50);
	try {
		// Mix of sync (direct path) and async (buffered for non-terminal) calls
		const syncTerminal = appendEvent(eventsPath, { type: "run.created", runId: "r1" });
		const asyncNonTerminal = await appendEventAsync(eventsPath, { type: "task.progress", runId: "r1", taskId: "t1" });
		const asyncTerminal = await appendEventAsync(eventsPath, { type: "task.completed", runId: "r1", taskId: "t1" });
		const syncNonTerminal = appendEvent(eventsPath, { type: "task.checkpoint", runId: "r1", taskId: "t1" });

		const seqs = [
			syncTerminal.metadata?.seq,
			asyncNonTerminal.metadata?.seq,
			asyncTerminal.metadata?.seq,
			syncNonTerminal.metadata?.seq,
		];

		// All seqs must be numbers
		assert.ok(
			seqs.every((s) => typeof s === "number"),
			`all seqs must be numbers: ${seqs}`,
		);
		// All seqs must be unique
		assert.equal(new Set(seqs).size, seqs.length, `seqs must be unique: ${seqs}`);
		// All events on disk
		const diskEvents = readEvents(eventsPath);
		assert.equal(diskEvents.length, 4, "4 events on disk");
	} finally {
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEventFireAndForget routes non-terminal events through buffer", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-faf-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Fire-and-forget for non-terminal event (goes through appendEventAsync → buffer)
		const { appendEventFireAndForget } = await import("../../src/state/event-log/event-log.ts");
		appendEventFireAndForget(eventsPath, { type: "task.progress", runId: "r1", taskId: "t1", data: { x: 1 } });

		// Wait for buffer to flush (20ms default + margin)
		await new Promise((r) => setTimeout(r, 100));

		const events = readEvents(eventsPath);
		assert.equal(events.length, 1, "event written via fire-and-forget through buffer");
		assert.equal(events[0].type, "task.progress");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("non-terminal events via appendEventAsync batch under single lock acquire", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-batch-lock-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => undefined, 50);
	try {
		// Queue many non-terminal events rapidly — they should coalesce into a single flush
		const count = 50;
		const promises: Promise<{ metadata?: { seq?: number } }>[] = [];
		for (let i = 0; i < count; i++) {
			promises.push(
				appendEventAsync(eventsPath, {
					type: "task.progress",
					runId: "r1",
					taskId: `t${i}`,
					data: { i },
				}),
			);
		}

		// Wait for buffer to flush
		await Promise.all(promises);

		const events = readEvents(eventsPath);
		assert.equal(events.length, count, `all ${count} events written`);

		// All seqs must be unique and monotonic
		const seqs = events.map((e) => e.metadata?.seq ?? -1);
		assert.equal(new Set(seqs).size, seqs.length, "seqs must be unique");
		const sorted = [...seqs].sort((a, b) => a - b);
		assert.deepEqual(seqs, sorted, "seqs must be monotonic");
	} finally {
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
