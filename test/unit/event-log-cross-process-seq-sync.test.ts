/**
 * ST-5 (v0.9.56): cross-process event-sequence uniqueness — SYNC path.
 *
 * BUG: `reserveSequence` seeded the in-process `seqCounters` counter ONCE per
 * process (reading the `.seq` sidecar a single time) and then served every
 * subsequent call purely from that process-local counter. Two processes that
 * both seeded before either had persisted ended up sharing the same counter
 * base -> duplicate sequence numbers -> `sinceSeq` streaming readers silently
 * dropped the second event. The async path was already fixed via
 * `reserveSequenceUnderLock` (re-reads the sidecar every call); the sync and
 * buffered paths were NOT.
 *
 * FIX: `reserveSequence` now delegates to `reserveSequenceUnderLock`, which
 * re-reads the authoritative `.seq` sidecar on EVERY call and takes
 * `max(sidecar, inProcess)`. So a counter that lags behind a sidecar advanced
 * by another process can never assign a regressed (duplicate) seq.
 *
 * This test simulates "two processes" within a single test process:
 *   - The process under test uses the real locked sync append (`appendEvent`),
 *     exactly as production does (acquires `.mkdirlock`, reserves seq, appends,
 *     persists the sidecar, releases).
 *   - The "other process" is simulated by appending raw JSONL lines + writing
 *     the sidecar directly — which is precisely what a real concurrent process
 *     does once it has acquired and released its OWN lock. Crucially, this does
 *     NOT touch the under-test process's in-process `seqCounters`, reproducing
 *   the cross-process divergence that the old cached-counter logic caused.
 *
 * Run ONLY:
 *   env -u PI_CREW_KIND -u PI_CREW_RUN_ID timeout 120 \
 *     npx tsx --test test/unit/event-log-cross-process-seq-sync.test.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type AppendTeamEvent,
	appendEvent,
	__test__clearSeqCounters as clearSeqCounters,
	__test__clearSequenceCache as clearSequenceCache,
	readEvents,
	resetEventLogMode,
	scanSequence,
	sequencePath,
} from "../../src/state/event-log/event-log.ts";

const RUN_ID = "st5-cross-process";

function makeEvent(taskId: string): AppendTeamEvent {
	return { type: "task.progress", runId: RUN_ID, taskId, data: {} };
}

/** Append a finalized event line as a DIFFERENT process would: a bare
 *  `appendFileSync` of the JSONL line plus a `.seq` sidecar update, with no
 *  touch to the under-test process's in-memory counter. This faithfully models
 *  a concurrent process that held its own lock, wrote the event, persisted the
 *  sidecar, and released. */
function appendAsOtherProcess(eventsPath: string, ...seqs: number[]): void {
	const lines = seqs
		.map((seq) =>
			JSON.stringify({
				time: new Date().toISOString(),
				type: "task.progress",
				runId: RUN_ID,
				taskId: `foreign-${seq}`,
				metadata: { seq, provenance: "team_runner" },
			}),
		)
		.map((line) => `${line}\n`)
		.join("");
	fs.appendFileSync(eventsPath, lines, "utf-8");
	const last = seqs[seqs.length - 1];
	fs.writeFileSync(sequencePath(eventsPath), `${last}\n`, "utf-8");
}

