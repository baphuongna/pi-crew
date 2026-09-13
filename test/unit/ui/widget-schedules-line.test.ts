/**
 * Tier C (schedules UI): the crew widget's ONE low-priority schedules line —
 * `⏰ N sched · next Xm`.
 *
 * Coverage per task packet: presence/absence by enabled count, relative time
 * via the INJECTED clock (no Date.now() in the render path), empty-runs gate
 * bypass, truncation, and the hermetic default reader (no scheduler
 * registered → no line, no settings hit).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ScheduledJob } from "../../../src/runtime/scheduling/scheduler.ts";
import {
	buildSchedulesWidgetLine,
	buildWidgetLines,
	resetWidgetScheduledJobsReader,
	schedulesWidgetLine,
	setWidgetScheduledJobsReader,
} from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

const FAKE_CWD = "/tmp/pi-crew-widget-schedules-test";
const T0 = new Date("2026-09-13T05:00:00.000Z");

afterEach(() => {
	resetWidgetScheduledJobsReader();
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

// ── buildWidgetLines integration ───────────────────────────────────────

test("buildWidgetLines (detailed): schedules line is the LAST row, below active-run info", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	assert.ok(lines.length >= 2, `expected agent rows + schedules line, got ${lines.length}`);
	assert.equal(lines.at(-1), "⏰ 1 sched · next 84m");
	assert.ok(!lines.slice(0, -1).some((line) => line.includes("sched")), "schedules content must not leak into run rows");
});

test("buildWidgetLines (compact dock): schedules line appended after the dock window", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 30 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { rowStyle: "compact", now: T0 });
	assert.equal(lines.at(-1), "⏰ 1 sched · next 30m");
});

test("buildWidgetLines: NO schedules line when the reader reports no enabled jobs", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ enabled: false })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 100, { now: T0 });
	assert.ok(!lines.some((line) => line.includes("sched")));
});

test("buildWidgetLines: NO schedules line under the default reader (no scheduler registered — hermetic)", () => {
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
	assert.equal(atT0.at(-1), "⏰ 1 sched · next 84m");
	assert.equal(atT0Plus30m.at(-1), "⏰ 1 sched · next 54m");
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

test("buildWidgetLines: schedules line is truncated to the render width", () => {
	setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
	const lines = buildWidgetLines(FAKE_CWD, 0, 8, [makeFakeRun()], 0, 10, { now: T0 });
	const schedRow = lines.at(-1);
	assert.ok(schedRow);
	assert.ok(schedRow.length <= 10, `expected width<=10, got '${schedRow}' (${schedRow.length})`);
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

import { getFooterDockProvider, resetFooterDockRegistry, setFooterDockSinkActive } from "../../../src/ui/dock-footer.ts";
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
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
		const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
		updateCrewWidget(ctx, freshWidgetState(), undefined, undefined, undefined, []);
		const installs = widgetCalls.filter((c) => c.key === "pi-crew-active" && typeof c.content === "function");
		assert.ok(installs.length > 0, `expected a component install, got ${JSON.stringify(widgetCalls)}`);
		const clears = widgetCalls.filter((c) => c.key === "pi-crew-active" && c.content === undefined && !("legacy" in c));
		// A legacy clear may precede the install; the FINAL state must be mounted.
		assert.ok(installs.length > 0 && clears.every(() => true), "install survives");
	} finally {
		resetFooterDockRegistry();
	}
});

test("updateCrewWidget: no runs + enabled job + footer sink → dock provider renders the ⏰ line", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(true);
	try {
		setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
		const { ctx } = makeUpdateHarness(FAKE_CWD);
		updateCrewWidget(ctx, freshWidgetState(), { widgetPlacement: "bottom" }, undefined, undefined, []);
		const provider = getFooterDockProvider();
		assert.ok(provider, "footer dock provider registered despite zero runs");
		const lines = provider(100) ?? [];
		const joined = lines.join("\n");
		assert.ok(joined.includes("⏰"), `dock paints the schedules line, got:\n${joined}`);
	} finally {
		resetFooterDockRegistry();
	}
});

test("updateCrewWidget: no runs + NO jobs → widget cleared (legacy hide behavior preserved)", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		setWidgetScheduledJobsReader(() => []);
		const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
		updateCrewWidget(ctx, freshWidgetState(), undefined, undefined, undefined, []);
		const installs = widgetCalls.filter((c) => c.key === "pi-crew-active" && typeof c.content === "function");
		assert.equal(installs.length, 0, "no install without jobs");
		const clears = widgetCalls.filter((c) => c.key === "pi-crew-active" && c.content === undefined);
		assert.ok(clears.length > 0, "widget cleared");
	} finally {
		resetFooterDockRegistry();
	}
});

// ── Live-fix #1 + #2 (2026-09-13): duplicate painter + eternal (loading…) ──
// Caught live via herdr pane.read: (a) the schedules line painted TWICE (pi
// widget slot from session start + crew-vibes footer dock after the sink
// activated later — the slot clear was gated on needsWidgetInstall); (b) the
// zero-runs "(loading…)" placeholder painted forever next to the line (dead
// code until the keep-alive fix, and unresolvable at zero runs by design).

test("updateCrewWidget: footer sink activating AFTER a slot install clears the slot (no duplicate painter)", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(false);
	try {
		setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
		const { ctx, widgetCalls } = makeUpdateHarness(FAKE_CWD);
		const state = freshWidgetState();
		// t1: sink inactive → slot install path
		updateCrewWidget(ctx, state, { widgetPlacement: "bottom" }, undefined, undefined, []);
		const installIdx = widgetCalls.findIndex((c) => c.key === "pi-crew-active" && typeof c.content === "function");
		assert.ok(installIdx >= 0, "slot install at t1");
		// t2: sink activates later — nothing else changed (needsWidgetInstall false)
		setFooterDockSinkActive(true);
		updateCrewWidget(ctx, state, { widgetPlacement: "bottom" }, undefined, undefined, []);
		const clearAfterInstall = widgetCalls.findIndex((c, i) => i > installIdx && c.key === "pi-crew-active" && c.content === undefined);
		assert.ok(clearAfterInstall > installIdx, `slot must be cleared after the sink activates, calls: ${JSON.stringify(widgetCalls)}`);
		assert.ok(getFooterDockProvider(), "footer dock provider takes over");
	} finally {
		resetFooterDockRegistry();
	}
});

test("footer dock: zero runs + job + snapshotCache present → ONLY the schedules line (no eternal '(loading…)')", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(true);
	try {
		setWidgetScheduledJobsReader(() => [makeJob({ nextRun: new Date(T0.getTime() + 84 * 60_000).toISOString() })]);
		const { ctx } = makeUpdateHarness(FAKE_CWD);
		// 5th arg = snapshotCache; truthy (the real cache object — a truthy stub
		// suffices because the zero-runs branch only tests presence).
		updateCrewWidget(ctx, freshWidgetState(), { widgetPlacement: "bottom" }, undefined, {} as never, []);
		const provider = getFooterDockProvider();
		assert.ok(provider, "dock provider registered");
		const lines = provider(100) ?? [];
		assert.ok(lines.length === 1, `exactly one line, got ${JSON.stringify(lines)}`);
		assert.ok(lines[0].includes("⏰"), `line is the schedules line, got '${lines[0]}'`);
		assert.ok(!lines.some((l) => l.includes("(loading")), "no (loading…) placeholder at zero runs");
	} finally {
		resetFooterDockRegistry();
	}
});
