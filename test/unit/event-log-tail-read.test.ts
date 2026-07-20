/**
 * FIND-05 regression test: readEventsCursor called WITHOUT fromByteOffset
 * must do a byte-level tail read (4MB) instead of a full-file read+parse.
 *
 * The legacy behavior did `fs.readFileSync(path, "utf-8")` then
 * `.split("\n")` then `JSON.parse` per line — O(total events) CPU and
 * memory. The fix bounds CPU to O(tail bytes) by reading the last 4MB
 * of the file via openSync + readSync and only parsing those lines.
 *
 * Test strategy:
 *   1. Write a JSONL log with 6000 events (well above the 5000 cap).
 *   2. Call readEventsCursor() with NO options (default path).
 *   3. Assert: returns at most 5000 events (the cap is preserved).
 *   4. Assert: those 5000 are the MOST RECENT (not the oldest).
 *   5. Assert: the underlying readJsonlTail() did NOT read the entire
 *      file (verified by spying on fs.readSync — the legacy path used
 *      readFileSync which reads the whole file in one shot; the tail
 *      path uses readSync with a smaller byte budget).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { readEventsCursor, type TeamEvent } from "../../src/state/event-log.ts";
import { readJsonlTail } from "../../src/utils/incremental-reader.ts";

/**
 * Spy on fs.readFileSync + fs.readSync to verify the tail path was used.
 * Returns call counts and a restore function. The spy is installed by
 * mutating the default-export view of node:fs (named exports are
 * read-only on the ESM namespace) and refreshing via
 * syncBuiltinESMExports().
 */
function spyFsReads(): { stats: { readFileSyncCalls: number; readSyncCalls: number; readSyncBytes: number }; restore: () => void } {
	const fsDefault = (fs as unknown as { default?: typeof fs }).default ?? (fs as unknown as typeof fs);
	const origReadFile = (fsDefault as { readFileSync: typeof fs.readFileSync }).readFileSync;
	const origRead = (fsDefault as { readSync: typeof fs.readSync }).readSync;
	const stats = { readFileSyncCalls: 0, readSyncCalls: 0, readSyncBytes: 0 };
	const wrappedReadFile = ((target: fs.PathLike, ...rest: unknown[]) => {
		try {
			const resolved = path.resolve(typeof target === "string" ? target : target.toString());
			if (resolved.endsWith(".jsonl")) {
				stats.readFileSyncCalls++;
			}
		} catch {
			/* ignore */
		}
		return (origReadFile as (...a: unknown[]) => string | Buffer).call(fsDefault, target, ...rest);
	}) as typeof fs.readFileSync;
	const wrappedRead = ((fd: number, buf: Buffer | NodeJS.ArrayBufferView, ...rest: unknown[]) => {
		// Signature: fs.readSync(fd, buffer, offset, length, position)
		// After the spread, rest[0]=offset, rest[1]=length, rest[2]=position.
		try {
			const lengthArg = rest[1] as number | undefined;
			if (typeof lengthArg === "number" && lengthArg > 0) {
				stats.readSyncCalls++;
				stats.readSyncBytes += lengthArg;
			}
		} catch {
			/* ignore */
		}
		return (origRead as (...a: unknown[]) => number).call(fsDefault, fd, buf, ...rest);
	}) as typeof fs.readSync;
	(fsDefault as { readFileSync: typeof fs.readFileSync }).readFileSync = wrappedReadFile;
	(fsDefault as { readSync: typeof fs.readSync }).readSync = wrappedRead;
	syncBuiltinESMExports();
	return {
		stats,
		restore: () => {
			(fsDefault as { readFileSync: typeof fs.readFileSync }).readFileSync = origReadFile;
			(fsDefault as { readSync: typeof fs.readSync }).readSync = origRead;
			syncBuiltinESMExports();
		},
	};
}

function captureInternalErrors(): { calls: string[]; restore: () => void } {
	const previousDebug = process.env.PI_TEAMS_DEBUG;
	const originalConsoleError = console.error;
	const calls: string[] = [];
	process.env.PI_TEAMS_DEBUG = "1";
	console.error = (...args: unknown[]) => {
		calls.push(args.map(String).join(" "));
	};
	return {
		calls,
		restore: () => {
			console.error = originalConsoleError;
			if (previousDebug === undefined) {
				delete process.env.PI_TEAMS_DEBUG;
			} else {
				process.env.PI_TEAMS_DEBUG = previousDebug;
			}
		},
	};
}

