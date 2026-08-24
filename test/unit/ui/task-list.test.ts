/**
 * Unit tests for the aboveEditor task list (task-list.ts) — the run's plan
 * painted Claude Code / droid style: a `Plan · done/total` header, one row
 * per task (active first in plan order, then finished), overflow collapsed
 * behind "… +N completed".
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamTaskState } from "../../../src/state/types.ts";
import { buildTaskListLines } from "../../../src/ui/widget/task-list.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

function task(id: string, status: string, title = `Task ${id}`, extra?: Partial<TeamTaskState>): TeamTaskState {
	return { id, status, title, displayName: title, ...extra } as unknown as TeamTaskState;
}

function runWith(tasks: TeamTaskState[], extra?: Partial<WidgetRun["run"]>): WidgetRun[] {
	return [
		{
			run: {
				runId: "team_tasks_test",
				status: "running",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				team: "default",
				workflow: "build",
				...extra,
			} as never,
			agents: [],
			snapshot: { tasks } as never,
		},
	];
}

test("header shows Plan · done/total with active and failed counts", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01_explore", "completed"),
			task("02_plan", "completed"),
			task("03_execute", "running"),
			task("04_verify", "queued"),
			task("05_report", "failed"),
		]),
		120,
	);
	assert.match(lines[0] ?? "", /Plan · 3\/5 done/);
	assert.match(lines[0] ?? "", /1 active/);
	assert.match(lines[0] ?? "", /1 failed/);
});

test("rows paint active tasks first in plan order, then finished", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01_explore", "completed"),
			task("02_plan", "completed"),
			task("03_execute", "running", "wire the overlay"),
			task("04_verify", "queued"),
		]),
		120,
	);
	const joined = lines.join("\n");
	assert.ok(joined.includes("✻ 03_execute · wire the overlay"), "running task row with its title");
	assert.ok(joined.includes("○ 04_verify"), "queued task row");
	assert.ok(joined.includes("✓ 01_explore"), "finished task row");
	// Active section before the finished section.
	assert.ok(joined.indexOf("03_execute") < joined.indexOf("01_explore"), "active precedes finished");
});

test("running task carries its role and indented plan description", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01_explore", "running", "Map the view stack", {
				role: "explorer",
				description: "# Map the view stack\n\nSweep src/ui for the widget stack and list every render entry point.",
			}),
			task("02_plan", "queued", "Design the overlay", {
				role: "planner",
				description: "Pick the overlay approach and write the step bodies.",
			}),
		]),
		120,
	);
	const joined = lines.join("\n");
	assert.ok(joined.includes("✻ 01_explore · explorer — Map the view stack"), "running row shows role then plan title");
	assert.ok(joined.includes("      Sweep src/ui for the widget stack"), "running task gets an indented description line");
	assert.ok(!joined.includes("# Map"), "heading lines are dropped from the detail — the title already carries them");
	assert.ok(!joined.includes("Pick the overlay approach"), "queued tasks stay single-line — no description noise");
});

test("finished tasks collapse behind +N completed", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01", "completed"),
			task("02", "completed"),
			task("03", "completed"),
			task("04", "completed"),
			task("05", "running"),
		]),
		120,
	);
	const joined = lines.join("\n");
	assert.ok(joined.includes("… +2 completed"), "older completions collapse");
	assert.ok(!joined.includes("✓ 03"), "third completion hidden");
	assert.ok(joined.includes("✓ 01") && joined.includes("✓ 02"), "first two completions kept");
});

test("many open tasks collapse behind +N open", () => {
	const lines = buildTaskListLines(runWith(Array.from({ length: 7 }, (_, i) => task(`t${i + 1}`, "queued"))), 120);
	const joined = lines.join("\n");
	assert.ok(joined.includes("… +3 open"), "overflow of open tasks indicated");
	assert.ok(joined.includes("○ t1"), "first open tasks still painted");
});

test("empty when no run carries a tasks slice", () => {
	assert.deepEqual(buildTaskListLines([{ run: {} as never, agents: [] }], 100), [], "no snapshot tasks → no widget lines");
	assert.deepEqual(buildTaskListLines([], 100), [], "no runs → no lines");
});

test("multiple runs label the plan with its run", () => {
	const lines = buildTaskListLines(
		[
			...runWith([task("01", "queued")]),
			{
				run: { runId: "other", status: "running", team: "review", workflow: "audit" } as never,
				agents: [],
				snapshot: { tasks: [task("a1", "running")] } as never,
			},
		],
		120,
	);
	// Primary = first run with unfinished work → default/build is labeled.
	assert.match(lines[0] ?? "", /default\/build/);
});
