import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compactPreparedEventLog, prepareCompaction } from "../../../../src/state/event-log/event-log-rotation.ts";

/**
 * US-001 (2026-09-22) — AC-1: the read→write race that the lock-scope reduction
 * creates, tested DETERMINISTICALLY.
 *
 * prepareCompaction now reads outside the lock, so another process can append
 * between the read and the locked write. A timing-based test cannot hit that
 * window reliably (spawning a child takes ~50 ms, longer than the whole
 * compaction), and a mutant that dropped the tail-splice survived it. So the
 * race is reproduced by hand: prepare → append to the file → locked write.
 *
 * Mutation: drop the tail splice in compactPreparedEventLog → the appended
 * events vanish → RED.
 */

test("US-001: events appended between prepare and the locked write survive", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us001-race-"));
	const eventsPath = path.join(cwd, "events.jsonl");
	try {
		// Seed a log well over the compaction threshold.
		const fd = fs.openSync(eventsPath, "w");
		for (let i = 0; i < 500; i += 1) {
			fs.writeSync(
				fd,
				`${JSON.stringify({
					time: new Date(1700000000000 + i).toISOString(),
					type: "task.progress",
					runId: "team_us001_race",
					message: `seed ${i}`,
					metadata: { seq: i },
				})}\n`,
			);
		}
		fs.closeSync(fd);

		// Phase 1: prepare (unlocked read) — captures the snapshot.
		const prepared = prepareCompaction(eventsPath, { maxFileSizeBytes: 1, compactToCount: 50 });
		assert.ok(prepared, "fixture must be over the threshold");

		// Phase 2: another process appends AFTER our read — the exact window.
		fs.appendFileSync(
			eventsPath,
			`${JSON.stringify({
				time: new Date(1700000009999).toISOString(),
				type: "task.progress",
				runId: "team_us001_race",
				message: "late-arrival-1",
				metadata: { seq: 5000 },
			})}\n${JSON.stringify({
				time: new Date(1700000010000).toISOString(),
				type: "task.progress",
				runId: "team_us001_race",
				message: "late-arrival-2",
				metadata: { seq: 5001 },
			})}\n`,
		);

		// Phase 3: the locked write — must splice the late arrivals back.
		const result = compactPreparedEventLog(eventsPath, prepared);
		assert.ok(result, "compaction must produce a result");

		const content = fs.readFileSync(eventsPath, "utf-8");
		assert.ok(content.includes("late-arrival-1"), "the first late event must survive the locked write");
		assert.ok(content.includes("late-arrival-2"), "the second late event must survive the locked write");
		// The file must stay valid JSONL.
		for (const line of content.split("\n").filter((l) => l.trim())) {
			assert.doesNotThrow(() => JSON.parse(line), `valid JSONL: ${line.slice(0, 80)}`);
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("US-001: no tail appended → no spurious duplication", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "us001-race-"));
	const eventsPath = path.join(cwd, "events.jsonl");
	try {
		const fd = fs.openSync(eventsPath, "w");
		for (let i = 0; i < 300; i += 1) {
			fs.writeSync(
				fd,
				`${JSON.stringify({ time: new Date(1700000000000 + i).toISOString(), type: "task.progress", runId: "r", message: `s${i}`, metadata: { seq: i } })}\n`,
			);
		}
		fs.closeSync(fd);

		const prepared = prepareCompaction(eventsPath, { maxFileSizeBytes: 1, compactToCount: 20 });
		assert.ok(prepared);
		compactPreparedEventLog(eventsPath, prepared);
		const after = fs
			.readFileSync(eventsPath, "utf-8")
			.split("\n")
			.filter((l) => l.trim()).length;
		// Kept window ~20; without a tail, no duplicates are added.
		assert.ok(after <= 25, `no spurious duplication expected, got ${after} lines`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
