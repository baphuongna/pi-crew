import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunDashboard, type RunDashboardSelection } from "../../src/ui/run-dashboard.ts";
import type { TeamRunManifest } from "../../src/state/types.ts";

function run(id: string, status: TeamRunManifest["status"]): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: id,
		team: "default",
		workflow: "default",
		goal: "Test goal",
		status,
		workspaceMode: "single",
		createdAt: "2026-04-26T00:00:00.000Z",
		updatedAt: "2026-04-26T00:00:00.000Z",
		cwd: "/tmp/project",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/state/tasks.json",
		eventsPath: "/tmp/state/events.jsonl",
		artifacts: [],
	};
}

test("RunDashboard renders and selects runs", () => {
	let selected: RunDashboardSelection | undefined;
	const dashboard = new RunDashboard([run("team_a", "completed"), run("team_b", "failed")], (selection) => {
		selected = selection;
	});
	const lines = dashboard.render(80);
	assert.ok(lines.some((line) => line.includes("pi-crew dashboard")));
	assert.ok(lines.some((line) => line.includes("Runs: 2")));
	assert.ok(lines.some((line) => line.includes("Selected: team_a")));
	assert.ok(lines.some((line) => line.includes("team_a")));
	dashboard.handleInput("j");
	dashboard.handleInput("\r");
	assert.deepEqual(selected, { runId: "team_b", action: "status" });
});

test("RunDashboard supports phase 5 observability hotkeys", () => {
	let selected: RunDashboardSelection | undefined;
	const dashboard = new RunDashboard([run("team_obs", "running")], (selection) => {
		selected = selection;
	});
	dashboard.handleInput("d");
	assert.deepEqual(selected, { runId: "team_obs", action: "agents" });
	dashboard.handleInput("e");
	assert.deepEqual(selected, { runId: "team_obs", action: "agent-events" });
	dashboard.handleInput("o");
	assert.deepEqual(selected, { runId: "team_obs", action: "agent-output" });
	dashboard.handleInput("v");
	assert.deepEqual(selected, { runId: "team_obs", action: "agent-transcript" });
});

test("RunDashboard renders progress preview", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-progress-"));
	try {
		const progressPath = path.join(tmp, "progress.md");
		fs.writeFileSync(progressPath, "# Progress\nTask counts: completed=1\n", "utf-8");
		const manifest = run("team_progress", "running");
		manifest.artifacts.push({ kind: "progress", path: progressPath, createdAt: "2026-04-26T00:00:00.000Z", producer: "test", retention: "run" });
		const dashboard = new RunDashboard([manifest], () => {});
		const lines = dashboard.render(100);
		assert.ok(lines.some((line) => line.includes("Progress:")));
		assert.ok(lines.some((line) => line.includes("Task counts")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
