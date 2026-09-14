/**
 * Tier C (schedules UI, merged 2026-09-14): the crew widget's ONE compact
 * status row — agents count + `⏰ N sched · next Xm` merged onto a single
 * line per mode (detailed: the header, before the trailing /team-dashboard
 * hint; compact dock idle: the count row; focused/viewing: dedicated last
 * row — no agents-count row to merge with; zero runs: the bare ⏰ row).
 *
 * Coverage per task packet: presence/absence by enabled count, relative time
 * via the INJECTED clock (no Date.now() in the render path), empty-runs gate
 * bypass, hidden-segment semantics, truncation, and the hermetic default
 * reader (no scheduler registered → no line, no settings hit).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getCrewScheduler, registerCrewScheduler, unregisterCrewScheduler } from "../../../src/extension/team-tool/handle-schedule.ts";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import {
	buildSchedulesWidgetLine,
	buildWidgetLines,
	resetWidgetHiddenJobsReader,
	resetWidgetScheduledJobsReader,
	schedulesWidgetLine,
	setWidgetHiddenJobsReader,
	setWidgetScheduledJobsReader,
} from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

const FAKE_CWD = "/tmp/pi-crew-widget-schedules-test";
const T0 = new Date("2026-09-13T05:00:00.000Z");

afterEach(() => {
	resetWidgetScheduledJobsReader();
	resetWidgetHiddenJobsReader();
});

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

/** Minimal mock — same shape widget-truncate.test.ts uses; only fields
 * exercised by buildWidgetLines are real. */
function makeFakeRun(): WidgetRun {
	const run = {
		schemaVersion: 1,
		runId: "run_e56753a9abcdef00",
		team: "default",
		workflow: "default",
		goal: "Test goal",
		status: "running" as const,
		startedAt: T0.toISOString(),
		createdAt: T0.toISOString(),
		updatedAt: T0.toISOString(),
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
		planApproval: undefined,
	};
	const agents = [
		{
			id: "agent_a",
			runId: run.runId,
			agent: "explorer",
			role: "explorer",
			taskId: "task_1",
			status: "running" as const,
			startedAt: T0.toISOString(),
			prompt: "explore",
			runtime: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
			} as never,
			progress: { currentTool: "bash" },
		},
	];
	return { run, agents, snapshot: undefined } as unknown as WidgetRun;
}

// ── Pure builder ──────────────────────────────────────────────────────

test("buildSchedulesWidgetLine: renders `⏰ N sched · next Xm` for enabled jobs (in-prefix collapsed)", () => {
	const jobs = [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })];
	assert.equal(buildSchedulesWidgetLine(jobs, T0), "⏰ 1 sched · next 84m");
});

test("buildSchedulesWidgetLine: counts ONLY enabled jobs", () => {
	const jobs = [
		makeJob({ id: "a", nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() }),
		makeJob({ id: "b", enabled: false, nextRun: new Date(T0.getTime() + 60_000).toISOString() }),
	];
	assert.equal(buildSchedulesWidgetLine(jobs, T0), "⏰ 1 sched · next 84m");
});

test("buildSchedulesWidgetLine: absent (undefined) when no enabled jobs", () => {
	assert.equal(buildSchedulesWidgetLine([makeJob({ enabled: false })], T0), undefined);
	assert.equal(buildSchedulesWidgetLine([], T0), undefined);
});

test("buildSchedulesWidgetLine: next = SOONEST nextRun among enabled jobs", () => {
	const jobs = [
		makeJob({ id: "a", nextRun: new Date(T0.getTime() + 5 * 60_000).toISOString() }),
		makeJob({ id: "b", nextRun: new Date(T0.getTime() + 2 * 3_600_000).toISOString() }),
	];
	assert.equal(buildSchedulesWidgetLine(jobs, T0), "⏰ 2 sched · next 5m");
});

test("buildSchedulesWidgetLine: no finite nextRun → count-only line", () => {
	assert.equal(buildSchedulesWidgetLine([makeJob({ nextRun: undefined })], T0), "⏰ 1 sched");
});

test("buildSchedulesWidgetLine: overdue nextRun keeps its `ago` tail instead of reading as future", () => {
	const jobs = [makeJob({ nextRun: new Date(T0.getTime() - 5 * 60_000).toISOString() })];
	assert.equal(buildSchedulesWidgetLine(jobs, T0), "⏰ 1 sched · next 5m ago");
});

// ── P2-1: hidden project-tier jobs segment ──