describe("ST-5: cross-process seq uniqueness (sync locked append)", () => {
	let tmpDir: string;
	let eventsPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "st5-cross-process-seq-"));
		eventsPath = path.join(tmpDir, "events.jsonl");
		// Start every test from clean module state (fresh "process 1").
		clearSequenceCache();
		clearSeqCounters();
	});

	afterEach(() => {
		resetEventLogMode();
		clearSequenceCache();
		clearSeqCounters();
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("a fresh process (cleared module state) resumes from the persisted sidecar", () => {
		// Process 1 writes 3 events: seqs 1..3, sidecar -> 3.
		const r1 = appendEvent(eventsPath, makeEvent("p1-a"));
		const r2 = appendEvent(eventsPath, makeEvent("p1-b"));
		const r3 = appendEvent(eventsPath, makeEvent("p1-c"));
		assert.deepEqual([r1.metadata?.seq, r2.metadata?.seq, r3.metadata?.seq], [1, 2, 3]);
		assert.equal(scanSequence(eventsPath), 3, "file max seq is 3");
		assert.equal(
			Number.parseInt(fs.readFileSync(sequencePath(eventsPath), "utf-8").trim(), 10),
			3,
			"sidecar reflects last persisted seq",
		);

		// Simulate a NEW process: wipe the in-process counter + stat cache so the
		// next append seeds fresh from disk (process restart). The new process
		// must continue at 4, NOT restart at 1.
		clearSequenceCache();
		clearSeqCounters();

		const r4 = appendEvent(eventsPath, makeEvent("p2-a"));
		const r5 = appendEvent(eventsPath, makeEvent("p2-b"));
		assert.deepEqual([r4.metadata?.seq, r5.metadata?.seq], [4, 5], "fresh process resumes from sidecar, not from 1");

		// Every seq on disk is unique and contiguous 1..5.
		const seqs = readEvents(eventsPath)
			.map((e) => e.metadata?.seq ?? 0)
			.sort((a, b) => a - b);
		assert.deepEqual(seqs, [1, 2, 3, 4, 5], "all seqs unique and contiguous");
	});

	it("a long-lived process re-reads the sidecar after another process advanced it (core ST-5)", () => {
		// Process 1 (long-lived): append 3 events. in-process counter -> 3,
		// sidecar -> 3. With the OLD cached-counter logic this counter is now
		// FROZEN at 3 and never re-reads the sidecar.
		appendEvent(eventsPath, makeEvent("p1-a")); // seq 1
		appendEvent(eventsPath, makeEvent("p1-b")); // seq 2
		appendEvent(eventsPath, makeEvent("p1-c")); // seq 3

		// A SECOND process appends events with much higher seqs and persists the
		// sidecar to 102 — without touching process 1's in-process counter.
		appendAsOtherProcess(eventsPath, 100, 101, 102);
		assert.equal(scanSequence(eventsPath), 102, "foreign process advanced file max to 102");
		assert.equal(
			Number.parseInt(fs.readFileSync(sequencePath(eventsPath), "utf-8").trim(), 10),
			102,
			"foreign process advanced sidecar to 102",
		);

		// Process 1 is STILL ALIVE with its stale in-process counter = 3. Its next
		// sync append must re-read the sidecar (102) and assign 103 — NOT 4.
		//   OLD (bug): counter=3 -> returns 4   (regressed, collides with future writes)
		//   NEW (fix): max(sidecar=102, counter=3)=102 -> returns 103
		const ev = appendEvent(eventsPath, makeEvent("p1-d"));
		assert.equal(ev.metadata?.seq, 103, "sync append must re-read the sidecar; a stale in-process counter must not regress the seq");

		// No duplicate seqs across both processes.
		const seqs = readEvents(eventsPath).map((e) => e.metadata?.seq ?? 0);
		assert.equal(new Set(seqs).size, seqs.length, `duplicate seqs found: ${seqs.join(", ")}`);
		// Process 1's latest seq is the global maximum.
		assert.equal(ev.metadata?.seq, Math.max(...seqs), "newly assigned seq must be the global max");
	});

	it("an interleaved two-process workload yields globally unique, monotonically increasing seqs", () => {
		const assignedByP1: number[] = [];

		// P1 batch 1.
		assignedByP1.push(appendEvent(eventsPath, makeEvent("p1-1")).metadata?.seq ?? 0); // 1
		assignedByP1.push(appendEvent(eventsPath, makeEvent("p1-2")).metadata?.seq ?? 0); // 2
		assignedByP1.push(appendEvent(eventsPath, makeEvent("p1-3")).metadata?.seq ?? 0); // 3

		// P2 batch 1: foreign writes seqs 50,51 -> sidecar 51.
		appendAsOtherProcess(eventsPath, 50, 51);

		// P1 batch 2: must jump above 51 (-> 52), not reuse its stale counter (4).
		assignedByP1.push(appendEvent(eventsPath, makeEvent("p1-4")).metadata?.seq ?? 0); // 52
		assert.ok(assignedByP1[3]! > 51, `P1's 4th seq must exceed the foreign sidecar (51); got ${assignedByP1[3]}`);

		// P2 batch 2: foreign write seq 200 -> sidecar 200.
		appendAsOtherProcess(eventsPath, 200);

		// P1 batch 3: must jump above 200 (-> 201).
		assignedByP1.push(appendEvent(eventsPath, makeEvent("p1-5")).metadata?.seq ?? 0); // 201
		assert.ok(assignedByP1[4]! > 200, `P1's 5th seq must exceed the foreign sidecar (200); got ${assignedByP1[4]}`);

		// P1's own seqs are strictly increasing.
		for (let i = 1; i < assignedByP1.length; i++) {
			assert.ok(assignedByP1[i]! > assignedByP1[i - 1]!, "P1 seqs must be strictly increasing");
		}

		// Every seq in the file is unique.
		const allSeqs = readEvents(eventsPath).map((e) => e.metadata?.seq ?? 0);
		assert.equal(new Set(allSeqs).size, allSeqs.length, `global duplicate seqs found: ${allSeqs.join(", ")}`);
		// The file's max equals P1's last assignment (201).
		assert.equal(scanSequence(eventsPath), assignedByP1[assignedByP1.length - 1]);
		// Sidecar agrees with the file max.
		assert.equal(
			Number.parseInt(fs.readFileSync(sequencePath(eventsPath), "utf-8").trim(), 10),
			scanSequence(eventsPath),
			"sidecar must agree with the file's max seq",
		);
	});
});
