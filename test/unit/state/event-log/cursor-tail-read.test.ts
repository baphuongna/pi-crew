/**
 * Perf round 2 / Task 6 (fix round 1): readEventsCursor verified watermark
 * tail cache.
 *
 * The first cut scaled the tail window down with `limit` and accepted it
 * whenever the window's first parsed seq <= sinceSeq — assuming file order
 * == seq order. That is false: compaction recovery re-appends old seqs at
 * the END of the file, the sync/async lock families are disjoint, and
 * explicit baseMetadata.seq appends bypass reservation ordering, so a file
 * can look like [1..200, 5000, 201..1700] and the old fast path silently
 * dropped event 5000 forever.
 *
 * The replacement is a per-path VERIFIED watermark cache (transcript-cache
 * pattern): stamps + verifiedOffset + lastSeq + a bounded parsed ring. The
 * watermark is established only by a full parse with non-decreasing finite
 * seqs and extended only by verified deltas; answering from the ring
 * requires proof that no post-sinceSeq event was dropped
 * (ringStartSeq <= sinceSeq on a verified lineage, or ringStartOffset
 * === 0). Every branch here is pinned by deepEqual against a full-file
 * ground-truth parse with the exact cursor ordering (5000-event tail cap
 * BEFORE the sinceSeq filter, then limit as a HEAD cap).
 *
 * Fix round 2: the stamps now include inode identity (stat.ino + stat.dev).
 * A same-path rewrite — compaction (atomicWriteFile temp+rename), rotation
 * (renameSync + 'wx' create), forget+import — produces a NEW inode, so a
 * rewrite followed by regrowth past the old size (size > previous.size,
 * mtimeMs >= previous.mtimeMs) can no longer be mistaken for append growth
 * and read from a dead watermark's offset. The wide path also drops the
 * entry so sinceSeq=0 / no-limit calls cannot keep stale stamps alive.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { clearEventsCursorTailCache, readEventsCursor, type TeamEvent } from "../../../../src/state/event-log/event-log.ts";

interface FsReadSpy {
	readonly readFileSyncCalls: number;
	readonly readSyncCalls: number;
	readonly readSyncBytes: number;
	restore(): void;
}

/**
 * Spy on fs.readFileSync + fs.readSync via the mutable CommonJS exports
 * object behind the node:fs builtin (the ESM namespace is read-only),
 * refreshed into every ESM namespace with syncBuiltinESMExports() — the
 * test/unit/manifest-cache-ttl.test.ts pattern.
 *
 * readFileSync is scoped to .jsonl files under `rootDir` so unrelated
 * traffic cannot perturb the counts; readSync takes an fd (no path), but
 * the spied cursor call is synchronous, so no other reads can interleave.
 */