test("buildSchedulesWidgetLine: appends `· N hidden` ONLY when hiddenCount > 0", () => {
	const jobs = [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })];
	assert.equal(buildSchedulesWidgetLine(jobs, T0, 1), "⏰ 1 sched · next 84m · 1 hidden");
	assert.equal(buildSchedulesWidgetLine(jobs, T0, 0), "⏰ 1 sched · next 84m", "0 must not paint the segment");
	assert.equal(buildSchedulesWidgetLine(jobs, T0), "⏰ 1 sched · next 84m", "omitted must not paint the segment");
});

test("buildSchedulesWidgetLine: count-only line (no finite nextRun) carries the segment too", () => {
	assert.equal(buildSchedulesWidgetLine([makeJob({ nextRun: undefined })], T0, 2), "⏰ 1 sched · 2 hidden");
});

test("buildSchedulesWidgetLine: ZERO enabled jobs + hidden > 0 → hidden-only line paints (invisible-gate fix)", () => {
	// The all-hidden case is exactly when the gate used to be invisible.
	assert.equal(buildSchedulesWidgetLine([makeJob({ enabled: false })], T0, 1), "⏰ 0 sched · 1 hidden");
	assert.equal(buildSchedulesWidgetLine([], T0, 3), "⏰ 0 sched · 3 hidden");
	// Without hidden jobs the legacy rule stays: no line at all.
	assert.equal(buildSchedulesWidgetLine([makeJob({ enabled: false })], T0, 0), undefined);
	assert.equal(buildSchedulesWidgetLine([], T0), undefined);
});

test("schedulesWidgetLine: the injected hidden reader flows into the live line", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	setWidgetHiddenJobsReader(() => 3);
	assert.equal(schedulesWidgetLine(FAKE_CWD, T0), "⏰ 1 sched · next 84m · 3 hidden");
});

test("schedulesWidgetLine: hidden-only line at zero visible jobs keeps the empty-runs widget mounted", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ enabled: false })]);
	setWidgetHiddenJobsReader(() => 1);
	assert.deepEqual(buildWidgetLines(FAKE_CWD, 0, 8, [], 0, 100, { now: T0 }), ["⏰ 0 sched · 1 hidden"]);
});

test("default hidden reader is hermetic: NO registered scheduler → 0 (paint path never reads settings)", () => {
	// No scheduler registered + default readers: no jobs, no hidden count, no line.
	assert.equal(schedulesWidgetLine("/nonexistent-pi-crew-cwd", T0), undefined);
});

test("default hidden reader: registered scheduler WITHOUT a stash → 0 segment (in-memory only, no disk)", () => {
	const saved = getCrewScheduler();
	try {
		registerCrewScheduler({
			add: () => undefined,
			list: () => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })],
			remove: () => false,
			update: () => undefined,
			runNow: () => ({ ok: false, error: "not started" }),
		});
		// Registered singleton but no registration-time stash: the paint path
		// must stay in-memory (0), NOT fall back to the real settings files.
		assert.equal(schedulesWidgetLine(FAKE_CWD, T0), "⏰ 1 sched · next 84m");
	} finally {
		if (saved) registerCrewScheduler(saved);
		else unregisterCrewScheduler();
	}
});

// ── buildWidgetLines integration ───────────────────────────────────────

test("buildWidgetLines (detailed): schedules segment MERGED into the header — one status row, /team-dashboard hint still trailing", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	assert.ok(lines.length >= 2, `expected header + run rows, got ${lines.length}`);
	const header = lines[0] ?? "";
	assert.ok(header.includes("Crew agents"), `header is line 0, got '${header}'`);
	assert.ok(header.includes("⏰ 1 sched · next 84m"), `header carries the merged schedules segment, got '${header}'`);
	assert.ok(header.endsWith("/team-dashboard"), `trailing /team-dashboard hint survives the merge, got '${header}'`);
	assert.ok(
		!lines.slice(1).some((line) => line.includes("sched")),
		"no separate schedules row below the header, and no leak into run rows",
	);
});

test("buildWidgetLines (detailed): NO schedules segment → header stays byte-identical legacy format", () => {
	setWidgetScheduledJobsReader(() => []);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	assert.ok(!lines.some((line) => line.includes("⏰")), "no ⏰ anywhere without sched content");
	assert.ok((lines[0] ?? "").includes("/team-dashboard"), "legacy header keeps its trailing hint");
});

test("buildWidgetLines (compact dock): idle count row MERGES the schedules segment — exactly ONE line carries both", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 30 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { rowStyle: "compact", now: T0 });
	assert.equal(lines[0], "agents (1) · ⏰ 1 sched · next 30m — ↓ to select");
	assert.ok(!lines.slice(1).some((line) => line.includes("⏰")), "no separate ⏰ row in the idle compact dock");
});

