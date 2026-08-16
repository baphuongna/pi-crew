/**
 * R10-5 (Wave 2B item 4) regression: per-task batching of the agent-record
 * append sinks (events.jsonl + output.log) used by child-executor.
 *
 * Contract under test:
 *  - buffered appends do NOT touch disk per line (one appendFileSync per flush)
 *  - flush at the task boundary (flushCrewAgentRecordBuffer) lands the exact
 *    persisted state the unbuffered implementation would have produced
 *    (same lines, same seq allocation, same order)
 *  - 32-event cap and the 250ms window each flush autonomously
 *  - mixed buffered/direct usage cannot double-allocate seqs or reorder lines
 *  - seq reservation continues correctly across flushes (no collisions/gaps)
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { after } from "node:test";
import {
	__test__agentRecordBufferCount,
	agentEventsPath,
	appendCrewAgentEvent,
	appendCrewAgentEventBuffered,
	appendCrewAgentOutput,
	appendCrewAgentOutputBuffered,
	flushCrewAgentRecordBuffer,
	readCrewAgentEventsCursor,
} from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";

const createdTmpDirs: string[] = [];
after(() => {
	for (const d of createdTmpDirs) {
		try {
			fs.rmSync(d, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	}
});

function buildManifest(cwd: string) {
	return createRunManifest({
		cwd,
		team: {
			name: "buffer-team",
			description: "buffer",
			source: "builtin",
			filePath: "",
			roles: [{ name: "explorer", agent: "explorer" }],
		},
		workflow: { name: "buffer", description: "", source: "builtin", filePath: "", steps: [] },
		goal: "buffer",
	}).manifest;
}

function newRun() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-buffer-"));
	createdTmpDirs.push(cwd);
	fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
	return { cwd, manifest: buildManifest(cwd) };
}

function readEventsFile(manifest: ReturnType<typeof buildManifest>): Array<Record<string, unknown>> {
	const raw = fs.readFileSync(agentEventsPath(manifest, "task-1"), "utf-8");
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("task-boundary flush lands the exact unbuffered persisted state (R10-5)", () => {
	const referenceRun = newRun();
	const subjectRun = newRun();
	const manifest = subjectRun.manifest;
	const reference = referenceRun.manifest;
	const events: Array<{ type: string; i: number }> = [];
	for (let i = 0; i < 10; i++) events.push({ type: "test.event", i });
	const outputLines = ["line-0", "line-1", "line-2"];

	// Reference: the UNBUFFERED implementation (direct appends).
	for (const [i, event] of events.entries()) appendCrewAgentEvent(reference, "task-1", event);
	for (const line of outputLines) appendCrewAgentOutput(reference, "task-1", line);

	// Subject: the buffered implementation + boundary flush (what child-executor does).
	for (const event of events) appendCrewAgentEventBuffered(manifest, "task-1", event);
	for (const line of outputLines) appendCrewAgentOutputBuffered(manifest, "task-1", line);

	assert.equal(fs.existsSync(agentEventsPath(manifest, "task-1")), false, "events stay buffered before the boundary");
	assert.equal(__test__agentRecordBufferCount(), 1, "one pending batch");

	flushCrewAgentRecordBuffer(manifest, "task-1"); // <- task completion/failure boundary

	const got = readEventsFile(manifest);
	const want = readEventsFile(reference);
	assert.equal(got.length, want.length, "same persisted line count after boundary flush");
	assert.deepEqual(
		got.map((e) => e.event),
		want.map((e) => e.event),
		"event payloads identical to unbuffered implementation",
	);
	assert.deepEqual(
		got.map((e) => e.seq),
		want.map((e) => e.seq),
		"seq allocation identical to unbuffered implementation",
	);
	const output = fs.readFileSync(path.join(path.dirname(agentEventsPath(manifest, "task-1")), "output.log"), "utf-8");
	assert.equal(output, `${outputLines.join("\n")}\n`, "output.log lines identical, in order");
	assert.equal(__test__agentRecordBufferCount(), 0, "buffer is drained at the boundary");

	// Seq continuity AFTER a flush: the next direct append must not collide
	// with any reserved/flushed seq (cache + sidecar bookkeeping).
	appendCrewAgentEvent(manifest, "task-1", { type: "after-boundary" });
	const after = readEventsFile(manifest);
	assert.equal(after.length, events.length + 1);
	assert.equal(after.at(-1)?.seq, events.length + 1, "next seq continues monotonically after flush");
});

test("32-event cap flushes autonomously without an explicit boundary flush (R10-5)", () => {
	const { manifest } = newRun();
	for (let i = 0; i < 32; i++) appendCrewAgentEventBuffered(manifest, "task-1", { type: "cap", i });
	assert.equal(fs.existsSync(agentEventsPath(manifest, "task-1")), true, "cap flush landed the batch synchronously");
	assert.equal(readEventsFile(manifest).length, 32);
	assert.equal(__test__agentRecordBufferCount(), 0, "no batch left pending after cap flush");
});

test("250ms window timer flushes buffered lines even with no further activity (R10-5)", async () => {
	const { manifest } = newRun();
	appendCrewAgentEventBuffered(manifest, "task-1", { type: "window" });
	appendCrewAgentOutputBuffered(manifest, "task-1", "quiet line");
	assert.equal(fs.existsSync(agentEventsPath(manifest, "task-1")), false);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert.equal(readEventsFile(manifest).length, 1, "window timer flushed the event");
	assert.equal(__test__agentRecordBufferCount(), 0);
	const output = fs.readFileSync(path.join(path.dirname(agentEventsPath(manifest, "task-1")), "output.log"), "utf-8");
	assert.equal(output, "quiet line\n", "window timer flushed the output line");
});

test("mixed buffered + direct appends: no seq collisions, no reordering (R10-5)", () => {
	const { manifest } = newRun();
	appendCrewAgentEventBuffered(manifest, "task-1", { type: "b1" });
	appendCrewAgentEventBuffered(manifest, "task-1", { type: "b2" });
	appendCrewAgentEventBuffered(manifest, "task-1", { type: "b3" });
	// Direct append while the batch is pending must land the batch FIRST
	// (guard in appendCrewAgentEvent), then allocate the next seq.
	appendCrewAgentEvent(manifest, "task-1", { type: "direct" });
	const lines = readEventsFile(manifest);
	assert.deepEqual(
		lines.map((l) => (l.event as { type: string }).type),
		["b1", "b2", "b3", "direct"],
		"file order preserved: buffered lines land before the direct line",
	);
	assert.deepEqual(
		lines.map((l) => l.seq),
		[1, 2, 3, 4],
		"seqs strictly increasing with no collision",
	);
	// Cursor readers see a consistent tail after the mixed sequence.
	const cursor = readCrewAgentEventsCursor(manifest, "task-1", { sinceSeq: 2 });
	assert.equal(cursor.events.length, 2);
});

test("output-only task: dir is ensured at buffer time, boundary flush lands lines (R10-5)", () => {
	// Regression: appendCrewAgentOutputBuffered used to skip ensureAgentStateDir;
	// an output-only task (stdout lines buffered before ANY json event) hit
	// ENOENT at flush time and silently dropped the whole batch.
	const { manifest } = newRun();
	assert.equal(fs.existsSync(path.dirname(agentEventsPath(manifest, "task-1"))), false, "cold start: no state dir yet");
	appendCrewAgentOutputBuffered(manifest, "task-1", "stdout before any event");
	appendCrewAgentOutputBuffered(manifest, "task-1", "second line");
	assert.equal(fs.existsSync(agentEventsPath(manifest, "task-1")), false, "still buffered (no events)");
	flushCrewAgentRecordBuffer(manifest, "task-1");
	const output = fs.readFileSync(path.join(path.dirname(agentEventsPath(manifest, "task-1")), "output.log"), "utf-8");
	assert.equal(output, "stdout before any event\nsecond line\n", "output-only batch survives flush");
	// And a later buffered event still allocates seq 1 (no sidecar pollution).
	appendCrewAgentEventBuffered(manifest, "task-1", { type: "late" });
	flushCrewAgentRecordBuffer(manifest, "task-1");
	const events = readEventsFile(manifest);
	assert.equal(events.length, 1);
	assert.equal(events[0].seq, 1, "first event gets seq 1 after output-only batch");
});

test("redaction applies to buffered lines exactly as to direct lines (R10-5)", () => {
	const referenceRun = newRun();
	const subjectRun = newRun();
	const manifest = subjectRun.manifest;
	const reference = referenceRun.manifest;
	const secretish = { type: "note", api_key: "sk-super-secret-value" };
	appendCrewAgentEvent(reference, "task-1", secretish);
	appendCrewAgentEventBuffered(manifest, "task-1", secretish);
	flushCrewAgentRecordBuffer(manifest, "task-1");
	const got = JSON.stringify(readEventsFile(manifest));
	const want = JSON.stringify(readEventsFile(reference));
	// Timestamps are per-append wall-clock; normalize them out before comparing
	// (two separate Date().toISOString() calls can straddle a millisecond).
	const stripTime = (raw: string) => raw.replace(/"time":"[^"]*"/g, '"time":"T"');
	assert.equal(stripTime(got), stripTime(want), "buffered path redacts identically to direct path");
	assert.ok(!got.includes("sk-super-secret-value"), "secret must be redacted on the buffered path too");
});
