import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { saveCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { readForegroundControlStatus, writeForegroundInterruptRequest } from "../../src/runtime/foreground-control.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function manifest(root: string): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "team_fg",
		team: "default",
		workflow: "default",
		goal: "foreground control",
		status: "running",
		workspaceMode: "single",
		createdAt: "2026-04-26T00:00:00.000Z",
		updatedAt: "2026-04-26T00:00:00.000Z",
		cwd: root,
		stateRoot: path.join(root, ".crew", "state", "runs", "team_fg"),
		artifactsRoot: path.join(root, ".crew", "artifacts", "team_fg"),
		tasksPath: path.join(root, ".crew", "state", "runs", "team_fg", "tasks.json"),
		eventsPath: path.join(root, ".crew", "state", "runs", "team_fg", "events.jsonl"),
		artifacts: [],
	};
}

const task: TeamTaskState = {
	id: "01_execute",
	runId: "team_fg",
	stepId: "01_execute",
	role: "executor",
	agent: "executor",
	title: "Execute",
	status: "running",
	dependsOn: [],
	cwd: "/tmp/project",
};

test("foreground control status and interrupt request are durable", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fg-control-"));
	try {
		const run = manifest(cwd);
		fs.mkdirSync(run.stateRoot, { recursive: true });
		saveCrewAgents(run, [{ id: "team_fg:01_execute", runId: run.runId, taskId: "01_execute", agent: "executor", role: "executor", runtime: "child-process", status: "running", startedAt: run.createdAt }]);
		const status = readForegroundControlStatus(run, [task]);
		assert.equal(status.active, true);
		assert.deepEqual(status.runningTasks, ["01_execute"]);
		assert.deepEqual(status.runningAgents, ["team_fg:01_execute"]);
		const request = writeForegroundInterruptRequest(run, "stop soon");
		assert.equal(request.type, "interrupt");
		assert.equal(request.acknowledged, false);
		const nextStatus = readForegroundControlStatus(run, [task]);
		assert.equal(nextStatus.lastRequest?.id, request.id);
		assert.match(fs.readFileSync(run.eventsPath, "utf-8"), /foreground\.interrupt_requested/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("team api exposes foreground status and interrupt request", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fg-api-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const started = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "foreground api" }, { cwd });
		assert.equal(started.isError, false);
		const runId = started.details.runId!;
		const status = await handleTeamTool({ action: "api", runId, config: { operation: "foreground-status" } }, { cwd });
		const statusPayload = JSON.parse(firstText(status));
		assert.equal(statusPayload.runId, runId);
		assert.ok(statusPayload.controlPath.includes("foreground-control.json"));
		const interrupt = await handleTeamTool({ action: "api", runId, config: { operation: "foreground-interrupt", reason: "phase6 test" } }, { cwd });
		const request = JSON.parse(firstText(interrupt));
		assert.equal(request.type, "interrupt");
		assert.equal(request.reason, "phase6 test");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

