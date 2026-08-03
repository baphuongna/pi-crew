import assert from "node:assert/strict";
import test from "node:test";
import { buildCompactStatus } from "../../../../src/extension/team-tool/status.ts";

const baseManifest = {
	runId: "team_test_run",
	team: "default",
	workflow: "default",
	status: "running",
	goal: "Fix the bug",
	workspaceMode: "single",
};

test("compact status shows identity, status, goal, and counts only", () => {
	const tasks = [
		{
			id: "01_explore",
			status: "completed",
			role: "explorer",
			agent: "explorer",
		},
		{ id: "02_plan", status: "running", role: "planner", agent: "planner" },
	];
	const counts = new Map([
		["completed", 1],
		["running", 1],
	]);
	const out = buildCompactStatus(baseManifest, tasks, counts);
	const text = out.join("\n");
	assert.match(text, /Run: team_test_run/);
	assert.match(text, /Team: default \(default\)/);
	assert.match(text, /Status: running/);
	assert.match(text, /Goal: Fix the bug/);
	assert.match(text, /Tasks: completed=1, running=1/);
});

test("compact status includes a progress line when progress is provided", () => {
	const out = buildCompactStatus(
		baseManifest,
		[{ id: "01", status: "running", role: "explorer", agent: "explorer" }],
		new Map([["running", 1]]),
		undefined,
		{ overallPercentage: 50, estimatedRemainingMs: 120000 },
	);
	assert.ok(out.some((l) => /Progress: 50%/.test(l)));
	assert.ok(out.some((l) => /2m remaining/.test(l)));
});

test("compact status omits progress line when progress not provided", () => {
	const out = buildCompactStatus(baseManifest, [], new Map());
	assert.ok(!out.some((l) => l.startsWith("Progress:")));
});

test("compact status does NOT include task graph, agents, effectiveness, events", () => {
	const out = buildCompactStatus(baseManifest, [], new Map());
	const text = out.join("\n");
	assert.ok(!text.includes("Task graph:"));
	assert.ok(!text.includes("Active agents:"));
	assert.ok(!text.includes("Effectiveness:"));
	assert.ok(!text.includes("Recent events:"));
});

test("compact status surfaces failed / attention / cancelled tasks under 'Issues'", () => {
	const tasks = [
		{
			id: "01_ok",
			status: "completed",
			role: "explorer",
			agent: "explorer",
		},
		{
			id: "02_bad",
			status: "failed",
			role: "executor",
			agent: "executor",
			error: "syntax error",
		},
		{
			id: "03_attn",
			status: "needs_attention",
			role: "reviewer",
			agent: "reviewer",
			error: "low green",
		},
		{ id: "04_cx", status: "cancelled", role: "writer", agent: "writer" },
	];
	const counts = new Map([
		["completed", 1],
		["failed", 1],
		["needs_attention", 1],
		["cancelled", 1],
	]);
	const out = buildCompactStatus(baseManifest, tasks, counts);
	const text = out.join("\n");
	assert.match(text, /Issues:/);
	assert.match(text, /02_bad \[failed\] executor: syntax error/);
	assert.match(text, /03_attn \[needs_attention\] reviewer: low green/);
	assert.match(text, /04_cx \[cancelled\] writer: \(no error detail\)/);
	// the OK task should NOT be listed in Issues
	assert.ok(!/01_ok/.test(text.split("Issues:")[1] ?? ""));
});

test("compact status has no 'Issues:' section when all tasks healthy", () => {
	const tasks = [
		{
			id: "01_ok",
			status: "completed",
			role: "explorer",
			agent: "explorer",
		},
	];
	const out = buildCompactStatus(baseManifest, tasks, new Map([["completed", 1]]));
	assert.ok(!out.some((l) => l.startsWith("Issues:")));
});

test("compact status ends with a hint to pass details=true for full output", () => {
	const out = buildCompactStatus(baseManifest, [], new Map());
	assert.match(out[out.length - 1], /details=true/);
});

test("compact status includes async liveness line when provided", () => {
	const out = buildCompactStatus(baseManifest, [], new Map(), "Async: pid=123 alive=true detail=ok log=/x.log");
	assert.ok(out.some((l) => l.startsWith("Async: pid=123")));
});

test("compact status counts line is 'none' when map empty", () => {
	const out = buildCompactStatus(baseManifest, [], new Map());
	assert.ok(out.some((l) => l === "Tasks: none"));
});
