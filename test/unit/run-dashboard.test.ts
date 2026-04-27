import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { RunDashboard, type RunDashboardSelection } from "../../src/ui/run-dashboard.ts";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
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

test("RunDashboard renders compact agent preview", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-agents-"));
	try {
		const manifest = run("team_agents", "running");
		manifest.stateRoot = tmp;
		saveCrewAgents(manifest, [{
			id: "team_agents:01",
			runId: "team_agents",
			taskId: "01",
			agent: "executor",
			role: "executor",
			runtime: "child-process",
			status: "running",
			startedAt: "2026-04-26T00:00:00.000Z",
			progress: { recentTools: [], recentOutput: ["npm test"], toolCount: 1, currentTool: "bash", tokens: 42, turns: 2, activityState: "active" },
		}]);
		const dashboard = new RunDashboard([manifest], () => {});
		const lines = dashboard.render(120);
		assert.ok(lines.some((line) => line.includes("Agents:")));
		assert.ok(lines.some((line) => line.includes("executor->executor")));
		assert.ok(lines.some((line) => line.includes("tool=bash")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("RunDashboard renders model and token details from task state", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-usage-"));
	try {
		const manifest = run("team_usage", "completed");
		manifest.stateRoot = tmp;
		manifest.tasksPath = path.join(tmp, "tasks.json");
		fs.writeFileSync(manifest.tasksPath, JSON.stringify([{ id: "01", status: "completed", usage: { input: 1000, output: 250, cacheRead: 750 }, modelAttempts: [{ model: "configured-provider/configured-model", success: true, exitCode: 0 }] }]));
		saveCrewAgents(manifest, [{
			id: "team_usage:01",
			runId: "team_usage",
			taskId: "01",
			agent: "verifier",
			role: "verifier",
			runtime: "child-process",
			status: "completed",
			startedAt: "2026-04-26T00:00:00.000Z",
			completedAt: "2026-04-26T00:00:05.000Z",
			progress: { recentTools: [], recentOutput: [], toolCount: 0 },
		}]);
		const dashboard = new RunDashboard([manifest], () => {}, {}, { showModel: true, showTokens: true });
		const lines = dashboard.render(140);
		assert.ok(lines.some((line) => line.includes("model=configured-provider/configured-model")));
		assert.ok(lines.some((line) => line.includes("tok=2.0k")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
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
