import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { buildWidgetLines, resetWidgetScheduledJobsReader, setWidgetScheduledJobsReader } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

const FAKE_CWD = "/tmp/pi-crew-widget-truncate-test";
const T0 = new Date("2026-10-07T11:43:27.000Z");

afterEach(() => {
	resetWidgetScheduledJobsReader();
});

/** Minimal scheduled job — `nextRun: undefined` paints the plain `⏰ 1 sched`. */
function makeJob(overrides?: Partial<ScheduledJob>): ScheduledJob {
	return {
		id: "job-1",
		name: "nightly-digest",
		description: "",
		schedule: "0 3 * * *",
		scheduleType: "cron",
		subagentType: "executor",
		prompt: "{}",
		enabled: true,
		createdAt: T0.toISOString(),
		runCount: 0,
		...overrides,
	};
}

function makeFakeRun(overrides?: {
	description?: string;
	recentOutput?: string[];
	planApproval?: TeamRunManifest["planApproval"];
	/** L9 pins vary the subject: pass "" to clear team/workflow so the label
	 *  falls back to the run id (shortRunLabel treats "" as absent). */
	runId?: string;
	team?: string;
	workflow?: string;
}): WidgetRun {
	// Minimal mock — only fields exercised by buildWidgetLines are real.
	// Other required TeamRunManifest / CrewAgentRecord fields are filled with
	// stubs that the renderer never reads; cast to satisfy the type checker.
	const run = {
		schemaVersion: 1,
		runId: overrides?.runId ?? "run_e56753a9abcdef00",
		team: overrides?.team ?? "parallel-research",
		workflow: overrides?.workflow ?? "parallel-research",
		goal: "Read harness archives",
		status: "running" as const,
		startedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		workspaceMode: "single" as const,
		ownerSessionId: "session_test",
		sessionGeneration: 1,
		conversationId: "conv_test",
		cwd: FAKE_CWD,
		stateRoot: FAKE_CWD,
		artifactsRoot: FAKE_CWD,
		tasksPath: "/tmp/tasks.jsonl",
		eventsPath: "/tmp/events.jsonl",
		pendingTasks: [],
		artifacts: {} as never,
		planApproval: overrides?.planApproval,
	};
	const agents = [
		{
			id: "agent_a",
			runId: run.runId,
			agent: "explorer",
			role: "explorer",
			taskId: "task_1",
			status: "running" as const,
			startedAt: new Date(Date.now() - 180_000).toISOString(),
			prompt: overrides?.description ?? "explore",
			runtime: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
			} as never,
			progress: overrides?.recentOutput ? { currentTool: "read", recentOutput: overrides.recentOutput } : { currentTool: "bash" },
		},
	];
	return { run, agents, snapshot: undefined } as unknown as WidgetRun;
}

test("buildWidgetLines: every rendered line is <= width (no TUI overflow)", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	const width = 100;
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, width);
	for (const [i, line] of lines.entries()) {
		const visible = stripAnsi(line).length;
		assert.ok(visible <= width, `line ${i} width ${visible} exceeds terminal width ${width}: ${JSON.stringify(line.slice(0, 80))}…`);
	}
});

test("buildWidgetLines: 200-char task description does NOT overflow width", () => {
	// Reproduces the actual crash: pi-audit task with `| S7: ... | ⬜ pending | |`
	// style description that escaped the 60-char activity cap.
	const longDesc = "| S7: pi-audit security test | ⬜ pending | | " + "A".repeat(180);
	const runs: WidgetRun[] = [
		makeFakeRun({
			description: longDesc,
			recentOutput: ["reading file: " + "x".repeat(80)],
		}),
	];
	const width = 159; // matches the actual crash terminal width
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, width);
	assert.ok(lines.length > 0);
	for (const [i, line] of lines.entries()) {
		const visible = stripAnsi(line).length;
		assert.ok(visible <= width, `CRASH-GUARD: line ${i} width ${visible} > terminal ${width}: ${JSON.stringify(line.slice(0, 80))}…`);
	}
});

