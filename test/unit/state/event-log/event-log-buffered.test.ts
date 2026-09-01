import assert from "node:assert/strict";
import type * as FsTypes from "node:fs";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__appendBatchForUnitTest,
	appendEvent,
	appendEventBuffered,
	flushEventLogBuffer,
	readEvents,
} from "../../../../src/state/event-log/event-log.ts";

test("appendEventBuffered batches into single lock acquire and preserves seq order (2.2)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-buffer-"));
	const eventsPath = path.join(dir, "events.jsonl");
	// Keep event loop alive so unref'd timer still fires
	const keepAlive = setInterval(() => undefined, 50);
	try {
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 10; i++) {
			promises.push(
				appendEventBuffered(
					eventsPath,
					{
						type: "task.progress",
						runId: "run-buf",
						taskId: `t${i}`,
						data: { i },
					},
					50,
				),
			);
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
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("flushEventLogBuffer flushes pending events synchronously (2.2)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-flush-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Buffer with a long timeout so the flush only happens via flushEventLogBuffer.
		void appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-flush" }, 60_000);
		void appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-flush" }, 60_000);
		assert.equal(fs.existsSync(eventsPath), false, "events file should not exist before flush");
		await flushEventLogBuffer();
		assert.equal(readEvents(eventsPath).length, 2, "both events written after explicit flush");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("appendEvent and appendEventBuffered share the same seq sequence (2.2)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-mix-"));
	const eventsPath = path.join(dir, "events.jsonl");
	// Keep event loop alive so unref'd timer still fires
	const keepAlive = setInterval(() => undefined, 50);
	try {
		const sync = appendEvent(eventsPath, {
			type: "run.created",
			runId: "run-mix",
		});
		const bufferedPromise = appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-mix" }, 50);
		const sync2 = appendEvent(eventsPath, {
			type: "run.completed",
			runId: "run-mix",
		});
		const buffered = await bufferedPromise;
		const seqs = [sync.metadata?.seq, buffered.metadata?.seq, sync2.metadata?.seq];
		// All seqs must be unique numbers
		assert.ok(
			seqs.every((s) => typeof s === "number"),
			`all seqs must be numbers: ${seqs}`,
		);
		// All seqs must be unique (shared counter)
		assert.equal(new Set(seqs).size, seqs.length, `seqs must be unique: ${seqs}`);
		// Events on disk must have all 3 in the order they were actually written
		const diskEvents = readEvents(eventsPath);
		assert.equal(diskEvents.length, 3, "3 events on disk");
	} finally {
		clearInterval(keepAlive);
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("buffered append leaves .seq sidecar at the flushed last seq (2026-08-24 perf)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-sidecar-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// Long buffer so the batch flushes only via flushEventLogBuffer.
		const promises = [
			appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-sidecar", taskId: "t0" }, 60_000),
			appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-sidecar", taskId: "t1" }, 60_000),
			appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-sidecar", taskId: "t2" }, 60_000),
		];
		await flushEventLogBuffer();
		const results = await Promise.all(promises);
		const seqs = results.map((r) => r.metadata?.seq ?? -1);
		const lastSeq = Math.max(...seqs);
		// The flush's skip-guard (lastSeq covered by reservation → skip the
		// seqlock round-trip) must still leave the sidecar at the flushed end:
		// R16-B1 advance-on-reserve persisted it inside the .seqlock.
		const sidecar = fs.readFileSync(`${eventsPath}.seq`, "utf-8").trim();
		assert.equal(sidecar, String(lastSeq), `.seq sidecar must equal flushed last seq ${lastSeq}, got ${sidecar}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("buffered append with explicit seq beyond the reservation still advances the .seq sidecar (2026-08-24 perf)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-event-sidecar-explicit-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// First item is auto → the batch reserves queue.length slots (1..2);
		// the second item carries an explicit seq far beyond that range.
		const promises = [
			appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-explicit", taskId: "t0" }, 60_000),
			appendEventBuffered(
				eventsPath,
				{ type: "task.progress", runId: "run-explicit", taskId: "t1", metadata: { seq: 5000 } },
				60_000,
			),
		];
		await flushEventLogBuffer();
		const results = await Promise.all(promises);
		const lastSeq = Math.max(...results.map((r) => r.metadata?.seq ?? -1));
		assert.equal(lastSeq, 5000);
		// The skip-guard compares against the RESERVATION snapshot (taken before
		// advanceSequenceCounter raises the in-process counter), so an explicit
		// seq beyond the reserved range must still persist monotonic — otherwise
		// a fresh process would re-reserve inside the file's true seq range.
		const sidecar = fs.readFileSync(`${eventsPath}.seq`, "utf-8").trim();
		assert.equal(sidecar, "5000", `.seq sidecar must advance to explicit seq 5000, got ${sidecar}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/**
 * Perf Round 2 (Task 2, 2026-08-25): the buffered batch flush must fsync the
 * events file ONLY when the batch contains a terminal event — an all-non-terminal
 * batch (the `task.progress`/`task.checkpoint` route through appendEventBuffered)
 * skips the fsync and relies on the caller's own durability. Terminal events
 * BYPASS the buffer (appendEventBuffered routes them straight to appendEvent,
 * which fsyncs itself), so a batch here has no terminal event unless a caller
 * deliberately mixed one in.
 *
 * The fsync-count assertions use the same spy technique as
 * `test/unit/manifest-cache-ttl.test.ts` and
 * `test/unit/state/event-log/event-log-pid-write.test.ts`: `node:fs` ESM
 * namespace properties are read-only, but the CommonJS exports object behind the
 * builtin IS mutable, and `module.syncBuiltinESMExports()` pushes the patched
 * functions back into every ESM namespace that imported `node:fs`.
 *
 * Instrument-liveness guard: each test first drives an fsync on the events file
 * through the terminal-branch of the batch fn and asserts the spy saw it, so
 * the zero-count assertions cannot pass vacuously if the spy were dead.
 */
interface FsyncSpy {
	readonly scopeFsyncs: number;
	restore(): void;
}

/**
 * Count `fs.fsyncSync` calls on the given events file. fsyncSync receives only an
 * fd (no path), so the spy proxies openSync/closeSync for the exact events file
 * to record the fd → path mapping, and counts fsyncSync calls whose fd maps to
 * that path. The event-log appends to the file via appendFileSync (no fd from
 * openSync we see) and fsyncs only via openSync("r+") + fsyncSync + closeSync —
 * so an fsync on the events file is always framed by its own open/close here.
 */
function spyFsyncForEventsDir(eventsPath: string): FsyncSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsCjs = nodeRequire("node:fs") as typeof FsTypes;
	const nodeModule = nodeRequire("node:module") as {
		syncBuiltinESMExports(): void;
	};
	const state = { scopeFsyncs: 0 };
	const originalFsyncSync = fsCjs.fsyncSync;
	const originalOpenSync = fsCjs.openSync;
	const originalCloseSync = fsCjs.closeSync;
	const fdToPath = new Map<number, string>();

	fsCjs.openSync = (($path, $flag, ...rest) => {
		const fd = originalOpenSync.apply(fsCjs, [$path, $flag, ...rest] as never);
		if (String($path) === eventsPath) fdToPath.set(fd as number, String($path));
		return fd;
	}) as typeof FsTypes.openSync;
	fsCjs.closeSync = ((fd) => {
		fdToPath.delete(fd as number);
		return originalCloseSync.apply(fsCjs, [fd] as never);
	}) as typeof FsTypes.closeSync;
	fsCjs.fsyncSync = ((fd) => {
		if (fdToPath.get(fd as number) === eventsPath) state.scopeFsyncs++;
		return originalFsyncSync.apply(fsCjs, [fd] as never);
	}) as typeof FsTypes.fsyncSync;
	nodeModule.syncBuiltinESMExports();
	return {
		get scopeFsyncs(): number {
			return state.scopeFsyncs;
		},
		restore() {
			fsCjs.openSync = originalOpenSync;
			fsCjs.closeSync = originalCloseSync;
			fsCjs.fsyncSync = originalFsyncSync;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

test("T2: buffered flush of an all-non-terminal batch fsyncs the events file 0 times", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t2-nonterminal-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => undefined, 50);
	const spy = spyFsyncForEventsDir(eventsPath);
	try {
		// Long buffer so the batch flushes only via flushEventLogBuffer.
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 20; i++) {
			promises.push(appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-t2", taskId: `t${i}` }, 60_000));
		}
		await flushEventLogBuffer();
		await Promise.all(promises);

		// 20 non-terminal events written in one batch.
		assert.equal(readEvents(eventsPath).length, 20, "all 20 buffered events persisted");
		// Liveness guard: the spy instrument must be live (i.e. the module under
		// test imports the same patched node:fs object) OR the 0 assertion passes
		// vacuously. Exercise the fsync gate directly: a mixed batch with a
		// terminal event MUST fsync.
		await __test__appendBatchForUnitTest(eventsPath, [
			{
				event: { type: "run.completed", runId: "run-t2", taskId: "t0" },
				resolve: () => undefined,
				reject: () => undefined,
			},
		]);
		assert.ok(spy.scopeFsyncs >= 1, `instrument liveness: mixed batch must have fsync'd the events file (got ${spy.scopeFsyncs})`);
	} finally {
		clearInterval(keepAlive);
		spy.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("T2: buffered flush of a non-terminal batch skips the fsync on the events file", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t2-skip-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const keepAlive = setInterval(() => undefined, 50);
	const spy = spyFsyncForEventsDir(eventsPath);
	try {
		// Instrument liveness guard (see first T2 test): verify the spy live path
		// BEFORE the assertion it guards, so a dead spy cannot pass the zero-count
		// assertion vacuously.
		await __test__appendBatchForUnitTest(eventsPath, [
			{
				event: { type: "run.completed", runId: "run-t2-live", taskId: "t0" },
				resolve: () => undefined,
				reject: () => undefined,
			},
		]);
		const livenessFsyncs = spy.scopeFsyncs;
		assert.ok(livenessFsyncs >= 1, `instrument liveness: drive test must have fsync'd the events file (got ${livenessFsyncs})`);

		// Now the non-terminal batch, through the SAME events file, must add 0
		// additional fsyncSync calls on that file.
		const before = spy.scopeFsyncs;
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 5; i++) {
			promises.push(appendEventBuffered(eventsPath, { type: "task.progress", runId: "run-t2-skip", taskId: `t${i}` }, 60_000));
		}
		await flushEventLogBuffer();
		await Promise.all(promises);
		assert.equal(readEvents(eventsPath).length, 6, "5 buffered + the liveness terminal event persisted");
		assert.equal(spy.scopeFsyncs, before, "all-non-terminal buffered batch must NOT fsync the events file");
	} finally {
		clearInterval(keepAlive);
		spy.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("T2: a buffered batch that contains a terminal event DOES fsync the events file (fsync gate)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-t2-terminal-"));
	const eventsPath = path.join(dir, "events.jsonl");
	const spy = spyFsyncForEventsDir(eventsPath);
	try {
		// This batch deliberately mixes a terminal event (which would NOT be
		// routed through the buffer via the public appendEventBuffered API — it
		// bypasses to appendEvent directly). The gate must detect it and fsync.
		const promises: Array<{ event: { type: string; runId: string; taskId?: string }; resolve: () => void; reject: () => void }> = [
			{ event: { type: "task.progress", runId: "run-t2-mixed" }, resolve: () => undefined, reject: () => undefined },
			{ event: { type: "task.progress", runId: "run-t2-mixed" }, resolve: () => undefined, reject: () => undefined },
			{ event: { type: "task.progress", runId: "run-t2-mixed" }, resolve: () => undefined, reject: () => undefined },
			{ event: { type: "task.failed", runId: "run-t2-mixed", taskId: "t1" }, resolve: () => undefined, reject: () => undefined },
		];
		await __test__appendBatchForUnitTest(eventsPath, promises);
		assert.equal(readEvents(eventsPath).length, 4, "all 4 mixed-batch events persisted");
		assert.ok(spy.scopeFsyncs >= 1, `mixed batch with a terminal event must fsync the events file (got ${spy.scopeFsyncs})`);
	} finally {
		spy.restore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
