/**
 * R16-B1 / R17-S1 / R18 regression tests (Phase 3.6/3.7/3.8).
 *
 * Covers:
 *  (a) seq uniqueness under concurrent sync+async appends + `.seqlock` hygiene
 *      (lock dir released, sidecar advanced).
 *  (b) W2 archive-tail reads: events stranded into an archive by a rotation
 *      (in-flight fd append on the renamed inode) are recovered by readEvents
 *      and readEventsCursor (default tail path AND byte-offset path with a
 *      detected .gen generation bump).
 *  (c) R17-S1: size-limit skip now SIGNALS — severity "error" logs (not
 *      PI_TEAMS_DEBUG-gated), a `skippedDueToSize: true` indicator on the
 *      returned event, emitFromTeamEvent gated, and the rotation-failure
 *      boolean checked (event-log.rotate-failed / event-log.rotate).
 *
 * Deterministic rotation-failure trick (c): the archive path is
 * `<eventsPath>.<isoTimestamp>.archive.jsonl` — a live-file basename of ~230
 * chars keeps every lock/sidecar path under the 255-byte NAME_MAX while the
 * archive rename overflows it → renameSync fails ENAMETOOLONG →
 * rotateEventLogUnlocked returns false → the size check still sees the
 * oversized file → skip. Skipped on win32 (path limits differ).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type AppendTeamEvent,
	appendEvent,
	appendEventAsync,
	readEvents,
	readEventsCursor,
} from "../../../../src/state/event-log/event-log.ts";
import { currentGeneration, rotateEventLogUnlocked } from "../../../../src/state/event-log/event-log-rotation.ts";
import { runEventBus } from "../../../../src/ui/run-event-bus.ts";

function makeEvent(runId: string, taskId: string): AppendTeamEvent {
	return { type: "task.progress", runId, taskId, data: {} };
}

/** Stub console.error (logInternalError's sink for "error" severity) and
 *  collect the emitted lines. */
function spyConsoleError(): { lines: string[]; restore: () => void } {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((a) => String(a)).join(" "));
	};
	return { lines, restore: () => (console.error = original) };
}

describe("R16-B1: .seqlock reservation (W1)", () => {
	let tmpDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r16-seqlock-"));
		eventsPath = path.join(tmpDir, "events.jsonl");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("concurrent sync+async appends produce unique seqs and release the .seqlock", async () => {
		const N = 30;
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < N; i++) {
			if (i % 2 === 0) {
				appendEvent(eventsPath, makeEvent("r16", `sync-${i}`));
			} else {
				promises.push(appendEventAsync(eventsPath, makeEvent("r16", `async-${i}`)));
			}
		}
		await Promise.all(promises);

		const events = readEvents(eventsPath);
		assert.equal(events.length, N, `expected ${N} events, got ${events.length}`);
		const seqs = events.map((e) => e.metadata?.seq ?? 0);
		assert.equal(new Set(seqs).size, seqs.length, `duplicate seqs found: ${seqs.join(", ")}`);

		// .seqlock hygiene: both the sync (withSeqLock) and async
		// (withSeqLockAsync) acquire wrappers must release the lock dir.
		assert.equal(fs.existsSync(`${eventsPath}.seqlock`), false, ".seqlock must be released after appends");
		// Sidecar advanced (advance-on-reserve persists inside the .seqlock).
		assert.equal(fs.readFileSync(`${eventsPath}.seq`, "utf-8").trim(), String(N));
	});
});

