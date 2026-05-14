import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendEvent, appendEventBuffered, flushEventLogBuffer, readEvents } from "../../src/state/event-log.ts";

test("appendEventBuffered batches into single lock acquire and preserves seq order (2.2)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-buffer-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 10; i++) {
			promises.push(appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-buf", taskId: `t${i}`, data: { i } }, 5));
		}
		const results = await Promise.all(promises);
		// Every event has a unique monotonic seq.
		const seqs = (results as Array<{ metadata?: { seq?: number } }>).map((r) => r.metadata?.seq ?? -1);
		const sorted = [...seqs].sort((a, b) => a - b);
		assert.deepEqual(seqs, sorted, "seqs returned in queue order should be monotonic");
		assert.equal(new Set(seqs).size, seqs.length, "seqs must be unique");
		// File on disk has 10 lines.
		const events = readEvents(eventsPath);
		assert.equal(events.length, 10);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("flushEventLogBuffer flushes pending events synchronously (2.2)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-flush-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Buffer with a long timeout so the flush only happens via flushEventLogBuffer.
		void appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-flush" }, 60_000);
		void appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-flush" }, 60_000);
		assert.equal(fs.existsSync(eventsPath), false, "events file should not exist before flush");
		flushEventLogBuffer();
		assert.equal(readEvents(eventsPath).length, 2, "both events written after explicit flush");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEvent and appendEventBuffered share the same seq sequence (2.2)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-mix-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const sync = appendEvent(eventsPath, { type: "run.created", runId: "run-mix" });
		const buffered = await appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-mix" }, 5);
		const sync2 = appendEvent(eventsPath, { type: "run.completed", runId: "run-mix" });
		const seqs = [sync.metadata?.seq, buffered.metadata?.seq, sync2.metadata?.seq];
		assert.ok(seqs.every((s) => typeof s === "number"));
		assert.equal((seqs[0] ?? 0) + 1, seqs[1]);
		assert.equal((seqs[1] ?? 0) + 1, seqs[2]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