test("readEventsCursor default path uses tail-read (no full-file readFileSync)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tail-read-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		// 6000 events — comfortably above the 5000-event cap. Each event
		// is a tiny JSON object so the total file is small enough that the
		// legacy full-read would not be a problem at this scale, but the
		// test exercises the same code path that matters for large logs.
		const total = 6000;
		const lines: string[] = [];
		for (let i = 0; i < total; i++) {
			lines.push(
				JSON.stringify({
					type: "task.progress",
					runId: "r1",
					taskId: `t${i}`,
					metadata: { seq: i + 1, provenance: "test" },
				}),
			);
		}
		fs.writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");

		const spy = spyFsReads();
		try {
			const cursor = readEventsCursor(eventsPath);
			spy.restore();
			// 5000-event cap preserved.
			assert.equal(cursor.events.length, 5000, "default path must cap at 5000 events");
			// The 5000 returned must be the MOST RECENT: seqs 1001..6000.
			const firstSeq = cursor.events[0]?.metadata?.seq ?? 0;
			const lastSeq = cursor.events.at(-1)?.metadata?.seq ?? 0;
			assert.equal(firstSeq, 1001, `oldest returned event must be seq 1001 (got ${firstSeq})`);
			assert.equal(lastSeq, 6000, `newest returned event must be seq 6000 (got ${lastSeq})`);
			// The tail-read must NOT have used readFileSync on the events
			// file (the legacy full-parse path). It SHOULD have used
			// readSync (the tail path).
			assert.equal(
				spy.stats.readFileSyncCalls,
				0,
				`readEventsCursor default path must NOT use readFileSync on the events file (used ${spy.stats.readFileSyncCalls} times)`,
			);
			assert.ok(
				spy.stats.readSyncCalls > 0,
				`readEventsCursor default path MUST use readSync for the tail read (used ${spy.stats.readSyncCalls} times)`,
			);
			// Total bytes read via readSync must be <= 4MB (the tail budget).
			assert.ok(
				spy.stats.readSyncBytes <= 4 * 1024 * 1024,
				`readSync bytes must be <= 4MB tail budget; got ${spy.stats.readSyncBytes}`,
			);
		} finally {
			spy.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readEventsCursor reports a truncated multi-MB tail and returns the newest contiguous events", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tail-truncated-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const total = 6000;
		const message = "é".repeat(400); // 400 characters, 800 UTF-8 bytes.
		const lines: string[] = [];
		for (let i = 1; i <= total; i++) {
			lines.push(
				JSON.stringify({
					type: "task.progress",
					runId: "r1",
					taskId: `t${i}`,
					message,
					metadata: { seq: i, provenance: "test" },
				}),
			);
		}
		fs.writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");
		assert.ok(fs.statSync(eventsPath).size > 4 * 1024 * 1024, "fixture must exceed the 4MB tail budget");

		const tail = readJsonlTail<TeamEvent>(eventsPath, 4 * 1024 * 1024);
		assert.equal(tail.truncated, true, "multi-MB fixture must report a dropped prefix");
		const expected = tail.items.slice(-5000);
		assert.ok(expected.length > 0, "4MB tail should contain complete events");

		const captured = captureInternalErrors();
		try {
			const cursor = readEventsCursor(eventsPath);
			assert.equal(cursor.events.length, expected.length, "cursor must return the complete parsed 4MB tail");
			assert.equal(
				cursor.events[0]?.metadata?.seq,
				expected[0]?.metadata?.seq,
				"oldest returned seq must match the first complete event in the 4MB tail",
			);
			assert.equal(cursor.events.at(-1)?.metadata?.seq, total, "newest returned event must be seq 6000");
			const truncationCall = captured.calls.find((call) => call.includes("[pi-crew:event-log.cursor-tail-truncated]"));
			assert.ok(truncationCall, `expected event-log.cursor-tail-truncated warning; got ${captured.calls.join(" | ")}`);
			// The eventsPath value is JSON-stringified inside the warning; on
			// Windows the path's backslashes are escaped (\ -> \\). Match the
			// escaped form so the assertion is cross-platform.
			const escapedPath = eventsPath.replace(/\\/g, "\\\\");
			assert.ok(truncationCall.includes(`"eventsPath":"${escapedPath}"`), "warning must identify the truncated log");
			assert.ok(truncationCall.includes('"tailBytes":4194304'), "warning must report the 4MB tail budget");
		} finally {
			captured.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readEventsCursor default path returns all events without a truncation warning when the file fits", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tail-order-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const lines: string[] = [];
		for (let i = 1; i <= 200; i++) {
			lines.push(
				JSON.stringify({
					type: "task.progress",
					runId: "r1",
					taskId: `t${i}`,
					message: "x".repeat(100),
					metadata: { seq: i, provenance: "test" },
				}),
			);
		}
		fs.writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");

		const tail = readJsonlTail<TeamEvent>(eventsPath, 4 * 1024 * 1024);
		assert.equal(tail.truncated, false, "small fixture must fit within the 4MB tail budget");

		const captured = captureInternalErrors();
		try {
			const cursor = readEventsCursor(eventsPath);
			assert.equal(cursor.events.length, 200, "all 200 events returned when file fits in tail budget");
			assert.equal(cursor.events[0]?.metadata?.seq, 1, "first is the oldest in file order");
			assert.equal(cursor.events.at(-1)?.metadata?.seq, 200, "last is the newest in file order");
			assert.equal(
				captured.calls.some((call) => call.includes("event-log.cursor-tail-truncated")),
				false,
				"a non-truncated tail must not emit the truncation warning",
			);
		} finally {
			captured.restore();
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("readEventsCursor with sinceSeq filters out older events after the tail read", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-tail-sinceseq-"));
	const eventsPath = path.join(dir, "events.jsonl");
	try {
		const lines: string[] = [];
		for (let i = 1; i <= 6000; i++) {
			lines.push(
				JSON.stringify({
					type: "task.progress",
					runId: "r1",
					taskId: `t${i}`,
					metadata: { seq: i, provenance: "test" },
				}),
			);
		}
		fs.writeFileSync(eventsPath, lines.join("\n") + "\n", "utf-8");

		// sinceSeq=5500 → filter to seqs 5501..6000 (500 events).
		const cursor = readEventsCursor(eventsPath, { sinceSeq: 5500 });
		assert.equal(cursor.events.length, 500, "sinceSeq=5500 returns 500 events");
		assert.equal(cursor.events[0]?.metadata?.seq, 5501);
		assert.equal(cursor.events.at(-1)?.metadata?.seq, 6000);
		assert.equal(cursor.total, 500);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