describe("W2: archive-tail readers recover rotation-stranded events (R16-B1 effect 2 / R18)", () => {
	let tmpDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r18-strand-"));
		eventsPath = path.join(tmpDir, "events.jsonl");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Build the stranding scenario: seqs 1..5 in the live file, then a
	 *  rotation during which an in-flight fd append (seq 6) lands in the
	 *  archive, then a post-rotation live append (seq 7). */
	function buildStranded(): void {
		for (let i = 1; i <= 5; i++) appendEvent(eventsPath, makeEvent("r18", `pre-${i}`));
		const fd = fs.openSync(eventsPath, "a");
		assert.equal(rotateEventLogUnlocked(eventsPath), true);
		fs.writeSync(
			fd,
			`${JSON.stringify({ time: new Date().toISOString(), type: "task.progress", runId: "r18", metadata: { seq: 6, provenance: "test" as const } })}\n`,
		);
		fs.closeSync(fd);
		// The in-flight writer is modeled as a foreign process: it advanced the
		// sidecar to 6 when it reserved its seq (R16 advance-on-reserve), so the
		// next live append reserves 7 — no collision with the stranded event.
		fs.writeFileSync(`${eventsPath}.seq`, "6\n", "utf-8");
		appendEvent(eventsPath, makeEvent("r18", "post"));
	}

	it("readEvents merges archive content (full history, dedup by seq)", () => {
		buildStranded();
		const events = readEvents(eventsPath);
		const seqs = events.map((e) => e.metadata?.seq ?? 0);
		assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7], `stranded event must be recovered; got ${seqs.join(",")}`);
	});

	it("readEventsCursor (default tail path) delivers the stranded event to a sinceSeq stream", () => {
		buildStranded();
		const cursor = readEventsCursor(eventsPath, { sinceSeq: 4 });
		const seqs = cursor.events.map((e) => e.metadata?.seq ?? 0);
		assert.deepEqual(seqs, [5, 6, 7], `cursor must drain the archive tail; got ${seqs.join(",")}`);
	});

	it("readEventsCursor (byte-offset path) drains the archive tail on a detected generation bump (R-03)", () => {
		for (let i = 1; i <= 5; i++) appendEvent(eventsPath, makeEvent("r18b", `pre-${i}`));
		// First streaming read: captures generation g0 and the byte offset.
		const read1 = readEventsCursor(eventsPath, { fromByteOffset: 0, sinceSeq: 0 });
		assert.equal(read1.events.length, 5);
		const g0 = read1.generation ?? currentGeneration(eventsPath);

		// Rotation with an in-flight stranded append (seq 6) + a live append (seq 7).
		const fd = fs.openSync(eventsPath, "a");
		assert.equal(rotateEventLogUnlocked(eventsPath), true);
		fs.writeSync(
			fd,
			`${JSON.stringify({ time: new Date().toISOString(), type: "task.progress", runId: "r18b", metadata: { seq: 6, provenance: "test" as const } })}\n`,
		);
		fs.closeSync(fd);
		// Foreign stranded writer advanced the sidecar to 6 → live append gets 7.
		fs.writeFileSync(`${eventsPath}.seq`, "6\n", "utf-8");
		appendEvent(eventsPath, makeEvent("r18b", "post"));

		// Second read echoes the stale generation → cursor must drain the
		// archive tail (seq 6) ahead of the fresh live file (seq 7).
		const read2 = readEventsCursor(eventsPath, {
			fromByteOffset: read1.nextByteOffset,
			sinceSeq: read1.nextSeq,
			generation: g0,
		});
		const seqs = read2.events.map((e) => e.metadata?.seq ?? 0);
		assert.deepEqual(seqs, [6, 7], `stale-cursor read must recover the stranded event; got ${seqs.join(",")}`);
		assert.notEqual(read2.generation, g0, "generation must have bumped after rotation");
	});
});

