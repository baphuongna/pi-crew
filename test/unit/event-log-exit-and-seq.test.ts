import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	appendEvent,
	appendEventBuffered,
	__test__clearSeqCounters as clearSeqCounters,
	__test__clearSequenceCache as clearSequenceCache,
	flushBufferedQueuesSync,
	__test__nextSequence as nextSequenceFn,
	readEvents,
	scanSequence,
	sequencePath,
} from "../../src/state/event-log.ts";

test("flushBufferedQueuesSync writes buffered events synchronously and persists the sidecar (EL-2 regression)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-el2-sync-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => {}, 50);
	try {
		// Queue 5 buffered events. appendEventBuffered returns a Promise that
		// resolves when the buffer flushes (or immediately for terminal events).
		// Non-terminal events stay queued until the buffer timer or sync flush.
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 5; i++) {
			promises.push(
				appendEventBuffered(eventsPath, { type: "task.progress", taskId: `t${i}`, runId: "run_el2", message: `progress ${i}` }),
			);
		}
		// Sync flush: simulates what the `exit`/`uncaughtException`/`SIGTERM`
		// handlers do. Without this, the buffered events would be lost on
		// process exit because the async flushEventLogBuffer cannot be awaited.
		flushBufferedQueuesSync();
		// File should contain all 5 events synchronously.
		const events = readEvents(eventsPath);
		assert.equal(events.length, 5, "sync flush must write all 5 buffered events");
		for (let i = 0; i < 5; i++) {
			assert.equal(events[i].type, "task.progress");
			assert.ok(typeof events[i].metadata?.seq === "number", "event must have an assigned seq");
		}
		// Seqs should be 1..5, contiguous.
		const seqs = events.map((e) => e.metadata?.seq ?? 0);
		assert.deepEqual(seqs, [1, 2, 3, 4, 5], "seqs must be contiguous starting at 1");
		// Sidecar must reflect the last seq (5).
		const sidecar = Number.parseInt(fs.readFileSync(sequencePath(eventsPath), "utf-8").trim(), 10);
		assert.equal(sidecar, 5, "sidecar must reflect the last persisted seq");
		// Await the original promises so they resolve cleanly (best-effort).
		await Promise.allSettled(promises);
	} finally {
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("nextSequence detects a regressed sidecar and returns max+1 (EL-1 regression)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-el1-seq-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Write 7 events normally (seqs 1..7, sidecar=7, in-memory counter=7).
		for (let i = 1; i <= 7; i++) {
			appendEvent(eventsPath, { type: "task.progress", taskId: `t${i}`, runId: "run_el1", message: `m${i}` });
		}
		const fileMax = scanSequence(eventsPath);
		assert.equal(fileMax, 7, "file should contain seqs up to 7");
		const sidecarBefore = Number.parseInt(fs.readFileSync(sequencePath(eventsPath), "utf-8").trim(), 10);
		assert.equal(sidecarBefore, 7, "sidecar should equal 7");

		// Regress the sidecar to 3 (simulates the sync/async interleave race in
		// appendEventAsync where a concurrent sync appendEvent persists a higher
		// seq, then the async path persists its lower seq).
		fs.writeFileSync(sequencePath(eventsPath), "3\n", "utf-8");
		assert.equal(Number.parseInt(fs.readFileSync(sequencePath(eventsPath), "utf-8").trim(), 10), 3, "sidecar regressed to 3");

		// Simulate a process restart: clear both the file-stat cache and the
		// in-memory seq counter so nextSequence seeds fresh from disk.
		clearSequenceCache();
		clearSeqCounters();

		// nextSequence must NOT return 4 (which would duplicate seqs 4..7 already
		// on disk). It must detect the regression and return 8.
		const next = nextSequenceFn(eventsPath);
		assert.equal(next, 8, "regressed sidecar must NOT cause duplicate seq; nextSequence must return fileMax+1");

		// File max and sidecar remain unchanged by this read (we only consulted them).
		assert.equal(scanSequence(eventsPath), 7, "file max seq unchanged");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