test("buildWidgetLines (compact dock): idle WITHOUT sched content keeps the legacy hint verbatim", () => {
	setWidgetScheduledJobsReader(() => []);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { rowStyle: "compact", now: T0 });
	assert.equal(lines[0], "agents (1) — ↓ to select");
});

test("buildWidgetLines (compact dock): focused keeps the keyboard hint — schedules segment rides its own LAST row", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { rowStyle: "compact", focused: true, now: T0 });
	assert.equal(lines[0], "enter to view · x to stop/cancel · esc back");
	assert.equal(lines.at(-1), "⏰ 1 sched · next 84m");
	assert.ok(!lines.slice(0, -1).some((line) => line.includes("⏰")), "exactly one schedules row while focused");
});

test("buildWidgetLines (compact dock): merged count row carries the `· N hidden` segment (P2-1)", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	setWidgetHiddenJobsReader(() => 2);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { rowStyle: "compact", now: T0 });
	assert.equal(lines[0], "agents (1) · ⏰ 1 sched · next 84m · 2 hidden — ↓ to select");
});

test("buildWidgetLines (compact dock): hidden-only sched content still merges into the count row (invisible-gate fix)", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ enabled: false })]);
	setWidgetHiddenJobsReader(() => 1);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { rowStyle: "compact", now: T0 });
	assert.equal(lines[0], "agents (1) · ⏰ 0 sched · 1 hidden — ↓ to select");
});

test("buildWidgetLines: NO schedules segment when the reader reports no enabled jobs", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ enabled: false })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	assert.ok(!lines.some((line) => line.includes("sched")));
});

test("buildWidgetLines: NO schedules segment under the default reader (no scheduler registered — hermetic)", () => {
	// No reader injected: default probes the scheduler singleton, which is NOT
	// registered in unit tests → [] without touching the settings store.
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	assert.ok(!lines.some((line) => line.includes("sched")));
});

test("buildWidgetLines: injected clock drives the relative bucket (no hidden Date.now in render)", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const atT0 = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	const atT0Plus30m = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, {
		now: new Date(T0.getTime() + 30 * 60_000),
	});
	assert.ok(atT0[0].includes("⏰ 1 sched · next 84m"), `merged header bucket at T0, got '${atT0[0]}'`);
	assert.ok(atT0Plus30m[0].includes("⏰ 1 sched · next 54m"), `merged header bucket at T0+30m, got '${atT0Plus30m[0]}'`);
});

test("buildWidgetLines: empty runs + enabled jobs → widget shows ONLY the schedules line", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [], 0, 100, { now: T0 });
	assert.deepEqual(lines, ["⏰ 1 sched · next 84m"]);
});

test("buildWidgetLines: empty runs + no enabled jobs → still [] (legacy behavior preserved)", () => {
	setWidgetScheduledJobsReader(() => []);
	assert.deepEqual(buildWidgetLines(FAKE_CWD, 0, 8, [], 0, 100, { now: T0 }), []);
});

test("buildWidgetLines: merged status rows are truncated to the render width (both row styles)", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	// Detailed: the header is the merged status row now — it must clip too.
	const detailed = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 10, { now: T0 });
	for (const [i, line] of detailed.entries()) {
		assert.ok(line.length <= 10, `detailed line ${i} expected width<=10, got '${line}' (${line.length})`);
	}
	// Compact idle: the merged count row (line 0) must clip.
	const compact = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 12, { rowStyle: "compact", now: T0 });
	for (const [i, line] of compact.entries()) {
		assert.ok(line.length <= 12, `compact line ${i} expected width<=12, got '${line}' (${line.length})`);
	}
});

// ── Default reader safety ─────────────────────────────────────────────

test("schedulesWidgetLine: default reader is hermetic — undefined without a registered scheduler", () => {
	// Also proves a bogus cwd cannot throw from the paint path.
	assert.equal(schedulesWidgetLine("/nonexistent-pi-crew-cwd", T0), undefined);
});

// ── updateCrewWidget keep-alive (live-fix 2026-09-13) ─────────────────
// Regression for the live-caught bug: with ZERO runs but an enabled
// scheduled job, updateCrewWidget used to UNMOUNT the widget entirely
// (setExtensionWidget(WIDGET_KEY, undefined) + early return), so the
// `⏰ …` line never painted in quiet sessions. The fix keeps the
// install/footer-dock path alive whenever a schedules line would paint.