function spyFsReads(rootDir: string): FsReadSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as {
		readFileSync: (...args: unknown[]) => unknown;
		readSync: (...args: unknown[]) => number;
	};
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const originalReadFile = fsDefault.readFileSync;
	const originalRead = fsDefault.readSync;
	const state = { readFileSyncCalls: 0, readSyncCalls: 0, readSyncBytes: 0 };
	const inScope = (target: unknown): boolean =>
		typeof target === "string" && target.endsWith(".jsonl") && (target === rootDir || target.startsWith(`${rootDir}${path.sep}`));
	fsDefault.readFileSync = (...args: unknown[]) => {
		if (inScope(args[0])) state.readFileSyncCalls++;
		return originalReadFile.apply(fsDefault, args);
	};
	fsDefault.readSync = (...args: unknown[]) => {
		// Signature: readSync(fd, buffer, offset, length, position).
		const lengthArg = args[3] as number | undefined;
		if (typeof lengthArg === "number" && lengthArg > 0) {
			state.readSyncCalls++;
			state.readSyncBytes += lengthArg;
		}
		return originalRead.apply(fsDefault, args);
	};
	nodeModule.syncBuiltinESMExports();
	return {
		get readFileSyncCalls() {
			return state.readFileSyncCalls;
		},
		get readSyncCalls() {
			return state.readSyncCalls;
		},
		get readSyncBytes() {
			return state.readSyncBytes;
		},
		restore() {
			fsDefault.readFileSync = originalReadFile;
			fsDefault.readSync = originalRead;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

function eventLine(seq: number): string {
	return (
		JSON.stringify({
			type: "task.progress",
			runId: "r1",
			taskId: `t${seq}`,
			message: "x".repeat(140),
			metadata: { seq, provenance: "test" },
		}) + "\n"
	);
}

/** Monotonic fixture of `count` events (~230B lines). ~2.3MB for 10k events:
 *  far below the 4MB wide window (so wide-path ground truth is exact) and
 *  far above any single delta. */
function writeEventsFixture(dir: string, count: number, startSeq = 1): string {
	const eventsPath = path.join(dir, "events.jsonl");
	const lines: string[] = [];
	for (let seq = startSeq; seq < startSeq + count; seq++) lines.push(eventLine(seq));
	fs.writeFileSync(eventsPath, lines.join(""), "utf-8");
	return eventsPath;
}

/** The reviewer's repro shape: [1..200, 5000, 201..1700] — an out-of-order
 *  re-append in the middle of an otherwise monotonic file. */
function writeOutOfOrderFixture(dir: string): string {
	const eventsPath = path.join(dir, "events.jsonl");
	const lines: string[] = [];
	for (let seq = 1; seq <= 200; seq++) lines.push(eventLine(seq));
	lines.push(eventLine(5000));
	for (let seq = 201; seq <= 1700; seq++) lines.push(eventLine(seq));
	fs.writeFileSync(eventsPath, lines.join(""), "utf-8");
	return eventsPath;
}

function appendEvents(eventsPath: string, seqs: number[]): number {
	const chunk = seqs.map(eventLine).join("");
	fs.appendFileSync(eventsPath, chunk, "utf-8");
	return Buffer.byteLength(chunk, "utf-8");
}

/** Rewrite the events file via temp+rename — the atomicWriteFile shape used
 *  by compaction (and rotation's rename side): the path ends up naming a
 *  NEW inode, unlike a writeFileSync truncation which reuses it. */
function rewriteViaAtomicRename(eventsPath: string, seqs: number[]): void {
	const tmp = `${eventsPath}.rewrite-tmp`;
	fs.writeFileSync(tmp, seqs.map(eventLine).join(""), "utf-8");
	fs.renameSync(tmp, eventsPath);
}

/** eventLine variant padded to an EXACT total byte length, so a rewrite can
 *  preserve the primed size bit-for-bit (isolates the inode signal from the
 *  size signal; "x" padding never needs JSON escaping). */
function fixedLengthEventLine(seq: number, totalBytes: number): string {
	const bare = JSON.stringify({
		type: "task.progress",
		runId: "r1",
		taskId: `t${seq}`,
		message: "",
		metadata: { seq, provenance: "test" },
	});
	const overhead = Buffer.byteLength(bare, "utf-8") + 1; // + "\n"
	const line = JSON.stringify({
		type: "task.progress",
		runId: "r1",
		taskId: `t${seq}`,
		message: "x".repeat(totalBytes - overhead),
		metadata: { seq, provenance: "test" },
	});
	return `${line}\n`;
}

function appendRawLines(eventsPath: string, lines: string[]): number {
	const chunk = lines.map((line) => `${line}\n`).join("");
	fs.appendFileSync(eventsPath, chunk, "utf-8");
	return Buffer.byteLength(chunk, "utf-8");
}

/** Ground truth: the full-file parse with the exact readEventsCursor
 *  ordering — the 5000-event TAIL cap slices the parsed events BEFORE the
 *  sinceSeq filter, then limit is a head cap (slice(0, limit)) after it. */
function parseGroundTruth(eventsPath: string, sinceSeq: number, limit?: number): TeamEvent[] {
	const parsed: TeamEvent[] = [];
	for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			parsed.push(JSON.parse(trimmed) as TeamEvent);
		} catch {
			/* skip corrupt lines */
		}
	}
	const capped = parsed.length > 5000 ? parsed.slice(-5000) : parsed;
	const filtered = capped.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
	return limit !== undefined ? filtered.slice(0, limit) : filtered;
}

function tmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	// The watermark cache is module-global and keyed by path; unique tmpdirs
	// already isolate tests, but clear anyway so a future path reuse cannot
	// leak state between tests.
	clearEventsCursorTailCache();
	return dir;
}

test("repro: out-of-order file [1..200, 5000, 201..1700] keeps event 5000 (no order assumption)", () => {
	const dir = tmpDir("pi-crew-cursor-repro-");
	try {
		const eventsPath = writeOutOfOrderFixture(dir);
		assert.ok(fs.statSync(eventsPath).size < 4 * 1024 * 1024, "fixture must fit the wide window so ground truth is exact");
		const expected = parseGroundTruth(eventsPath, 1600, 50);
		// Old wide behavior: [5000, 1601..1650] — the re-appended event 5000
		// (seq > sinceSeq, earlier in file order than 1601) MUST be present.
		assert.equal(expected.length, 50);
		assert.equal(expected[0]?.metadata?.seq, 5000, "ground truth starts at the re-appended 5000");
		assert.equal(expected[1]?.metadata?.seq, 1601);

		const cursor = readEventsCursor(eventsPath, { sinceSeq: 1600, limit: 50 });
		assert.deepEqual(cursor.events, expected, "watermark-cache result must equal the full-parse result");
		assert.equal(cursor.events[0]?.metadata?.seq, 5000, "event 5000 must NOT be silently dropped");
		assert.equal(cursor.events[1]?.metadata?.seq, 1601);
		assert.equal(cursor.total, 101, "total = 1 re-appended + 100 post-1600 events");
		// nextSeq is the max seq of the returned events — 5000 here, exactly
		// like the old wide path (it is a high-water mark, not a tail seq).
		assert.equal(cursor.nextSeq, 5000);

		// Second call on the unchanged file: the unverified lineage still
		// answers from the offset-0 ring (whole file) and stays exact.
		const again = readEventsCursor(eventsPath, { sinceSeq: 1600, limit: 50 });
		assert.deepEqual(again.events, expected, "cached repeat must stay exact");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("unchanged file serves purely from the ring (zero event-byte reads)", () => {
	const dir = tmpDir("pi-crew-cursor-cached-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		const fileSize = fs.statSync(eventsPath).size;
		assert.ok(fileSize > 512 * 1024 && fileSize < 4 * 1024 * 1024, "fixture must be > windows and < 4MB");
		// Prime the cache (full parse on miss).
		const primed = readEventsCursor(eventsPath, { sinceSeq: 9950, limit: 50 });
		assert.equal(primed.events.length, 50);

		const expected = parseGroundTruth(eventsPath, 9950, 50);
		assert.equal(expected.length, 50, "ground truth must be seqs 9951..10000");

		const spy = spyFsReads(dir);
		try {
			// Instrument liveness guard: a dead spy (e.g. a future Node breaking
			// syncBuiltinESMExports) would make every count assertion below pass
			// vacuously. One manual scoped readFileSync MUST be counted.
			fs.writeFileSync(path.join(dir, "liveness.jsonl"), "{}\n", "utf-8");
			fs.readFileSync(path.join(dir, "liveness.jsonl"), "utf-8");
			assert.equal(spy.readFileSyncCalls, 1, "instrument liveness: manual readFileSync must be counted");

			const cursor = readEventsCursor(eventsPath, { sinceSeq: 9950, limit: 50 });

			assert.deepEqual(cursor.events, expected, "cached result must equal the full-parse result");
			assert.equal(cursor.total, 50);
			assert.equal(cursor.nextSeq, 10_000);
			// Stamps unchanged → the ring answers without reading a single
			// event byte (the poll tick with no new events is now free).
			assert.equal(spy.readFileSyncCalls, 1, `cursor must not readFileSync (saw ${spy.readFileSyncCalls - 1} extra)`);
			assert.equal(spy.readSyncBytes, 0, `unchanged file must read 0 bytes, got ${spy.readSyncBytes}B`);
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("append growth takes the delta path: only the appended bytes are read", () => {
	const dir = tmpDir("pi-crew-cursor-delta-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		const fileSize = fs.statSync(eventsPath).size;
		// Prime the cache.
		readEventsCursor(eventsPath, { sinceSeq: 9900, limit: 50 });
		const appendedBytes = appendEvents(eventsPath, [10_001, 10_002, 10_003, 10_004, 10_005]);

		const expected = parseGroundTruth(eventsPath, 9900, 50);
		assert.equal(expected.length, 50, "ground truth must be seqs 9901..9950");

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: 9900, limit: 50 });
			assert.deepEqual(cursor.events, expected, "delta-path result must equal the full-parse result");
			assert.ok(spy.readSyncCalls > 0, "delta must be read via readSync");
			assert.equal(spy.readFileSyncCalls, 0, "delta path must never whole-file readFileSync");
			assert.ok(spy.readSyncBytes <= appendedBytes, `delta read must be <= ${appendedBytes}B of appends, got ${spy.readSyncBytes}B`);
			assert.ok(spy.readSyncBytes < fileSize, "delta read must be far below the whole file");
		} finally {
			spy.restore();
		}

		// A larger limit scales the ring bound, not the read: after another
		// append the delta still only covers the new bytes.
		const moreBytes = appendEvents(
			eventsPath,
			Array.from({ length: 50 }, (_, i) => 10_051 + i),
		);
		const expected2 = parseGroundTruth(eventsPath, 9000, 1000);
		assert.equal(expected2.length, 1000, "ground truth must be seqs 9001..10000");
		const spy2 = spyFsReads(dir);
		try {
			const cursor2 = readEventsCursor(eventsPath, { sinceSeq: 9000, limit: 1000 });
			assert.deepEqual(cursor2.events, expected2, "scaled-limit delta result must equal the full-parse result");
			assert.equal(spy2.readFileSyncCalls, 0);
			assert.ok(spy2.readSyncBytes <= moreBytes, `scaled delta must be <= ${moreBytes}B, got ${spy2.readSyncBytes}B`);
		} finally {
			spy2.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("file shrink forces a full re-read and stays exact", () => {
	const dir = tmpDir("pi-crew-cursor-shrink-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		readEventsCursor(eventsPath, { sinceSeq: 9900, limit: 50 });
		// Shrink: rewrite the file with only the first 500 events (e.g. a
		// compaction/rotation rewrite under the reader).
		fs.writeFileSync(eventsPath, Array.from({ length: 500 }, (_, i) => eventLine(i + 1)).join(""), "utf-8");
		const newSize = fs.statSync(eventsPath).size;
		const expected = parseGroundTruth(eventsPath, 100, 50);
		assert.equal(expected.length, 50, "ground truth must be seqs 101..150");

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: 100, limit: 50 });
			assert.deepEqual(cursor.events, expected, "post-shrink result must equal the new file's full parse");
			assert.ok(spy.readSyncBytes >= newSize, `shrink must trigger a full ${newSize}B re-read, got ${spy.readSyncBytes}B`);
			assert.equal(spy.readFileSyncCalls, 0);
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("reject: seq-less first delta line rebuilds from a full parse", () => {
	const dir = tmpDir("pi-crew-cursor-seqless-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		readEventsCursor(eventsPath, { sinceSeq: 9990, limit: 50 });
		// Append a line with no metadata.seq followed by a valid event: the
		// delta watermark check must reject and the full parse must keep the
		// valid appended event (the seq-less one is dropped by the filter).
		appendRawLines(eventsPath, [
			JSON.stringify({ type: "task.progress", runId: "r1", taskId: "noseq", message: "m" }),
			eventLine(10_001).trimEnd(),
		]);
		const expected = parseGroundTruth(eventsPath, 9990, 50);
		assert.equal(expected.length, 11, "ground truth must be seqs 9991..10001");
		assert.equal(expected.at(-1)?.metadata?.seq, 10_001, "the valid appended event must be visible");

		const cursor = readEventsCursor(eventsPath, { sinceSeq: 9990, limit: 50 });
		assert.deepEqual(cursor.events, expected, "seq-less delta must rebuild and stay exact");
		assert.equal(cursor.total, 11);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("reject: mid-delta seq violation (compaction-recovery re-append) rebuilds and stays exact", () => {
	const dir = tmpDir("pi-crew-cursor-violation-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		readEventsCursor(eventsPath, { sinceSeq: 900, limit: 10_000 });
		// Compaction-recovery shape: old seqs re-appended AFTER newer ones.
		// The delta check (first seq >= lastSeq, non-decreasing) must fail.
		appendEvents(eventsPath, [10_001, 900, 10_002]);
		const expected = parseGroundTruth(eventsPath, 899, 10_000);
		// File order is preserved: [.., 10000, 10001, 900, 10002] — the
		// re-appended 900 (seq > 899) must be visible, duplicate seq and all.
		assert.ok(
			expected.some((event, i) => event.metadata?.seq === 900 && i > 0),
			"re-appended 900 must be present",
		);
		assert.equal(expected.at(-1)?.metadata?.seq, 10_002);

		const cursor = readEventsCursor(eventsPath, { sinceSeq: 899, limit: 10_000 });
		assert.deepEqual(cursor.events, expected, "violating delta must rebuild from a full parse and stay exact");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("stale anchor (older than the ring's provable start) falls back to a full parse", () => {
	const dir = tmpDir("pi-crew-cursor-fallback-");
	try {
		// 12k events: the ring bound for limit=50 is 10000, so the cached ring
		// starts at seq 2001 and cannot prove coverage for sinceSeq=1000.
		const eventsPath = writeEventsFixture(dir, 12_000);
		const fileSize = fs.statSync(eventsPath).size;
		assert.ok(fileSize < 4 * 1024 * 1024, "fixture must fit the wide window so ground truth is exact");
		readEventsCursor(eventsPath, { sinceSeq: 11_000, limit: 50 }); // prime

		const expected = parseGroundTruth(eventsPath, 1000, 50);
		assert.equal(expected[0]?.metadata?.seq, 7001, "head cap returns the oldest events of the tail-capped window first");
		assert.equal(expected.length, 50);

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: 1000, limit: 50 });
			assert.deepEqual(cursor.events, expected, "stale-anchor result must equal the full-parse result");
			assert.ok(spy.readSyncBytes >= fileSize, `stale anchor must full-parse the ${fileSize}B file, got ${spy.readSyncBytes}B`);
			assert.equal(spy.readFileSyncCalls, 0, "no whole-file readFileSync (full parse uses readSync)");
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("limit without sinceSeq keeps the head-cap semantics via the wide window", () => {
	const dir = tmpDir("pi-crew-cursor-headcap-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		// limit is a HEAD cap applied AFTER the 5000-event tail cap and the
		// (empty) sinceSeq filter: the oldest 50 of the newest 5000 events,
		// i.e. seqs 5001..5050 here. The watermark cache must not be taken
		// (sinceSeq=0 can never prove ring coverage).
		const expected = parseGroundTruth(eventsPath, 0, 50);
		assert.equal(expected[0]?.metadata?.seq, 5001, "head cap must return the oldest events of the tail-capped window first");
		assert.equal(expected.length, 50);

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { limit: 50 });
			assert.deepEqual(cursor.events, expected, "limit-without-sinceSeq must keep exact head-cap semantics");
			assert.equal(spy.readFileSyncCalls, 0);
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("no-limit call still full-reads the file via the wide tail window", () => {
	const dir = tmpDir("pi-crew-cursor-nolimit-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		const fileSize = fs.statSync(eventsPath).size;
		const expected = parseGroundTruth(eventsPath, 0);

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath);
			// File < 4MB → the wide window reads the ENTIRE file, and the
			// 5000-event tail cap keeps the newest 5000 (seqs 5001..10000).
			assert.deepEqual(cursor.events, expected, "no-limit result must equal the full parse, tail-capped");
			assert.equal(cursor.events.length, 5000);
			assert.equal(cursor.events[0]?.metadata?.seq, 5001);
			assert.ok(spy.readSyncBytes >= fileSize, `no-limit must still read the whole ${fileSize}B file, got ${spy.readSyncBytes}B`);
			assert.equal(spy.readFileSyncCalls, 0, "no readFileSync on the events file");
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("repro (fix round 2): rewrite keeping the tail + regrow past the old size equals the full parse", () => {
	const dir = tmpDir("pi-crew-cursor-regrow-");
	try {
		const eventsPath = writeEventsFixture(dir, 10);
		const primedStat = fs.statSync(eventsPath);
		const primed = readEventsCursor(eventsPath, { sinceSeq: 5, limit: 100 });
		assert.deepEqual(
			primed.events.map((event) => event.metadata?.seq),
			[6, 7, 8, 9, 10],
			"priming read must see seqs 6..10",
		);

		// Same-path rewrite keeping [9,10] — the atomicWriteFile shape
		// (temp+rename, new inode), exactly what applyCompactionUnlocked does.
		rewriteViaAtomicRename(eventsPath, [9, 10]);
		assert.notEqual(fs.statSync(eventsPath).ino, primedStat.ino, "rewrite must produce a new inode");
		// Regrow past the primed size: the stamp-only delta check of the
		// previous round (size > previous.size && mtimeMs >= previous.mtimeMs)
		// passes from here on — the exact trap of the fix-round-2 Critical.
		appendEvents(eventsPath, Array.from({ length: 10 }, (_, i) => 11 + i));
		const regrownStat = fs.statSync(eventsPath);
		assert.ok(regrownStat.size > primedStat.size, `precondition: regrown size ${regrownStat.size} must exceed primed ${primedStat.size}`);
		assert.ok(regrownStat.mtimeMs >= primedStat.mtimeMs, "precondition: mtimeMs >= primed mtimeMs");

		const expected = parseGroundTruth(eventsPath, 5, 100);
		assert.deepEqual(
			expected.map((event) => event.metadata?.seq),
			[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
			"ground truth must be [9,10,11..20]",
		);

		const cursor = readEventsCursor(eventsPath, { sinceSeq: 5, limit: 100 });
		// The pre-inode-stamp code served [6,7,8,9,10,19,20] here — 8 events
		// permanently dropped, 3 deleted phantom events served.
		assert.deepEqual(
			cursor.events.map((event) => event.metadata?.seq),
			[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
			"rewrite+regrow must rebuild from a full parse, not read from the dead watermark offset",
		);
		assert.equal(cursor.total, 12);
		assert.equal(cursor.nextSeq, 20);

		// The rebuilt watermark keeps answering exactly on repeats.
		const again = readEventsCursor(eventsPath, { sinceSeq: 5, limit: 100 });
		assert.deepEqual(again.events, cursor.events, "repeat read after the rebuild must stay exact");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("inode change forces a full re-read even when size and mtimeMs are byte-identical", () => {
	const dir = tmpDir("pi-crew-cursor-inode-");
	try {
		const lineBytes = 200;
		const eventsPath = path.join(dir, "events.jsonl");
		fs.writeFileSync(
			eventsPath,
			[fixedLengthEventLine(1, lineBytes), fixedLengthEventLine(2, lineBytes), fixedLengthEventLine(3, lineBytes)].join(""),
			"utf-8",
		);
		// Pin mtime to a whole-second value on BOTH sides: utimesSync only
		// carries millisecond precision, so a sub-ms original timestamp
		// would not round-trip and the isolation precondition would be
		// unprovable.
		const pinnedTime = new Date(Math.floor(Date.now() / 1000) * 1000);
		fs.utimesSync(eventsPath, pinnedTime, pinnedTime);
		const primed = readEventsCursor(eventsPath, { sinceSeq: 1, limit: 10 });
		assert.deepEqual(
			primed.events.map((event) => event.metadata?.seq),
			[2, 3],
		);
		const primedStat = fs.statSync(eventsPath);

		// Same-size rewrite via the real rewriter shape (temp+rename): the
		// last event changes (seq 3 -> 14), the total byte size is IDENTICAL,
		// and utimesSync pins mtime back to the primed value — the ONLY
		// differing stamp is the inode. A stamps-only check takes the
		// unchanged branch and serves the stale ring [2,3]; inode identity
		// must rebuild instead.
		const tmp = `${eventsPath}.rewrite-tmp`;
		fs.writeFileSync(
			tmp,
			[fixedLengthEventLine(1, lineBytes), fixedLengthEventLine(2, lineBytes), fixedLengthEventLine(14, lineBytes)].join(""),
			"utf-8",
		);
		fs.renameSync(tmp, eventsPath);
		fs.utimesSync(eventsPath, pinnedTime, pinnedTime);
		const rewrittenStat = fs.statSync(eventsPath);
		assert.notEqual(rewrittenStat.ino, primedStat.ino, "temp+rename must produce a new inode");
		assert.equal(rewrittenStat.size, primedStat.size, "precondition: byte-identical size");
		assert.equal(rewrittenStat.mtimeMs, primedStat.mtimeMs, "precondition: identical mtimeMs (only the inode differs)");

		const cursor = readEventsCursor(eventsPath, { sinceSeq: 1, limit: 10 });
		assert.deepEqual(
			cursor.events.map((event) => event.metadata?.seq),
			[2, 14],
			"an inode swap with recycled size+mtime must be re-read, not served from the stale ring",
		);
		assert.equal(cursor.total, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("wide-path call drops the watermark entry (mixed call patterns cannot keep stale stamps)", () => {
	const dir = tmpDir("pi-crew-cursor-widedrop-");
	try {
		const eventsPath = writeEventsFixture(dir, 10_000);
		const fileSize = fs.statSync(eventsPath).size;
		readEventsCursor(eventsPath, { sinceSeq: 9900, limit: 50 }); // prime
		// A sinceSeq=0 / no-limit call bypasses the cache entirely — it must
		// DROP the entry rather than leave its stamps behind for later cached
		// calls (a rewrite landing between wide calls would otherwise keep
		// stale stamps alive until some cached call re-validated them).
		readEventsCursor(eventsPath);
		const appendedBytes = appendEvents(eventsPath, [10_001, 10_002]);

		const expected = parseGroundTruth(eventsPath, 9900, 50);
		assert.deepEqual(
			expected.map((event) => event.metadata?.seq),
			Array.from({ length: 50 }, (_, i) => 9901 + i),
		);

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: 9900, limit: 50 });
			assert.deepEqual(cursor.events, expected, "post-wide-call cached read must stay exact");
			// Entry dropped → the next cached read full-parses. Had the entry
			// survived the wide call, this would have been a delta-only read
			// of <= appendedBytes.
			assert.ok(
				spy.readSyncBytes >= fileSize,
				`dropped entry must force a full ${fileSize}B re-parse, got ${spy.readSyncBytes}B (delta would be <= ${appendedBytes}B)`,
			);
			assert.equal(spy.readFileSyncCalls, 0);
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
