import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { runLiveSessionTask } from "../../src/runtime/live-session-runtime.ts";
import { runLiveTask } from "../../src/runtime/task-runner/live-executor.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

const team: TeamConfig = {
	name: "live-test",
	description: "live test",
	source: "builtin",
	filePath: "live-test.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "live-test",
	description: "live test",
	source: "builtin",
	filePath: "live-test.workflow.md",
	steps: [{ id: "execute", role: "executor", task: "do" }],
};

test("mock live-session suppresses owner callbacks when stale", async () => {
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-session-stale-"));
	const events: unknown[] = [];
	const outputs: string[] = [];
	try {
		const result = await runLiveSessionTask({
			manifest: { runId: "run_stale", stateRoot: path.join(cwd, ".crew", "state", "runs", "run_stale") } as never,
			task: { id: "task_stale", role: "executor", cwd } as never,
			step: { id: "execute", role: "executor", task: "do" } as never,
			agent: { name: "executor", description: "Executor", source: "builtin", filePath: "executor.md", systemPrompt: "Do it" },
			prompt: "do it",
			onEvent: (event) => events.push(event),
			onOutput: (text) => outputs.push(text),
			isCurrent: () => false,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(events.length, 0);
		assert.equal(outputs.length, 0);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("live task production path passes stale owner guard", async () => {
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-task-stale-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "stale live task" });
		const task = { ...tasks[0]!, startedAt: new Date().toISOString() };
		const result = await runLiveTask({
			manifest,
			tasks: [task],
			task,
			step: { id: "execute", role: "executor", task: "do" },
			agent: { name: "executor", description: "Executor", source: "builtin", filePath: "executor.md", systemPrompt: "Do it" },
			prompt: "do it",
			isCurrent: () => false,
		});
		assert.equal(result.exitCode, 0);
		assert.equal(result.task.agentProgress, undefined);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("run can use experimental live-session runtime with durable transcript hooks", async () => {
	const previousEnable = process.env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	process.env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION = "1";
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-session-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "live session smoke", config: { runtime: { mode: "live-session" } } }, { cwd });
		assert.equal(run.isError, false);
		assert.match(firstText(run), /Experimental live-session worker execution was enabled/);
		const runId = run.details.runId!;
		const agentsResult = await handleTeamTool({ action: "api", runId, config: { operation: "list-agents" } }, { cwd });
		const agents = JSON.parse(firstText(agentsResult));
		assert.equal(agents[0].runtime, "live-session");
		assert.equal(agents[0].status, "completed");
		const transcript = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-transcript", agentId: agents[0].taskId } }, { cwd });
		assert.match(firstText(transcript), /Mock live-session success/);
		const liveAgents = await handleTeamTool({ action: "api", runId, config: { operation: "list-live-agents" } }, { cwd });
		assert.match(firstText(liveAgents), /team_/);
		const steer = await handleTeamTool({ action: "api", runId, config: { operation: "steer-agent", agentId: agents[0].taskId, message: "wrap up" } }, { cwd });
		assert.equal(steer.isError, false);
		const sidechainPath = path.join(cwd, ".crew", "state", "runs", runId, "agents", agents[0].taskId, "sidechain.output.jsonl");
		assert.match(fs.readFileSync(sidechainPath, "utf-8"), /"isSidechain":true/);
	} finally {
		restoreEnv("PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION", previousEnable);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

