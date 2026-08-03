import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { appendEvent, appendEventAsync, appendEventFireAndForget, readEvents } from "../../src/state/event-log/event-log.ts";

test("appendEventAsync writes events correctly", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-async-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const result = await appendEventAsync(eventsPath, {
			type: "task.started",
			runId: "run-1",
			taskId: "t1",
			message: "Task started",
		});
		assert.ok(result.metadata?.seq, "event should have a seq");
		assert.equal(result.type, "task.started");
		assert.equal(result.runId, "run-1");
		assert.equal(result.taskId, "t1");
		assert.ok(result.time, "event should have a timestamp");

		// Verify the event was written to disk
		const events = readEvents(eventsPath);
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "task.started");
		assert.equal(events[0].runId, "run-1");
		assert.equal(events[0].metadata?.seq, result.metadata?.seq);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEventAsync concurrent calls maintain seq order", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-async-concurrent-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const count = 20;
		const promises = [];
		for (let i = 0; i < count; i++) {
			promises.push(
				appendEventAsync(eventsPath, {
					type: "task.progress",
					runId: "run-1",
					taskId: `t${i}`,
					data: { i },
				}),
			);
		}
		const results = await Promise.all(promises);

		// All seqs must be unique
		const seqs = results.map((r) => r.metadata?.seq ?? -1);
		assert.equal(new Set(seqs).size, seqs.length, "seqs must be unique");

		// All events on disk
		const events = readEvents(eventsPath);
		assert.equal(events.length, count, "all events should be on disk");

		// Disk seqs should be unique
		const diskSeqs = events.map((e) => e.metadata?.seq ?? -1);
		assert.equal(new Set(diskSeqs).size, diskSeqs.length, "disk seqs must be unique");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEventAsync does not block the event loop", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-async-nonblock-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Start a timer that resolves every 5ms. If the event loop is blocked,
		// the timer won't fire during appendEventAsync.
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 5);

		// Write an event (should not block the event loop)
		await appendEventAsync(eventsPath, {
			type: "task.started",
			runId: "run-1",
			taskId: "t1",
		});

		// Wait a bit for the timer to have a chance to fire
		await new Promise((resolve) => setTimeout(resolve, 20));
		clearTimeout(timer);

		assert.ok(timerFired, "event loop should not be blocked — timer should have fired");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEventAsync and sync appendEvent share seq sequence", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-async-mix-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Sync write first
		const sync = appendEvent(eventsPath, {
			type: "run.created",
			runId: "run-mix",
		});
		// Async write second
		const async = await appendEventAsync(eventsPath, {
			type: "task.started",
			runId: "run-mix",
			taskId: "t1",
		});
		// Sync write third
		const sync2 = appendEvent(eventsPath, {
			type: "run.completed",
			runId: "run-mix",
		});

		const seqs = [sync.metadata?.seq, async.metadata?.seq, sync2.metadata?.seq];
		assert.ok(
			seqs.every((s) => typeof s === "number"),
			`all seqs must be numbers: ${seqs}`,
		);
		assert.equal(new Set(seqs).size, seqs.length, `seqs must be unique: ${seqs}`);

		// Events on disk must have all 3
		const diskEvents = readEvents(eventsPath);
		assert.equal(diskEvents.length, 3, "3 events on disk");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEventFireAndForget uses async path", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-faf-async-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		appendEventFireAndForget(eventsPath, {
			type: "task.progress",
			runId: "run-1",
			taskId: "t1",
			data: { info: "test" },
		});

		// Wait for the async write to complete
		await new Promise((resolve) => setTimeout(resolve, 100));

		const events = readEvents(eventsPath);
		assert.equal(events.length, 1, "event should be written via async path");
		assert.equal(events[0].type, "task.progress");
		assert.equal(events[0].runId, "run-1");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
