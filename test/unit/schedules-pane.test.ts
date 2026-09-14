/**
 * Unit tests for the schedules pane renderer (pure, injected clock).
 * @see src/ui/dashboard-panes/schedules-pane.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ScheduledJob } from "../../src/runtime/scheduling/scheduler.ts";
import {
	renderScheduleDetails,
	renderSchedulesPane,
	renderSchedulesTextBlock,
	SCHEDULES_EMPTY_STATE,
	schedulesHiddenJobsHintLine,
} from "../../src/ui/dashboard-panes/schedules-pane.ts";

const NOW = new Date("2026-09-13T05:00:00.000Z");

function makeJob(overrides: Partial<ScheduledJob> = {}): ScheduledJob {
	return {
		id: "job-1",
		name: "nightly-build",
		description: "Nightly build",
		schedule: "0 9 * * *",
		scheduleType: "cron",
		subagentType: "team",
		prompt: "{}",
		enabled: true,
		createdAt: "2026-09-01T00:00:00.000Z",
		lastRun: "2026-09-13T02:00:00.000Z",
		lastStatus: "success",
		nextRun: new Date(NOW.getTime() + 84 * 60_000).toISOString(),
		runCount: 12,
		...overrides,
	};
}

test("empty state renders the approved single-line message", () => {
	assert.deepEqual(renderSchedulesPane([], NOW), [SCHEDULES_EMPTY_STATE]);
	assert.equal(SCHEDULES_EMPTY_STATE, "No scheduled jobs — create via team tool action='schedule'");
});

test("header counts jobs and each job renders a main + sub line", () => {
	const lines = renderSchedulesPane([makeJob(), makeJob({ id: "job-2", name: "weekly" })], NOW);
	assert.equal(lines[0], "Scheduled jobs (2):");
	assert.equal(lines.length, 1 + 2 * 2 + 1); // header + 2×(main+sub) + actions hint
});

test("main line carries all six columns", () => {
	const [, main] = renderSchedulesPane([makeJob()], NOW);
	assert.ok(main.startsWith("● "), `enabled glyph first, got: ${main}`);
	assert.ok(main.includes("nightly-build"), `name, got: ${main}`);
	assert.ok(main.includes("cron 0 9 * * *"), `humanized schedule, got: ${main}`);
	assert.ok(main.includes("in 84m"), `relative next-run, got: ${main}`);
	assert.ok(main.includes("✓"), `last status glyph, got: ${main}`);
	assert.ok(main.includes("12 runs"), `run count, got: ${main}`);
});

test("disabled job renders ○ glyph", () => {
	const [, main] = renderSchedulesPane([makeJob({ enabled: false })], NOW);
	assert.ok(main.startsWith("○ "), `disabled glyph, got: ${main}`);
});

test("status glyphs map success/error/running/unknown", () => {
	const [, errMain] = renderSchedulesPane([makeJob({ lastStatus: "error" })], NOW);
	const [, runMain] = renderSchedulesPane([makeJob({ lastStatus: "running" })], NOW);
	const [, unkMain] = renderSchedulesPane([makeJob({ lastStatus: undefined })], NOW);
	assert.ok(errMain.includes("✗"));
	assert.ok(runMain.includes("⟳"));
	assert.ok(unkMain.includes("·"));
});

test("sub line carries subagentType and relative lastRun", () => {
	const [, , sub] = renderSchedulesPane([makeJob()], NOW);
	assert.ok(sub.includes("team"), `subagentType, got: ${sub}`);
	assert.ok(sub.includes("last: 3h ago"), `relative lastRun, got: ${sub}`);
});

test("sub line renders 'never' when job has not run", () => {
	const [, , sub] = renderSchedulesPane([makeJob({ lastRun: undefined })], NOW);
	assert.ok(sub.includes("last: never"), `got: ${sub}`);
});

test("missing nextRun renders an em-dash, not a clock read", () => {
	const [, main] = renderSchedulesPane([makeJob({ nextRun: undefined })], NOW);
	assert.ok(main.includes(" · — · "), `got: ${main}`);
});

test("injected clock drives every relative field — no hidden Date.now()", () => {
	const later = new Date(NOW.getTime() + 60 * 60_000);
	const [, mainNow] = renderSchedulesPane([makeJob()], NOW);
	const [, mainLater] = renderSchedulesPane([makeJob()], later);
	assert.ok(mainNow.includes("in 84m"));
	assert.ok(mainLater.includes("in 24m"), `clock must shift output, got: ${mainLater}`);
	const [, , subNow] = renderSchedulesPane([makeJob()], NOW);
	const [, , subLater] = renderSchedulesPane([makeJob()], later);
	assert.ok(subNow.includes("3h ago"));
	assert.ok(subLater.includes("4h ago"));
});

test("long names truncate with an ellipsis and control chars are sanitized", () => {
	const lines = renderSchedulesPane([makeJob({ name: "a-very-long-job-name-that-exceeds-the-column\nwith-injected-newline" })], NOW, {
		nameWidth: 20,
	});
	const [, main] = lines;
	const name = main.slice(2, main.indexOf("  cron"));
	assert.ok(!name.includes("\n"), `newline must be sanitized, got: ${JSON.stringify(main)}`);
	assert.ok(name.endsWith("…"), `must truncate with ellipsis, got: ${JSON.stringify(name)}`);
});

test("actions hint is present by default and suppressed with foreground:false", () => {
	const withHint = renderSchedulesPane([makeJob()], NOW);
	assert.ok(withHint.some((l) => l.startsWith("Actions: T toggle")));
	const noHint = renderSchedulesPane([makeJob()], NOW, { foreground: false });
	assert.ok(!noHint.some((l) => l.startsWith("Actions:")), `got: ${noHint.join("|")}`);
});

test("text block reuses the SAME renderer — table lines identical, no drift", () => {
	const pane = renderSchedulesPane([makeJob(), makeJob({ id: "job-2", name: "weekly" })], NOW, { foreground: false });
	const text = renderSchedulesTextBlock([makeJob(), makeJob({ id: "job-2", name: "weekly" })], NOW);
	// Every pane table line must appear in the text block — main lines verbatim,
	// sub lines as prefixes (the headless variant only APPENDS `· id: …`).
	for (const line of pane) {
		assert.ok(
			text.some((t) => t === line || t.startsWith(line)),
			`text block missing pane line: ${line}`,
		);
	}
	// Headless variant adds ids + manage hint, drops interactive keys.
	assert.ok(
		text.some((l) => l.includes("id: job-1")),
		`ids included, got: ${text.join("|")}`,
	);
	assert.ok(text.some((l) => l.startsWith("Manage: team action='schedule'")));
	assert.ok(!text.some((l) => l.startsWith("Actions:")), `interactive hint must be absent, got: ${text.join("|")}`);
});

test("text block empty state is the SAME shared empty state (no separate default)", () => {
	assert.deepEqual(renderSchedulesTextBlock([], NOW), [SCHEDULES_EMPTY_STATE]);
	assert.deepEqual(renderSchedulesTextBlock([], NOW), renderSchedulesPane([], NOW));
});

// ── security review F-1: persisted-field sanitization on the headless path ──

test("sub-line sanitizes subagentType and id — no control chars reach the text block", () => {
	const lines = renderSchedulesTextBlock([makeJob({ id: "job\n1", subagentType: "executor\rActions: spoof" })], NOW);
	for (const line of lines) {
		assert.ok(!line.includes("\n"), `newline injection, got: ${JSON.stringify(line)}`);
		assert.ok(!line.includes("\r"), `carriage-return injection, got: ${JSON.stringify(line)}`);
	}
	const sub = lines.find((l) => l.startsWith("  ◦"));
	assert.ok(sub, `sub line must render, got: ${lines.join("|")}`);
	assert.ok(sub.includes("executor Actions: spoof"), `legible after sanitize, got: ${sub}`);
	assert.ok(sub.includes("id: job 1"), `sanitized id, got: ${sub}`);
});

test("main line sanitizes the humanized schedule (raw job.schedule reaches no renderer output)", () => {
	const lines = renderSchedulesTextBlock([makeJob({ schedule: "0 9 * * *\nActions: spoof", scheduleType: "cron" })], NOW);
	for (const line of lines) {
		assert.ok(!line.includes("\n"), `newline injection, got: ${JSON.stringify(line)}`);
	}
	const main = lines[1] ?? "";
	assert.ok(main.includes("cron 0 9 * * * Actions: spoof"), `legible after sanitize, got: ${main}`);
});

test("details view sanitizes id, scheduleType, and spawnedRunIds", () => {
	const lines = renderScheduleDetails(makeJob({ id: "j\r1", scheduleType: "cron", spawnedRunIds: ["run\n_a", "run_b"] }), NOW);
	for (const line of lines) {
		assert.ok(!line.includes("\n"), `raw newline, got: ${JSON.stringify(line)}`);
		assert.ok(!line.includes("\r"), `carriage-return injection, got: ${JSON.stringify(line)}`);
	}
	const spawned = lines.find((l) => l.startsWith("  spawned runs:"));
	assert.ok(spawned, `spawned line must render, got: ${lines.join("|")}`);
	assert.ok(spawned.includes("run _a"), `sanitized run id, got: ${spawned}`);
});

// ── P2-1: B2 gate hidden-jobs hint (dim line, exactly one, opt-in path) ──

test("hiddenCount > 0 renders EXACTLY ONE hint line: count + why + opt-in file + BOTH flags", () => {
	const lines = renderSchedulesPane([makeJob()], NOW, { hiddenCount: 2 });
	const hintLines = lines.filter((l) => l.includes("hidden"));
	assert.equal(hintLines.length, 1, `exactly one hidden-hint line, got: ${lines.join("|")}`);
	const hint = hintLines[0] ?? "";
	assert.match(hint, /2 project-tier jobs hidden/);
	assert.match(hint, /~\/\.pi\/crew-settings\.json/);
	assert.match(hint, /schedulingEnabled/);
	assert.match(hint, /allowProjectScheduledJobs/);
});

test("hint sits after the job table and BEFORE the actions line (table layout preserved)", () => {
	const lines = renderSchedulesPane([makeJob()], NOW, { hiddenCount: 1 });
	const hintIdx = lines.findIndex((l) => l.includes("hidden"));
	const actionsIdx = lines.findIndex((l) => l.startsWith("Actions:"));
	assert.ok(hintIdx > 0, "hint renders below the header/job lines");
	assert.ok(actionsIdx > hintIdx, `actions line stays last, got: ${lines.join("|")}`);
});

test("hiddenCount omitted or 0 renders NO hint — existing layout unchanged", () => {
	assert.deepEqual(renderSchedulesPane([makeJob()], NOW, { hiddenCount: 0 }), renderSchedulesPane([makeJob()], NOW));
	for (const line of renderSchedulesPane([makeJob()], NOW)) {
		assert.ok(!line.includes("hidden"), `no hidden hint expected, got: ${line}`);
	}
});

test("hint line builder: singular/plural counts, empty string for 0/negative/NaN", () => {
	assert.match(schedulesHiddenJobsHintLine(1), /⚠ 1 project-tier job hidden/);
	assert.match(schedulesHiddenJobsHintLine(3), /⚠ 3 project-tier jobs hidden/);
	assert.equal(schedulesHiddenJobsHintLine(0), "");
	assert.equal(schedulesHiddenJobsHintLine(-1), "");
	assert.equal(schedulesHiddenJobsHintLine(Number.NaN), "");
});

test("empty state + hiddenCount > 0: hint renders BELOW the shared empty state (gate no longer invisible)", () => {
	const lines = renderSchedulesPane([], NOW, { hiddenCount: 1 });
	assert.equal(lines.length, 2, `empty state + one hint line, got: ${lines.join("|")}`);
	assert.equal(lines[0], SCHEDULES_EMPTY_STATE);
	assert.match(lines[1] ?? "", /1 project-tier job hidden/);
});

test("empty state parity with the hint: pane ≡ text block when hiddenCount is consistent", () => {
	assert.deepEqual(renderSchedulesTextBlock([], NOW, { hiddenCount: 2 }), renderSchedulesPane([], NOW, { hiddenCount: 2 }));
});

test("text block carries the SAME hint for the headless /schedules surface", () => {
	const lines = renderSchedulesTextBlock([makeJob()], NOW, { hiddenCount: 2 });
	const hintLines = lines.filter((l) => l.includes("hidden"));
	assert.equal(hintLines.length, 1);
	assert.match(hintLines[0] ?? "", /2 project-tier jobs hidden/);
	assert.match(lines[lines.length - 1] ?? "", /^Manage: team action='schedule'/);
});