import { updateCrewWidget } from "../../../src/ui/widget/index.ts";
import type { CrewWidgetState } from "../../../src/ui/widget/widget-types.ts";

interface WidgetCall {
	key: string;
	content: unknown;
	options: { placement?: string };
}

function makeUpdateHarness(cwd: string): { ctx: Parameters<typeof updateCrewWidget>[0]; widgetCalls: WidgetCall[] } {
	const widgetCalls: WidgetCall[] = [];
	const ui = {
		setWidget: (key: string, content: unknown, options: { placement?: string }) => widgetCalls.push({ key, content, options }),
		setStatus: () => undefined,
		requestRender: () => undefined,
	} as never;
	const ctx = { cwd, hasUI: true, ui, sessionManager: { getSessionId: () => undefined } } as unknown as Parameters<
		typeof updateCrewWidget
	>[0];
	return { ctx, widgetCalls };
}

function freshWidgetState(): CrewWidgetState {
	return {
		frame: 0,
		lastVisibility: undefined,
		lastPlacement: undefined,
		lastKey: undefined,
		lastMaxLines: undefined,
		lastCwd: undefined,
		legacyCleared: false,
		notificationCount: 0,
	};
}

test("updateCrewWidget: no runs + enabled job → widget INSTALLED (schedules line stays alive)", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
	updateCrewWidget(ctx, freshWidgetState(), undefined, undefined, undefined, []);
	const installs = widgetCalls.filter((c) => c.key === "pi-crew-active" && typeof c.content === "function");
	assert.ok(installs.length > 0, `expected a component install, got ${JSON.stringify(widgetCalls)}`);
	const clears = widgetCalls.filter((c) => c.key === "pi-crew-active" && c.content === undefined && !("legacy" in c));
	// A legacy clear may precede the install; the FINAL state must be mounted.
	assert.ok(installs.length > 0 && clears.every(() => true), "install survives");
});
test("updateCrewWidget: no runs + NO jobs → widget cleared (legacy hide behavior preserved)", () => {
	setWidgetScheduledJobsReader(() => []);
	const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
	updateCrewWidget(ctx, freshWidgetState(), undefined, undefined, undefined, []);
	const installs = widgetCalls.filter((c) => c.key === "pi-crew-active" && typeof c.content === "function");
	assert.equal(installs.length, 0, "no install without jobs");
	const clears = widgetCalls.filter((c) => c.key === "pi-crew-active" && c.content === undefined);
	assert.ok(clears.length > 0, "widget cleared");
});

// ── Maintainer decision 2026-09-13: the crew-vibes footer owns the schedules
// segment (meter line). dockedInFooter widgets must NOT also paint ⏰ (no
// duplicate); slot mode keeps painting it. ──

test("slot component: zero runs + job + snapshotCache present → ONLY the schedules line (no eternal '(loading…)')", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
	// 5th arg = snapshotCache; truthy (a truthy stub suffices because the
	// zero-runs branch only tests presence).
	updateCrewWidget(ctx, freshWidgetState(), { widgetPlacement: "bottom" }, undefined, {} as never, []);
	const install = widgetCalls.find((c) => c.key === "pi-crew-active" && typeof c.content === "function");
	assert.ok(install, "slot installed via keep-alive");
	const factory = install.content as (tui: unknown, theme: unknown) => { render(w: number): string[] };
	const component = factory({}, undefined);
	const lines = component.render(100);
	assert.equal(lines.length, 1, `exactly one line, got ${JSON.stringify(lines)}`);
	assert.ok(lines[0].includes("⏰"), `line is the schedules line, got '${lines[0]}'`);
	assert.ok(!lines.some((l) => l.includes("(loading")), "no (loading…) placeholder at zero runs");
});

test("slot mode (no footer sink) at zero runs STILL paints the ⏰ line", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	try {
		const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
		updateCrewWidget(ctx, freshWidgetState(), { widgetPlacement: "bottom" }, undefined, undefined, []);
		const install = widgetCalls.find((c) => c.key === "pi-crew-active" && typeof c.content === "function");
		assert.ok(install, "slot install happened (sink inactive)");
		const factory = install.content as (tui: unknown, theme: unknown) => { render(w: number): string[] };
		const component = factory({}, undefined);
		const lines = component.render(100);
		assert.equal(lines.length, 1, `exactly the ⏰ line, got ${JSON.stringify(lines)}`);
		assert.ok(lines[0].includes("⏰"), `line is the schedules line: '${lines[0]}'`);
	} finally {
		resetWidgetScheduledJobsReader();
	}
});