test("buildWidgetLines: monotone in width (wider = never shorter content)", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	const narrow = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 60);
	const wide = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 160);
	assert.ok(stripAnsi(narrow[0]!).length <= 60, "narrow header fits");
	assert.ok(stripAnsi(wide[0]!).length <= 160, "wide header fits");
	assert.ok(stripAnsi(wide[0]!).length >= stripAnsi(narrow[0]!).length, "wider width never produces a shorter visible header");
});

test("buildWidgetLines: missing width param still works (default fallback)", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	// No width passed -> falls back to DEFAULT_WIDGET_WIDTH (100).
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0);
	assert.ok(lines.length > 0);
	for (const [i, line] of lines.entries()) {
		const visible = stripAnsi(line).length;
		assert.ok(visible <= 100, `default-width fallback: line ${i} = ${visible} > 100: ${JSON.stringify(line.slice(0, 80))}…`);
	}
});

test("WP-3 (single line): pending planApproval surfaces the ⚠ plan:<run8> segment on the count row", () => {
	const runs: WidgetRun[] = [
		makeFakeRun({
			planApproval: {
				required: true,
				status: "pending",
				requestedAt: "2026-08-18T00:00:00Z",
				updatedAt: "2026-08-18T00:00:00Z",
			},
		}),
	];
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 100);
	assert.equal(lines.length, 1);
	assert.match(
		lines[0] ?? "",
		new RegExp(`⚠ plan:${runs[0]!.run.runId.slice(-8)}`),
		"count row carries the plan badge with the short run id",
	);
	assert.ok(stripAnsi(lines[0] ?? "").length <= 100, "plan badge respects the width budget");
});

test("WP-3 (single line): non-pending run keeps the ⚠ plan segment OFF the count row", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 100);
	assert.equal(lines.length, 1);
	assert.ok(!lines[0].includes("⚠ plan:"), "no plan badge without pending approval");
});

// ── L9 / T13: dock budget priority — the status word is never split ─────

/** No status word may end in a glued ellipsis (`1 runnin…` — the live
 *  2026-10-07 regression at 40 columns). */
function assertNoMidTokenStatusCut(row: string, label: string): void {
	assert.ok(!/(running|queued|waiting|done)…/.test(row), `${label}: a status word must never be cut mid-token: ${JSON.stringify(row)}`);
}

/** `…` may only mark elision at a SEGMENT boundary: straight before a ` · `
 *  join, the collapsed `  ↓` gap, or end-of-row. */
function assertEllipsisOnlyAtSegmentBoundaries(row: string, label: string): void {
	for (const match of row.matchAll(/…/g)) {
		const after = row.slice((match.index ?? 0) + 1);
		assert.ok(
			after === "" || after.startsWith(" · ") || after.startsWith("  ↓"),
			`${label}: ellipsis must land at a segment boundary, got ${JSON.stringify(row)}`,
		);
	}
}

test("L9/T13 pin: dock@40 with a long run id NEVER splits the status word — `1 running` whole, no elision needed", () => {
	// The live regression (report 2026-10-07, T13 sweep): the 40-column dock
	// rendered `┃ ⠋ CREW ▸ d9782c98 · 1 runnin…  ↓·enter` — the blind truncate
	// of the head+status concatenation landed inside the status token. With
	// budget-priority composition the row fits EXACTLY (id subject, whole
	// `1 running`, collapsed 2-space gap, `↓·enter`) — no `…` anywhere.
	const runs: WidgetRun[] = [makeFakeRun({ team: "", workflow: "" })];
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 40, { now: T0 });
	assert.equal(lines.length, 1);
	const row = stripAnsi(lines[0]!);
	assert.ok(row.includes("1 running"), `the FULL status token survives: ${JSON.stringify(row)}`);
	assert.ok(!row.includes("runnin…"), `the exact live-regression fragment must be impossible: ${JSON.stringify(row)}`);
	assert.ok(!row.includes("…"), `the row fits exactly — no elision marker: ${JSON.stringify(row)}`);
	assert.ok(row.includes("↓·enter"), `the entry hint survives per budget: ${JSON.stringify(row)}`);
	assert.ok(row.includes("abcdef00"), `the id subject survives (it clips only as a last resort): ${JSON.stringify(row)}`);
	assert.ok(row.length <= 40, `row respects the 40-column terminal: got ${row.length}`);
});

