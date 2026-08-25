/**
 * Perf round 2 / Task 6: readEventsCursor bounded-tail fast path.
 *
 * FIND-05 already replaced the full-file readFileSync+split+parse with a
 * fixed 4MB tail window. This task scales that window DOWN for streaming
 * callers that anchor with sinceSeq and cap with limit (run-event-bus
 * onWithReplay, broker events.since/events.subscribe): those reads only
 * need the post-sinceSeq region, so a limit-scaled lookback window
 * (>= 256KiB, limit * 512B/event, capped at 4MB) suffices whenever it
 * provably contains the whole post-sinceSeq region. When it cannot prove
 * that, the cursor falls back to the 4MB window and the result must stay
 * byte-identical to the previous behavior.
 *
 * `limit` semantics are a HEAD cap (oldest-first slice AFTER the sinceSeq
 * filter — see the PERF note in team-tool/status.ts), NOT a tail window,
 * so these tests pin exact equality against a full-file ground-truth parse
 * for every branch: fast path, scaled window, stale-anchor fallback, and
 * the plain head cap.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readEventsCursor, type TeamEvent } from "../../../../src/state/event-log/event-log.ts";

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

const TOTAL_EVENTS = 10_000;

/** ~230B lines → a ~2.3MB fixture: far above the bounded lookback windows,
 *  far below the 4MB wide window (so the wide read IS a full-file read and
 *  the ground truth below is exact for every branch). */
function writeEventsFixture(dir: string): string {
	const eventsPath = path.join(dir, "events.jsonl");
	const lines: string[] = [];
	for (let seq = 1; seq <= TOTAL_EVENTS; seq++) {
		lines.push(
			JSON.stringify({
				type: "task.progress",
				runId: "r1",
				taskId: `t${seq}`,
				message: "x".repeat(140),
				metadata: { seq, provenance: "test" },
			}),
		);
	}
	fs.writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");
	return eventsPath;
}

/** Ground truth: the pre-FIND-05 full parse with the exact readEventsCursor
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

test("bounded tail: sinceSeq+limit reads only the lookback window and matches the full parse", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cursor-bounded-"));
	try {
		const eventsPath = writeEventsFixture(dir);
		const fileSize = fs.statSync(eventsPath).size;
		assert.ok(fileSize > 512 * 1024, `fixture must exceed the bounded windows (got ${fileSize}B)`);
		assert.ok(fileSize < 4 * 1024 * 1024, "fixture must fit the 4MB wide window so ground truth is exact");
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

			// Exactness: same 50 events (seqs 9951..10000) as a full-file parse.
			assert.deepEqual(cursor.events, expected, "bounded-tail result must equal the full-parse result");
			assert.equal(cursor.events[0]?.metadata?.seq, 9951);
			assert.equal(cursor.events.at(-1)?.metadata?.seq, 10_000);
			assert.equal(cursor.total, 50);
			assert.equal(cursor.nextSeq, 10_000);
			// No full-file readFileSync, and only the 256KiB lookback window
			// (floor for limit=50: 50 * 512B = 25KiB < 256KiB) was read.
			assert.equal(spy.readFileSyncCalls, 1, `cursor must not readFileSync the events file (saw ${spy.readFileSyncCalls - 1} extra)`);
			assert.ok(spy.readSyncCalls > 0, "cursor must use readSync for the tail read");
			assert.ok(spy.readSyncBytes <= 256 * 1024, `bounded window must be <= 256KiB, got ${spy.readSyncBytes}B`);
			assert.ok(spy.readSyncBytes < fileSize, `bounded read must not cover the whole ${fileSize}B file`);
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bounded tail: window scales with the requested limit", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cursor-scaled-"));
	try {
		const eventsPath = writeEventsFixture(dir);
		const fileSize = fs.statSync(eventsPath).size;
		const expected = parseGroundTruth(eventsPath, 9000, 1000);
		assert.equal(expected.length, 1000, "ground truth must be seqs 9001..10000");

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: 9000, limit: 1000 });
			assert.deepEqual(cursor.events, expected, "scaled-window result must equal the full-parse result");
			// limit=1000 → 1000 * 512B = 500KiB window (> the 256KiB floor).
			assert.ok(spy.readSyncBytes <= 512_000, `scaled window must be <= 512000B, got ${spy.readSyncBytes}B`);
			assert.ok(spy.readSyncBytes < fileSize, "scaled read must not cover the whole file");
			assert.equal(spy.readFileSyncCalls, 0, "no readFileSync on the events file");
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bounded tail: stale anchor falls back to the wide window and stays exact", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cursor-fallback-"));
	try {
		const eventsPath = writeEventsFixture(dir);
		const fileSize = fs.statSync(eventsPath).size;
		// sinceSeq=5000 predates the 256KiB window start (~seq 8860), so the
		// window cannot prove coverage and the cursor must re-read wide.
		const expected = parseGroundTruth(eventsPath, 5000, 50);
		assert.equal(expected.length, 50, "ground truth must be seqs 5001..5050");

		const spy = spyFsReads(dir);
		try {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: 5000, limit: 50 });
			assert.deepEqual(cursor.events, expected, "fallback result must equal the full-parse result");
			assert.ok(spy.readSyncBytes >= fileSize, `stale anchor must fall back to a full ${fileSize}B read, got ${spy.readSyncBytes}B`);
			assert.equal(spy.readFileSyncCalls, 0, "fallback must still avoid readFileSync (4MB readSync window)");
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("limit without sinceSeq keeps the head-cap semantics via the wide window", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cursor-headcap-"));
	try {
		const eventsPath = writeEventsFixture(dir);
		// limit is a HEAD cap applied AFTER the 5000-event tail cap and the
		// (empty) sinceSeq filter: the oldest 50 of the newest 5000 events,
		// i.e. seqs 5001..5050 here. The bounded path must not be taken
		// (sinceSeq=0 can never prove window coverage, so no double read).
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
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cursor-nolimit-"));
	try {
		const eventsPath = writeEventsFixture(dir);
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
