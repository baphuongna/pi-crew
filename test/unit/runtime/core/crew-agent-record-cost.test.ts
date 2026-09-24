/**
 * RR-017 / F06 + F07 — persistence + retrieval cost of crew-agent records.
 *
 * F06 (write path): `upsertCrewAgent` used to force a durable `agents.json`
 * rewrite on EVERY call, because it reads first and the read path called
 * `flushPendingAtomicWrites(agentsPath)` — a scoped flush that is NOT a no-op
 * when an entry is pending. Measured before the fix (strace -f -e trace=rename):
 *   20 progress upserts → 19 `agents.json` renames before the drain + 1 at drain.
 * And `saveCrewAgents` wrote EVERY record's status.json with no dirty tracking:
 *   updating 1 of 4 `completed` records → 6 renames / 12 fsyncs, the target
 *   status written TWICE.
 *
 * F07 (read path): `readCrewAgentEventsCursor` read the WHOLE file, split,
 * parsed every line, and only then applied `sinceSeq`/`limit`. Measured on a
 * 10000-event / 1127788-byte file: 1127788 bytes per IDLE poll (the story's
 * probe measured 697788 bytes on its slightly shorter fixture — same linear
 * behavior), with the inline panel polling every 700 ms.
 *
 * Assertions here are STRUCTURAL (byte counters + write counters), never
 * wall-clock timing. `node:fs`'s ESM named exports are frozen, so the counters
 * come from the modules' own test hooks (the `__test__agentRecordBufferCount`
 * precedent).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__agentEventBytesRead,
	__test__agentEventsCursorState,
	__test__clearAgentEventsCursorCache,
	__test__clearWrittenStatusMemo,
	__test__lastAgentStatusWriteCount,
	__test__resetAgentEventBytesRead,
	agentEventsPath,
	agentStatusPath,
	appendCrewAgentEvent,
	readCrewAgentEventsCursor,
	readCrewAgents,
	saveCrewAgents,
	upsertCrewAgent,
} from "../../../../src/runtime/crew-agent-records.ts";
import type { CrewAgentRecord } from "../../../../src/runtime/crew-agent-runtime.ts";
import { flushPendingAtomicWrites, hasPendingCoalescedWrite } from "../../../../src/state/atomic-write.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function makeManifest(stateRoot: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "agent-record-cost",
		team: "test-team",
		workflow: "test",
		goal: "test",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: os.tmpdir(),
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
}

function makeRecord(taskId: string, overrides: Partial<CrewAgentRecord> = {}): CrewAgentRecord {
	return {
		id: `id_${taskId}`,
		runId: "agent-record-cost",
		taskId,
		agent: "explorer",
		role: "explorer",
		runtime: "scaffold",
		status: "running",
		startedAt: new Date().toISOString(),
		...overrides,
	} as CrewAgentRecord;
}

function newRun(): { cwd: string; manifest: TeamRunManifest } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-cost-"));
	const stateRoot = path.join(cwd, "state", "runs", "agent-record-cost");
	fs.mkdirSync(stateRoot, { recursive: true });
	__test__clearAgentEventsCursorCache();
	__test__clearWrittenStatusMemo();
	return { cwd, manifest: makeManifest(stateRoot) };
}

/**
 * Count `rename(2)` calls landing on `agents.json` while `fn` runs.
 *
 * `node:fs`'s ESM named exports are frozen, so the swap goes through the CJS
 * default export and `syncBuiltinESMExports()` — the established pattern in
 * test/unit/state/state-store-tasks-fsync.test.ts:120-172.
 */
function countAgentsIndexRenames(manifest: TeamRunManifest, fn: () => void): number {
	const agentsFile = path.join(manifest.stateRoot, "agents.json");
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as { renameSync: (...args: unknown[]) => unknown };
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const original = fsDefault.renameSync;
	let renames = 0;
	fsDefault.renameSync = (...args: unknown[]) => {
		if (typeof args[1] === "string" && args[1] === agentsFile) renames += 1;
		return original(...args);
	};
	nodeModule.syncBuiltinESMExports();
	try {
		fn();
	} finally {
		fsDefault.renameSync = original;
		nodeModule.syncBuiltinESMExports();
	}
	return renames;
}

// ---------------------------------------------------------------------------
// F06 — coalescing must survive the read-after-write path
// ---------------------------------------------------------------------------