test("L9: dock@40 over budget clips the SUBJECT — `…` at the subject boundary, status word whole", () => {
	const runs: WidgetRun[] = [makeFakeRun({ team: "adaptive-implementation", workflow: "adaptive-implementation" })];
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 40, { now: T0 });
	assert.equal(lines.length, 1);
	const row = stripAnsi(lines[0]!);
	assert.ok(row.includes("1 running"), `status token whole: ${JSON.stringify(row)}`);
	assert.match(row, /… · 1 running/, `ellipsis lands at the subject segment boundary: ${JSON.stringify(row)}`);
	assertNoMidTokenStatusCut(row, "dock@40 long label");
	assertEllipsisOnlyAtSegmentBoundaries(row, "dock@40 long label");
	assert.ok(row.length <= 40, `row respects the 40-column terminal: got ${row.length}`);
});

test("L9: dock drops the `⏰` meta segment BEFORE touching the status word or the id", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: undefined })]);
	const runs: WidgetRun[] = [makeFakeRun()]; // subject `parallel-research` (18 cols) — too wide WITH the sched segment @50
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 50, { now: T0 });
	assert.equal(lines.length, 1);
	const row = stripAnsi(lines[0]!);
	assert.ok(row.includes("1 running"), `status word survives: ${JSON.stringify(row)}`);
	assert.ok(row.includes("parallel-research"), `id survives (meta dropped first): ${JSON.stringify(row)}`);
	assert.ok(!row.includes("⏰"), `the sched meta segment drops first: ${JSON.stringify(row)}`);
	assertNoMidTokenStatusCut(row, "dock@50 meta drop");
	assert.ok(row.length <= 50, `row respects the 50-column terminal: got ${row.length}`);
});

test("L9 sweep: across widths the status token is whole-or-absent, never partial", () => {
	const runs: WidgetRun[] = [makeFakeRun({ team: "", workflow: "" })];
	for (const width of [118, 80, 50, 40, 36, 30, 26, 20]) {
		const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, width, { now: T0 });
		assert.equal(lines.length, 1, `@${width}: the dock stays one row`);
		const row = stripAnsi(lines[0]!);
		assert.ok(row.length <= width, `@${width}: row fits, got ${row.length}: ${JSON.stringify(row)}`);
		assertNoMidTokenStatusCut(row, `dock@${width}`);
		assertEllipsisOnlyAtSegmentBoundaries(row, `dock@${width}`);
		// whole-or-absent: a partial `1 runni` (no `…`, no ` running`) must not leak
		assert.ok(!/\b1 runni(?!ng)\b/.test(row), `@${width}: no partial status token: ${JSON.stringify(row)}`);
	}
	// At a comfortable width the full status token is present; at a width
	// where it cannot survive it drops as a unit (26 keeps it, 20 cannot).
	assert.ok(
		stripAnsi(buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 26, { now: T0 })[0]!).includes("1 running"),
		"@26 keeps the whole status token",
	);
	assert.ok(
		!stripAnsi(buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 20, { now: T0 })[0]!).includes("running"),
		"@20 drops it whole rather than splitting it",
	);
});

// Cheap ANSI stripper for visible-width assertion. Sufficient for the
// widget's output which uses a known subset of SGR codes + OSC 8 — in BOTH
// terminator forms: BEL (legacy) and ST `ESC\\` (what pi-tui's hyperlink()
// emits; R3-9 dock link).
function stripAnsi(s: string): string {
	return s
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\u001b\]\d+;[^\u0007]*\u0007/g, "")
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u0007/g, "");
}
