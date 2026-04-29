import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../src/teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../src/workflows/discover-workflows.ts";

test("builtin resources are discoverable", () => {
	const cwd = process.cwd();
	assert.equal(allAgents(discoverAgents(cwd)).length, 10);
	assert.equal(allTeams(discoverTeams(cwd)).length, 6);
	assert.equal(allWorkflows(discoverWorkflows(cwd)).length, 6);
});

test("workflow frontmatter can set maxConcurrency", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-workflow-concurrency-"));
	try {
		const workflowsDir = path.join(cwd, ".crew", "workflows");
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsDir, "workflow-max-concurrency.workflow.md"), [
			"---",
			"name: workflow-max-concurrency",
			"description: Custom test workflow",
			"maxConcurrency: 7",
			"---",
			"",
			"## do-work",
			"role: planner",
			"",
			"Complete the task.",
			"",
		].join("\n"), "utf-8");
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((entry) => entry.name === "workflow-max-concurrency");
		assert.equal(workflow?.maxConcurrency, 7);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent config overrides builtin agents case-insensitively and can disable them", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-override-"));
	try {
		const configDir = path.join(cwd, ".crew");
		fs.mkdirSync(configDir, { recursive: true });
		fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
			agents: {
				overrides: {
					EXECUTOR: { model: "local/executor", tools: ["read"], disabled: false },
					writer: { disabled: true },
				},
			},
		}), "utf-8");
		const discovery = discoverAgents(cwd);
		const executor = allAgents(discovery).find((agent) => agent.name === "executor");
		assert.equal(executor?.model, "local/executor");
		assert.deepEqual(executor?.tools, ["read"]);
		assert.equal(executor?.override?.source, "config");
		assert.equal(allAgents(discovery).some((agent) => agent.name === "writer"), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("team discovery supports git URL source in frontmatter", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-team-git-source-"));
	try {
		const teamsDir = path.join(cwd, ".crew", "teams");
		fs.mkdirSync(teamsDir, { recursive: true });
		fs.writeFileSync(path.join(teamsDir, "remote.team.md"), [
			"---",
			"name: remote-team",
			"description: Remote team from git",
			"source: git+https://github.com/org/teams-repo.git#main",
			"---",
			"",
			"- explorer: agent=explorer",
			"",
		].join("\n"), "utf-8");
		const team = allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === "remote-team");
		assert.equal(team?.source, "git");
		assert.equal(team?.sourceUrl, "https://github.com/org/teams-repo.git");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
