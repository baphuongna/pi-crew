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
