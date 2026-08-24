/**
 * Unit tests for the aboveEditor task list (task-list.ts) — the run's plan
 * painted pi-tasks / Claude Code style: a `● N tasks (…)` header, one row
 * per task in plan order with task numbers (#1, #2, …), strikethrough for
 * completed rows, spinner + elapsed + tokens for the running row, and
 * `› blocked by #n` for queued tasks waiting on dependencies.
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

test("header counts tasks pi-tasks style", () => {
	const lines = buildTaskListLines(
		runWith([task("01", "completed"), task("02", "completed"), task("03", "running"), task("04", "queued"), task("05", "failed")]),
		120,
	);
	assert.match(lines[0] ?? "", /● 5 tasks \(2 done, 1 failed, 1 in progress, 1 open\)/);
});

test("rows stay in plan order, numbered #1..#n behind status glyphs", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01_design", "completed", "Design the flux capacitor"),
			task("02_acquire", "running", "Acquire plutonium"),
			task("03_install", "queued", "Install flux capacitor"),
		]),
		120,
	);
	assert.match(lines[1] ?? "", /#1 Design the flux capacitor/);
	assert.match(lines[2] ?? "", /#2 Acquire plutonium/);
	assert.match(lines[3] ?? "", /#3 Install flux capacitor/);
	// Plan order: the completed row paints before the running one.
	assert.ok((lines[1] ?? "").includes("#1"), "completed #1 still first — plan order, not active-first");
});

test("completed rows are dimmed and struck through", () => {
	const lines = buildTaskListLines(runWith([task("01", "completed", "Design the flux capacitor")]), 120);
	const row = lines[1] ?? "";
	assert.ok(row.includes("✔"), "completed glyph");
	assert.ok(row.includes("\x1b[9m"), "strikethrough SGR");
	assert.ok(row.includes("\x1b[2m"), "dim SGR");
	assert.ok(!row.includes("✓ 01"), "no legacy id-style row");
});

test("running row carries spinner, elapsed time and token counts", () => {
	const started = new Date(Date.now() - 169_000).toISOString();
	const lines = buildTaskListLines(
		runWith([
			task("01", "running", "Acquire plutonium", {
				startedAt: started,
				usage: { input: 4_100, output: 1_200 },
			}),
		]),
		120,
	);
	const row = lines[1] ?? "";
	assert.match(row, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] #1 Acquire plutonium/, "spinner glyph then number then title");
	assert.match(row, /\(2m 49s · ↑ 4\.1k ↓ 1\.2k\)/, "elapsed + token pair suffix");
});

test("running row falls back to live agentProgress token total", () => {
	const started = new Date(Date.now() - 45_000).toISOString();
	const lines = buildTaskListLines(
		runWith([task("01", "running", "Sweep the sources", { startedAt: started, agentProgress: { tokens: 918 } as never })]),
		120,
	);
	assert.match(lines[1] ?? "", /\(45s · 918\)/);
});

test("queued rows name open dependencies by task number", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01_map", "completed", "Map the codebase"),
			task("02_wire", "running", "Wire the overlay scroll"),
			task("03_test", "queued", "Run the suite", { dependsOn: ["01_map", "02_wire"] }),
			task("04_report", "queued", "Report the result"),
		]),
		120,
	);
	const row = lines[3] ?? "";
	assert.match(row, /#3 Run the suite › blocked by #2/, "only the open dep is listed, by number");
	assert.ok(!(lines[4] ?? "").includes("blocked by"), "unblocked queued rows carry no suffix");
});

test("plan rows never mention roles or agents", () => {
	const lines = buildTaskListLines(
		runWith([
			task("01_explore", "running", "Map the view stack", {
				role: "explorer",
				agent: "code-explorer",
				description: "# Map the view stack\n\nSweep src/ui for the widget stack.",
			}),
			task("02_plan", "queued", "Design the overlay", { role: "planner", description: "Pick the overlay approach." }),
		]),
		120,
	);
	const joined = lines.join("\n");
	assert.ok(!joined.includes("explorer") && !joined.includes("planner"), "no role names");
	assert.ok(!joined.includes("code-explorer"), "no agent names");
	assert.ok(!joined.includes("Sweep src/ui"), "no description lines — one row per task, pi-tasks style");
});

test("overflow collapses behind … and N more", () => {
	const lines = buildTaskListLines(runWith(Array.from({ length: 15 }, (_, i) => task(`t${i + 1}`, "queued"))), 120);
	const joined = lines.join("\n");
	assert.ok(joined.includes("… and 5 more"), "overflow count");
	assert.ok((lines[1] ?? "").includes("#1"), "first rows kept");
	assert.ok(!joined.includes("#11 "), "rows past the cap hidden");
});

test("unfinished work survives the row cap", () => {
	const tasks = Array.from({ length: 12 }, (_, i) => task(`t${i + 1}`, "completed", `Step ${i + 1}`));
	tasks.push(task("t13", "running", "Final verification"));
	const lines = buildTaskListLines(runWith(tasks), 120);
	const joined = lines.join("\n");
	assert.ok(joined.includes("#13 Final verification"), "active task stays visible past the cap");
	assert.ok(joined.includes("… and 3 more"), "finished rows gave way instead");
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
