import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../src/runtime/crew-agent-records.ts";
import { appendMailboxMessage } from "../../../src/state/coordination/mailbox.ts";
import { createRunManifest, saveRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../src/state/types.ts";
import { RunDashboard, type RunDashboardSelection } from "../../../src/ui/run-dashboard.ts";
import { createRunSnapshotCache } from "../../../src/ui/run-snapshot-cache.ts";

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
	assert.ok(lines.some((line) => line.includes("pi-crew")));
	assert.ok(lines.some((line) => line.includes("2 runs")));
	assert.ok(lines.some((line) => line.includes("team_a") && line.includes("completed")));
	assert.ok(lines.some((line) => line.includes("team_a")));
	dashboard.handleInput("j");
	dashboard.handleInput("\r");
	assert.deepEqual(selected, { runId: "team_b", action: "status" });
});

test("RunDashboard renders a visibly right-sidebar title when requested", () => {
	const dashboard = new RunDashboard([run("team_right", "running")], () => undefined, {}, { placement: "right" });
	const lines = dashboard.render(70);
	assert.ok(lines.some((line) => line.includes("pi-crew")));
	assert.ok(lines.some((line) => line.includes("team_right")));
});

test("RunDashboard emits health and notification actions", () => {
	const selections: RunDashboardSelection[] = [];
	const dashboard = new RunDashboard([run("team_health", "running")], (selection) => {
		if (selection) selections.push(selection);
	});
	dashboard.handleInput("5");
	dashboard.handleInput("R");
	dashboard.handleInput("5");
	dashboard.handleInput("K");
	dashboard.handleInput("5");
	dashboard.handleInput("D");
	dashboard.handleInput("H");
	assert.deepEqual(
		selections.map((selection) => selection.action),
		["health-recovery", "health-kill-stale", "health-diagnostic-export", "notifications-dismiss"],
	);
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
	assert.deepEqual(selected, {
		runId: "team_obs",
		action: "agent-transcript",
	});
});

test("RunDashboard renders compact agent preview", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-agents-"));
	try {
		const manifest = run("team_agents", "running");
		manifest.stateRoot = tmp;
		saveCrewAgents(manifest, [
			{
				id: "team_agents:01",
				runId: "team_agents",
				taskId: "01",
				agent: "executor",
				role: "executor",
				runtime: "child-process",
				status: "running",
				startedAt: "2026-04-26T00:00:00.000Z",
				progress: {
					recentTools: [],
					recentOutput: ["npm test"],
					toolCount: 1,
					currentTool: "bash",
					tokens: 42,
					turns: 2,
					activityState: "active",
				},
			},
		]);
		const dashboard = new RunDashboard([manifest], () => undefined);
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
		fs.writeFileSync(
			manifest.tasksPath,
			JSON.stringify([
				{
					id: "01",
					status: "completed",
					usage: { input: 1000, output: 250, cacheRead: 750 },
					modelAttempts: [
						{
							model: "configured-provider/configured-model",
							success: true,
							exitCode: 0,
						},
					],
				},
			]),
		);
		saveCrewAgents(manifest, [
			{
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
			},
		]);
		const dashboard = new RunDashboard([manifest], () => undefined, {}, { showModel: true, showTokens: true });
		const lines = dashboard.render(140);
		assert.ok(lines.some((line) => line.includes("model=configured-provider/configured-model")));
		assert.ok(lines.some((line) => line.includes("tok=2.0k")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

test("RunDashboard switches live snapshot panes and shows mailbox badges", () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-dashboard-panes-"));
	try {
		fs.mkdirSync(path.join(tmp, ".crew"), { recursive: true });
		const team = {
			name: "pane-team",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "pane-workflow",
			description: "",
			steps: [{ id: "one", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd: tmp,
			team,
			workflow,
			goal: "panes",
		});
		saveRunManifest({ ...created.manifest, status: "running" });
		saveCrewAgents(created.manifest, [
			{
				id: `${created.manifest.runId}:01`,
				runId: created.manifest.runId,
				taskId: created.tasks[0]?.id ?? "one",
				agent: "worker",
				role: "worker",
				runtime: "child-process",
				status: "running",
				startedAt: created.manifest.createdAt,
				progress: {
					recentTools: [],
					recentOutput: ["hello output"],
					toolCount: 1,
					currentTool: "bash",
					activityState: "needs_attention",
				},
			},
		]);
		appendMailboxMessage(created.manifest, {
			direction: "inbox",
			from: "lead",
			to: "worker",
			body: "ping",
		});
		const cache = createRunSnapshotCache(tmp, { ttlMs: 0 });
		const dashboard = new RunDashboard(
			[created.manifest],
			() => undefined,
			{},
			{ snapshotCache: cache, runProvider: () => [created.manifest] },
		);
		dashboard.handleInput("3");
		let lines = dashboard.render(120);
		assert.ok(lines.some((line) => line.includes("Mailbox pane")));
		assert.ok(lines.some((line) => line.includes("inbox unread=1")));
		dashboard.handleInput("4");
		lines = dashboard.render(120);
		assert.ok(lines.some((line) => line.includes("Output pane")));
		assert.ok(lines.some((line) => line.includes("hello output")));
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
		manifest.artifactsRoot = tmp;
		manifest.artifacts.push({
			kind: "progress",
			path: progressPath,
			createdAt: "2026-04-26T00:00:00.000Z",
			producer: "test",
			retention: "run",
		});
		const dashboard = new RunDashboard([manifest], () => undefined);
		const lines = dashboard.render(100);
		assert.ok(lines.some((line) => line.includes("Progress:")));
		assert.ok(lines.some((line) => line.includes("Task counts")));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