describe("R17-S1: size-limit skip signals (W3)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "r17-size-"));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	/** Build an eventsPath whose ARCHIVE rename deterministically fails: a
	 *  ~230-char basename keeps lock/sidecar names under NAME_MAX while
	 *  `<name>.<isoTimestamp>.archive.jsonl` overflows it (ENAMETOOLONG). The
	 *  live file is >50MB of newline-bounded padding lines (newlines keep the
	 *  line-streaming readers linear — a single giant unparseable line would
	 *  hit O(n²) leftover-concat in forEachLineSync) so the non-terminal append
	 *  overflows MAX_EVENTS_BYTES and compaction cannot shrink it (0 valid
	 *  events ≤ compactToCount → prepareCompaction returns undefined). */
	function buildOversizedEventsFile(): { eventsPath: string; sizeBefore: number } {
		const eventsPath = path.join(tmpDir, `${"e".repeat(230)}`);
		const fd = fs.openSync(eventsPath, "w");
		const line = Buffer.concat([Buffer.alloc(8191, 0x61), Buffer.from("\n")]);
		for (let i = 0; i < 6401; i++) fs.writeSync(fd, line); // ~52.4 MB > 50 MB
		fs.closeSync(fd);
		return { eventsPath, sizeBefore: fs.statSync(eventsPath).size };
	}

	it("sync path: returns skippedDueToSize indicator + severity-error logs (rotation failure surfaced)", {
		skip: process.platform === "win32",
	}, () => {
		const { eventsPath, sizeBefore } = buildOversizedEventsFile();
		const spy = spyConsoleError();
		try {
			const result = appendEvent(eventsPath, makeEvent("r17", "skip-me"));
			assert.equal(result.metadata?.skippedDueToSize, true, "returned event must carry the skip indicator");
			assert.equal(result.metadata?.seq, 1, "seq is still reserved (gap-not-dup advance-on-reserve)");
			const scopes = spy.lines.map((l) => (l.match(/\[pi-crew:([^\]]+)\]/) ?? [])[1] ?? "");
			assert.ok(scopes.includes("event-log.rotate"), `rotation failure must log event-log.rotate; got: ${scopes.join(",")}`);
			assert.ok(
				scopes.includes("event-log.rotate-failed"),
				`ignored rotation boolean must now surface event-log.rotate-failed; got: ${scopes.join(",")}`,
			);
			assert.ok(scopes.includes("event-log.size-limit"), `size-limit drop must log event-log.size-limit; got: ${scopes.join(",")}`);
			// The event was NOT appended (file is still the oversized padding blob).
			assert.equal(fs.statSync(eventsPath).size, sizeBefore, "skipped event must not be appended");
		} finally {
			spy.restore();
		}
	});

	it("async path: resolves with the skip indicator + severity-error logs", { skip: process.platform === "win32" }, async () => {
		const { eventsPath } = buildOversizedEventsFile();
		const spy = spyConsoleError();
		try {
			const result = await appendEventAsync(eventsPath, makeEvent("r17", "skip-me-async"));
			assert.equal(
				result.metadata?.skippedDueToSize,
				true,
				"async path must resolve with the skip indicator (no as-if-persisted success)",
			);
			const scopes = spy.lines.map((l) => (l.match(/\[pi-crew:([^\]]+)\]/) ?? [])[1] ?? "");
			assert.ok(scopes.includes("event-log.size-limit"), `size-limit drop must log; got: ${scopes.join(",")}`);
			assert.ok(scopes.includes("event-log.rotate-failed"), `rotation boolean must be checked; got: ${scopes.join(",")}`);
		} finally {
			spy.restore();
		}
	});

	it("emitFromTeamEvent is gated: a skipped event never reaches the run-event-bus", { skip: process.platform === "win32" }, async () => {
		const received: string[] = [];
		const unsubscribe = runEventBus.onAny((event) => received.push(event.type));
		try {
			// Control: a persisted event IS emitted (task.progress → mailbox_updated).
			const controlDir = fs.mkdtempSync(path.join(os.tmpdir(), "r17-ctl-"));
			const controlPath = path.join(controlDir, "events.jsonl");
			try {
				appendEvent(controlPath, makeEvent("r17-ctl", "ok"));
				await new Promise((resolve) => setTimeout(resolve, 20)); // bus flushes via microtask
				assert.ok(received.length > 0, "control: a persisted task.progress must reach the bus");

				// Skipped event: must NOT be emitted.
				received.length = 0;
				const { eventsPath } = buildOversizedEventsFile();
				const spy = spyConsoleError();
				try {
					const result = appendEvent(eventsPath, makeEvent("r17-ctl", "skip-me"));
					assert.equal(result.metadata?.skippedDueToSize, true);
				} finally {
					spy.restore();
				}
				await new Promise((resolve) => setTimeout(resolve, 20));
				assert.equal(received.length, 0, "a skipped (non-persisted) event must NOT be emitted to the bus");
			} finally {
				fs.rmSync(controlDir, { recursive: true, force: true });
			}
		} finally {
			unsubscribe();
		}
	});

	it("rotateEventLogUnlocked failure logs at severity error (checked boolean chain)", { skip: process.platform === "win32" }, () => {
		const { eventsPath } = buildOversizedEventsFile();
		const spy = spyConsoleError();
		try {
			assert.equal(rotateEventLogUnlocked(eventsPath), false, "rotation must fail on the over-long archive path");
			assert.ok(
				spy.lines.some((l) => l.includes("[pi-crew:event-log.rotate]")),
				"rotation failure must log event-log.rotate at error severity (ungated)",
			);
		} finally {
			spy.restore();
		}
	});
});
