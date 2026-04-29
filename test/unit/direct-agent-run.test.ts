import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { directTeamAndWorkflowFromRun } from "../../src/runtime/direct-run.ts";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("direct agent run creates a single task for requested agent", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-direct-agent-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const run = await handleTeamTool({ action: "run", agent: "explorer", goal: "Explore directly" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.equal(loaded?.manifest.status, "completed");
		assert.equal(loaded?.manifest.team, "direct-explorer");
		assert.equal(loaded?.manifest.workflow, "direct-agent");
		assert.equal(loaded?.tasks.length, 1);
		assert.equal(loaded?.tasks[0]?.agent, "explorer");
		assert.equal(loaded?.tasks[0]?.status, "completed");
	} finally {
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("direct agent run persists model override for reconstruction", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-direct-agent-model-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const run = await handleTeamTool({ action: "run", agent: "reviewer", goal: "Review with model", model: "openai-codex/gpt-5.5" }, { cwd });
		const loaded = loadRunManifestById(cwd, run.details.runId!);
		assert.equal(loaded?.tasks[0]?.model, "openai-codex/gpt-5.5");
		const direct = directTeamAndWorkflowFromRun(loaded!.manifest, loaded!.tasks, allAgents(discoverAgents(cwd)));
		assert.equal(direct?.workflow.steps[0]?.model, "openai-codex/gpt-5.5");
	} finally {
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("direct reconstruction does not hijack custom direct-prefixed teams", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-direct-prefix-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const reconstructed = directTeamAndWorkflowFromRun({
			schemaVersion: 1,
			runId: "team_test",
			team: "direct-qa",
			workflow: "review",
			goal: "custom direct-prefixed team",
			status: "failed",
			workspaceMode: "single",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd,
			stateRoot: path.join(cwd, ".crew", "state", "runs", "team_test"),
			artifactsRoot: path.join(cwd, ".crew", "artifacts", "team_test"),
			tasksPath: "tasks.json",
			eventsPath: "events.jsonl",
			artifacts: [],
		}, [], allAgents(discoverAgents(cwd)));
		assert.equal(reconstructed, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("direct agent runs can resume from generated team/workflow metadata", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-direct-agent-resume-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "hard-failure";
	try {
		const run = await handleTeamTool({ action: "run", agent: "reviewer", goal: "Review directly" }, { cwd });
		const loaded = loadRunManifestById(cwd, run.details.runId!);
		assert.ok(loaded);
		assert.equal(loaded.manifest.status, "failed");
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
		const resumed = await handleTeamTool({ action: "resume", runId: loaded.manifest.runId }, { cwd });
		assert.equal(resumed.isError, false);
		const after = loadRunManifestById(cwd, loaded.manifest.runId);
		assert.equal(after?.manifest.status, "completed");
		assert.equal(after?.tasks[0]?.agent, "reviewer");
	} finally {
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
