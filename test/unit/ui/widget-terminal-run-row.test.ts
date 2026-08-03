import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWidgetLines } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

/**
 * Bug 022 — terminal-run widget row: timer freezes + status label shown.
 *
 * Before the fix, `widget-renderer.ts` computed runElapsedMs = Date.now() -
 * run.createdAt for EVERY run, including terminal ones. A failed run that
 * lingered in the grace window (F-5, ~10min) showed an ever-climbing counter
 * (e.g. `2028s` and rising) read as "still running". The ✘/✗ glyph + the
 * spinner-style `0/1 agents` layout reinforced the misread.
 *
 * Fix: for terminal runs (failed/cancelled/completed/blocked), FREEZE the
 * counter at run.updatedAt and append an explicit ` · <status>` label so the
 * row cannot be misread as active.
 */

const FAKE_CWD = "/tmp/pi-crew-terminal-run-test";

function makeRun(status: WidgetRun["run"]["status"], createdAtAgo: number, updatedAtAgo: number): WidgetRun {
	const now = Date.now();
	const run = {
		schemaVersion: 1,
		runId: "run_abc12345f0",
		team: "direct-executor",
		workflow: "direct-agent",
		goal: "Port source/x.py to Rust",
		status,
		createdAt: new Date(now - createdAtAgo).toISOString(),
		updatedAt: new Date(now - updatedAtAgo).toISOString(),
		workspaceMode: "single" as const,
		ownerSessionId: "session_test",
		cwd: FAKE_CWD,
		stateRoot: FAKE_CWD,
		artifactsRoot: FAKE_CWD,
		tasksPath: "/tmp/tasks.jsonl",
		eventsPath: "/tmp/events.jsonl",
		artifacts: [] as never,
	};
	// A failed run's lone task has status=failed, no completedAt (matches the
	// real data shape seen in the wild — completedAt is None on failure).
	const agents = [
		{
			id: "agent_x",
			runId: run.runId,
			agent: "executor",
			role: "executor",
			taskId: "01_01-agent",
			status: "failed" as const,
			startedAt: new Date(now - createdAtAgo).toISOString(),
			prompt: "port",
		},
	];
	return { run, agents, snapshot: undefined } as unknown as WidgetRun;
}

function findRunRow(lines: string[]): string {
	// The run-level progress row is the one containing the runId tail (last 8).
	const row = lines.find((l) => l.includes("c12345f0"));
	assert.ok(row, `run row not found in: ${JSON.stringify(lines)}`);
	return row;
}

test("Bug 022: FAILED run timer FREEZES at updatedAt (not climbing forever)", () => {
	// Run created 30min ago, FAILED 7min ago (still in F-5 grace → visible).
	// createdAt..updatedAt gap = 23min → elapsed should be ~1380s, NOT 1800s.
	const run = makeRun("failed", 30 * 60_000, 7 * 60_000);
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, [run], 0, 200);
	const row = findRunRow(lines);
	// Extract the seconds field from the row.
	const m = row.match(/(\d+)s/);
	assert.ok(m, `elapsed field not found in row: ${row}`);
	const elapsed = Number(m[1]);
	// ~23min = 1380s. Allow a tiny skew (createdAt/updatedAt rounding) but the
	// key assertion: it must NOT be ~1800s (30min from createdAt) and it must
	// NOT grow on re-render.
	assert.ok(
		elapsed >= 1300 && elapsed <= 1400,
		`expected frozen elapsed ~1380s (updatedAt-createdAt), got ${elapsed}s — timer did not freeze at failure`,
	);
});

test("Bug 022: FAILED run row shows explicit 'failed' status label (cannot be misread as active)", () => {
	const run = makeRun("failed", 30 * 60_000, 7 * 60_000);
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, [run], 0, 200);
	const row = findRunRow(lines);
	assert.match(row, /failed/, `terminal run must surface its status: ${row}`);
});

test("Bug 022: FAILED timer is STABLE across ticks (re-render returns identical elapsed)", () => {
	const run = makeRun("failed", 30 * 60_000, 7 * 60_000);
	const a = buildWidgetLines(FAKE_CWD, 0, 20, [run], 0, 200);
	const b = buildWidgetLines(FAKE_CWD, 1, 20, [run], 0, 200);
	assert.equal(findRunRow(a), findRunRow(b), "terminal-run row must be byte-identical across ticks (timer frozen)");
});

test("Bug 022: COMPLETED run timer also freezes (consistent terminal handling)", () => {
	const run = makeRun("completed", 30 * 60_000, 7 * 60_000);
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, [run], 0, 200);
	const row = findRunRow(lines);
	assert.match(row, /completed/, `completed run must surface its status: ${row}`);
	const m = row.match(/(\d+)s/);
	const elapsed = Number(m![1]);
	assert.ok(elapsed >= 1300 && elapsed <= 1400, `completed elapsed frozen ~1380s, got ${elapsed}s`);
});

test("Bug 022: RUNNING run timer still ticks (no regression — only terminal freezes)", () => {
	// A running run must keep using Date.now() so the counter advances.
	const run = makeRun("running", 5 * 60_000, 1_000); // created 5min ago, updated 1s ago
	const a = buildWidgetLines(FAKE_CWD, 0, 20, [run], 0, 200);
	const rowA = findRunRow(a);
	const m = rowA.match(/(\d+)s/);
	const elapsed = Number(m![1]);
	assert.ok(elapsed >= 290 && elapsed <= 310, `running run elapsed ~300s (from createdAt, live), got ${elapsed}s`);
	assert.doesNotMatch(rowA, /\bcompleted\b|\bfailed\b|\bcancelled\b/, `running run has no terminal status label: ${rowA}`);
});