test("F06: a burst of progress upserts does not force one agents.json write each", () => {
	const { cwd, manifest } = newRun();
	try {
		const record = makeRecord("01_a");
		// Baseline: 19 renames for 20 upserts (one per upsert after the first).
		const renames = countAgentsIndexRenames(manifest, () => {
			for (let i = 0; i < 20; i += 1) {
				upsertCrewAgent(manifest, { ...record, progress: { recentTools: [], recentOutput: [], toolCount: i } } as CrewAgentRecord);
			}
		});
		assert.ok(renames <= 2, `expected <= 2 agents.json renames for 20 upserts, got ${renames} (baseline 19)`);
		// The coalescing window must still be OPEN — one pending write at the end.
		assert.equal(hasPendingCoalescedWrite(path.join(manifest.stateRoot, "agents.json")), true, "index write stays coalesced");
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F06: read-after-write still sees the newest record before the drain", () => {
	const { cwd, manifest } = newRun();
	try {
		const record = makeRecord("01_a");
		upsertCrewAgent(manifest, { ...record, progress: { recentTools: [], recentOutput: [], toolCount: 1 } } as CrewAgentRecord);
		const firstRead = readCrewAgents(manifest);
		assert.equal(firstRead.length, 1, "the buffered record must be visible before the drain");
		assert.equal(firstRead[0]?.progress?.toolCount, 1);

		upsertCrewAgent(manifest, { ...record, status: "waiting" } as CrewAgentRecord);
		const secondRead = readCrewAgents(manifest);
		assert.equal(secondRead.length, 1, "still a single record");
		assert.equal(secondRead[0]?.status, "waiting", "read-after-write must observe the newest buffered snapshot");

		upsertCrewAgent(manifest, makeRecord("02_b"));
		const thirdRead = readCrewAgents(manifest);
		assert.equal(thirdRead.length, 2, "an appended record must be visible too");
		assert.deepEqual(thirdRead.map((item) => item.taskId).sort(), ["01_a", "02_b"]);
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F06: updating one terminal record does not rewrite the untouched records' status", () => {
	const { cwd, manifest } = newRun();
	try {
		const records = ["01_a", "02_b", "03_c", "04_d"].map((taskId) => makeRecord(taskId, { status: "completed" }));
		saveCrewAgents(manifest, records);
		flushPendingAtomicWrites();
		const before = new Map(
			records.map((record) => [record.taskId, fs.readFileSync(agentStatusPath(manifest, record.taskId), "utf-8")]),
		);

		// Update ONLY 01_a (terminal → the durable branch).
		const updated = { ...records[0]!, status: "failed" as const };
		upsertCrewAgent(manifest, updated);
		flushPendingAtomicWrites();

		// The three untouched records must be byte-identical to what they were —
		// i.e. no write happened for them. (Baseline wrote all four.)
		for (const taskId of ["02_b", "03_c", "04_d"]) {
			assert.equal(
				fs.readFileSync(agentStatusPath(manifest, taskId), "utf-8"),
				before.get(taskId),
				`${taskId} status must be untouched`,
			);
		}
		assert.equal(readCrewAgents(manifest).find((item) => item.taskId === "01_a")?.status, "failed");
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F06: saveCrewAgents reports zero status writes when nothing changed", () => {
	const { cwd, manifest } = newRun();
	try {
		const records = ["01_a", "02_b", "03_c"].map((taskId) => makeRecord(taskId, { status: "completed" }));
		saveCrewAgents(manifest, records);
		flushPendingAtomicWrites();
		assert.equal(__test__lastAgentStatusWriteCount(), 3, "the first save writes all three");

		// Same content, same order → no record is dirty.
		saveCrewAgents(manifest, records);
		assert.equal(__test__lastAgentStatusWriteCount(), 0, "an identical save must write no status file");

		// One changed record → exactly one write.
		saveCrewAgents(manifest, [records[0]!, { ...records[1]!, status: "failed" }, records[2]!]);
		assert.equal(__test__lastAgentStatusWriteCount(), 1, "only the changed record is written");
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F06: the deliberate duplicate terminal status write is preserved (H2/F4 durability)", () => {
	const { cwd, manifest } = newRun();
	try {
		const record = makeRecord("01_a", { status: "completed" });
		upsertCrewAgent(manifest, record);
		flushPendingAtomicWrites();
		// Terminal status must be durably on disk IMMEDIATELY (no coalesce window).
		assert.equal(fs.existsSync(agentStatusPath(manifest, "01_a")), true, "terminal status is written synchronously");
		assert.equal(
			JSON.parse(fs.readFileSync(agentStatusPath(manifest, "01_a"), "utf-8")).status,
			"completed",
			"terminal content is durable without a drain",
		);
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F06: a non-terminal save still coalesces its status writes (durability unchanged)", () => {
	const { cwd, manifest } = newRun();
	try {
		saveCrewAgents(manifest, [makeRecord("01_a")]);
		assert.equal(
			hasPendingCoalescedWrite(agentStatusPath(manifest, "01_a")),
			true,
			"non-terminal status stays on the best-effort coalesced path",
		);
		flushPendingAtomicWrites();
		assert.equal(fs.existsSync(agentStatusPath(manifest, "01_a")), true);
	} finally {
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// F07 — the event cursor must not re-read history on an idle poll
// ---------------------------------------------------------------------------

/** Write `count` events directly (bypassing the buffered appender for speed). */
function seedEvents(manifest: TeamRunManifest, taskId: string, count: number): number {
	const eventsPath = agentEventsPath(manifest, taskId);
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const lines: string[] = [];
	for (let seq = 1; seq <= count; seq += 1) {
		lines.push(`${JSON.stringify({ seq, time: new Date().toISOString(), event: { type: "progress", seq, pad: "x".repeat(40) } })}\n`);
	}
	fs.writeFileSync(eventsPath, lines.join(""), "utf-8");
	return fs.statSync(eventsPath).size;
}

test("F07: an idle poll on a large event file reads zero event bytes", () => {
	const { cwd, manifest } = newRun();
	try {
		const size = seedEvents(manifest, "task-1", 10_000);
		assert.ok(size > 500_000, `fixture should be large, got ${size} bytes`);
		// Prime the cursor (one full read), then poll at the head seq.
		const primed = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 10_000, limit: 100 });
		assert.deepEqual(primed.events, []);
		assert.equal(primed.total, 0);

		__test__resetAgentEventBytesRead();
		for (let poll = 1; poll <= 3; poll += 1) {
			const result = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 10_000, limit: 100 });
			assert.deepEqual(result.events, [], `poll ${poll} is idle`);
			assert.equal(result.total, 0);
			assert.equal(result.nextSeq, 10_000);
		}
		// Baseline: size × 3 = linear in file size, per idle poll.
		assert.equal(__test__agentEventBytesRead(), 0, `3 idle polls must read 0 event bytes (baseline: ${size * 3})`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: an append reads only the delta, not the whole history", () => {
	const { cwd, manifest } = newRun();
	try {
		seedEvents(manifest, "task-1", 10_000);
		readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 10_000, limit: 100 });

		__test__resetAgentEventBytesRead();
		appendCrewAgentEvent(manifest, "task-1", { type: "fresh" });
		const result = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 10_000, limit: 100 });
		assert.equal(result.events.length, 1, "the appended event is delivered");
		assert.equal((result.events[0] as { seq: number }).seq, 10_001);
		assert.equal(result.total, 1);
		assert.ok(__test__agentEventBytesRead() < 1024, `an append must cost < 1 KiB, got ${__test__agentEventBytesRead()} bytes`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: parity with the legacy reader for explicit seq, legacy seq, and limit", () => {
	const { cwd, manifest } = newRun();
	try {
		const eventsPath = agentEventsPath(manifest, "task-1");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		// Explicit seqs 1,2,3 then legacy lines with NO seq (→ index+1 = 4,5).
		fs.writeFileSync(
			eventsPath,
			[
				`${JSON.stringify({ seq: 1, event: { n: 1 } })}\n`,
				`${JSON.stringify({ seq: 2, event: { n: 2 } })}\n`,
				`${JSON.stringify({ seq: 3, event: { n: 3 } })}\n`,
				`${JSON.stringify({ event: { n: 4 } })}\n`,
				`${JSON.stringify({ event: { n: 5 } })}\n`,
			].join(""),
			"utf-8",
		);
		// The legacy implementation, verbatim (read → split → parse → filter → slice).
		const legacy = (sinceSeq: number, limit?: number) => {
			const parsed = fs
				.readFileSync(eventsPath, "utf-8")
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line, index) => {
					try {
						const event = JSON.parse(line) as Record<string, unknown>;
						if (typeof event.seq !== "number") event.seq = index + 1;
						return event;
					} catch {
						return { seq: index + 1, raw: line };
					}
				});
			const filtered = parsed.filter((event) => typeof event.seq === "number" && event.seq > sinceSeq);
			const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
			const returnedMaxSeq = events.reduce(
				(max, event) => (typeof event.seq === "number" ? Math.max(max, event.seq) : max),
				sinceSeq,
			);
			return { events, nextSeq: returnedMaxSeq, total: filtered.length };
		};

		for (const [sinceSeq, limit] of [
			[0, undefined],
			[0, 2],
			[2, undefined],
			[3, 1],
			[5, undefined],
			[9, 5],
		] as Array<[number, number | undefined]>) {
			const expected = legacy(sinceSeq, limit);
			const actual = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq, limit });
			assert.deepEqual(actual.events, expected.events, `events parity for sinceSeq=${sinceSeq} limit=${limit}`);
			assert.equal(actual.nextSeq, expected.nextSeq, `nextSeq parity for sinceSeq=${sinceSeq} limit=${limit}`);
			assert.equal(actual.total, expected.total, `total parity for sinceSeq=${sinceSeq} limit=${limit}`);
		}
		// Legacy seq assignment is index-based, so lines 4 and 5 got seq 4 and 5.
		assert.deepEqual(
			readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 0 }).events.map((event) => (event as { seq: number }).seq),
			[1, 2, 3, 4, 5],
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: parity holds when the file grows between polls (legacy seq indices stay absolute)", () => {
	const { cwd, manifest } = newRun();
	try {
		const eventsPath = agentEventsPath(manifest, "task-1");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		// Three legacy lines with NO seq → seq 1,2,3 by index.
		fs.writeFileSync(eventsPath, [1, 2, 3].map((n) => `${JSON.stringify({ event: { n } })}\n`).join(""), "utf-8");
		const first = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 0 });
		assert.deepEqual(
			first.events.map((event) => (event as { seq: number }).seq),
			[1, 2, 3],
		);
		assert.equal(first.total, 3);

		// Append two MORE legacy lines → their index-based seqs are 4 and 5.
		fs.appendFileSync(eventsPath, [4, 5].map((n) => `${JSON.stringify({ event: { n } })}\n`).join(""), "utf-8");
		const second = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 3 });
		assert.deepEqual(
			second.events.map((event) => (event as { seq: number }).seq),
			[4, 5],
			"legacy seq indices stay absolute",
		);
		assert.equal(second.total, 2);

		// And the delta path must agree with a cold full read.
		__test__clearAgentEventsCursorCache();
		const cold = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 3 });
		assert.deepEqual(cold.events, second.events, "warm delta and cold full read agree");
		assert.equal(cold.total, second.total);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: Unicode payloads survive the incremental read without replacement chars", () => {
	const { cwd, manifest } = newRun();
	try {
		const eventsPath = agentEventsPath(manifest, "task-1");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		const payloads = ["Tiếng Việt có dấu", "emoji 🚀🎯", "日本語テキスト", "combining é\u0301"];
		fs.writeFileSync(eventsPath, `${JSON.stringify({ seq: 1, event: { text: payloads[0] } })}\n`, "utf-8");
		readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 1 });
		for (let i = 1; i < payloads.length; i += 1) {
			fs.appendFileSync(eventsPath, `${JSON.stringify({ seq: i + 1, event: { text: payloads[i] } })}\n`, "utf-8");
		}
		const result = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 1 });
		assert.deepEqual(
			result.events.map((event) => (event as { event: { text: string } }).event.text),
			payloads.slice(1),
			"no event lost or mangled across the delta read",
		);
		assert.equal(JSON.stringify(result.events).includes("\uFFFD"), false, "no U+FFFD replacement characters");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: a partially-written trailing line is neither lost nor duplicated", () => {
	const { cwd, manifest } = newRun();
	try {
		const eventsPath = agentEventsPath(manifest, "task-1");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		fs.writeFileSync(eventsPath, `${JSON.stringify({ seq: 1, event: { n: 1 } })}\n`, "utf-8");
		readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 1 });

		// A torn write: the line is on disk without its terminating newline.
		const torn = JSON.stringify({ seq: 2, event: { n: 2 } });
		fs.appendFileSync(eventsPath, torn, "utf-8");
		const midWrite = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 1 });
		assert.deepEqual(midWrite.events, [], "an incomplete line must not be parsed as an event");

		// The writer completes the line — it must appear exactly once.
		fs.appendFileSync(eventsPath, "\n", "utf-8");
		const completed = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 1 });
		assert.equal(completed.events.length, 1, "the completed line appears exactly once");
		assert.equal((completed.events[0] as { seq: number }).seq, 2);
		const again = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 2 });
		assert.deepEqual(again.events, [], "and it is not duplicated on the next poll");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: truncation resets the cursor instead of losing events", () => {
	const { cwd, manifest } = newRun();
	try {
		seedEvents(manifest, "task-1", 50);
		const before = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 0 });
		assert.equal(before.events.length, 50);
		assert.equal(before.total, 50);

		// Truncate to empty and write a brand-new, shorter history.
		fs.writeFileSync(agentEventsPath(manifest, "task-1"), "", "utf-8");
		const emptied = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 0 });
		assert.deepEqual(emptied.events, [], "empty file yields no events");

		seedEvents(manifest, "task-1", 3);
		const after = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 0 });
		assert.equal(after.total, 3, "the new file is read from its start");
		assert.deepEqual(
			after.events.map((event) => (event as { seq: number }).seq),
			[1, 2, 3],
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: inode replacement (rotation) is detected even when the size grows back", () => {
	const { cwd, manifest } = newRun();
	try {
		const eventsPath = agentEventsPath(manifest, "task-1");
		seedEvents(manifest, "task-1", 100);
		const primed = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 100 });
		assert.deepEqual(primed.events, []);
		// The cache is keyed by the CANONICAL file path the reader resolved
		// (safeExistingAgentFile → realpath), not the raw stateRoot-joined path. On
		// macOS os.tmpdir() is a symlink (/var → /private/var) so the two differ and
		// a raw-path lookup finds nothing (macOS CI: "the watermark is cached").
		// primed.path is exactly the key the reader used — no re-derivation needed.
		const primedState = __test__agentEventsCursorState(primed.path);
		assert.ok(primedState, "the watermark is cached");

		// Replace the file: write a NEW, longer history to a temp path and rename
		// over the original — a new inode with a larger size than the old one.
		const replacement = `${eventsPath}.new`;
		const lines: string[] = [];
		for (let seq = 1; seq <= 150; seq += 1) {
			lines.push(`${JSON.stringify({ seq, event: { n: seq, pad: "y".repeat(60) } })}\n`);
		}
		fs.writeFileSync(replacement, lines.join(""), "utf-8");
		fs.renameSync(replacement, eventsPath);
		assert.ok(fs.statSync(eventsPath).size > primedState.size, "the replacement is larger than the primed size");
		assert.notEqual(fs.statSync(eventsPath).ino, primedState.ino, "the replacement has a new inode");

		const after = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 140 });
		assert.deepEqual(
			after.events.map((event) => (event as { seq: number }).seq),
			[141, 142, 143, 144, 145, 146, 147, 148, 149, 150],
			"the new file is read from its start — no events dropped",
		);
		assert.equal(after.total, 10);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: an anchor older than the consumed prefix still gets full history", () => {
	const { cwd, manifest } = newRun();
	try {
		seedEvents(manifest, "task-1", 10);
		// Poll at the head (consumes the whole file into the watermark).
		readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 10 });
		// Now ask from the beginning: the cached prefix CAN match, so the reader
		// must fall back to a full read rather than answer from the empty delta.
		const replay = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 0 });
		assert.equal(replay.total, 10, "a sinceSeq=0 replay sees every event");
		assert.equal(replay.events.length, 10);
		assert.equal(replay.nextSeq, 10);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F07: two idle polls of the transcript consumer return identical results at delta cost", () => {
	const { cwd, manifest } = newRun();
	try {
		seedEvents(manifest, "task-1", 500);
		let sinceSeq = 0;
		const first = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq });
		sinceSeq = first.nextSeq;
		assert.equal(first.events.length, 500);

		__test__resetAgentEventBytesRead();
		const second = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq });
		const third = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq });
		assert.deepEqual(second.events, [], "idle poll 1 has nothing new");
		assert.deepEqual(third.events, [], "idle poll 2 has nothing new");
		assert.equal(second.total, third.total);
		assert.equal(__test__agentEventBytesRead(), 0, "both idle polls cost zero event bytes");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
