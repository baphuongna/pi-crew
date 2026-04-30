import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../src/teams/discover-teams.ts";
import { serializeTeam } from "../../src/teams/team-serializer.ts";
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

test("workflow parser supports mixed explicit and shorthand steps", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-workflow-mixed-steps-"));
	try {
		const workflowsDir = path.join(cwd, ".crew", "workflows");
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsDir, "mixed.workflow.md"), [
			"---",
			"name: mixed",
			"description: Mixed workflow",
			"---",
			"",
			"## first",
			"role: explorer",
			"",
			"Do first.",
			"",
			"## second",
			"",
			"Do second with default role.",
			"",
		].join("\n"), "utf-8");
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((entry) => entry.name === "mixed");
		assert.equal(workflow?.steps.length, 2);
		assert.equal(workflow?.steps[1]?.id, "second");
		assert.equal(workflow?.steps[1]?.role, "second");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow parser supports shorthand steps before explicit steps and consecutive shorthand steps", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-workflow-more-mixed-"));
	try {
		const workflowsDir = path.join(cwd, ".crew", "workflows");
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsDir, "more-mixed.workflow.md"), [
			"---",
			"name: more-mixed",
			"description: More mixed workflow",
			"---",
			"",
			"## first",
			"",
			"Do first with default role.",
			"",
			"## second",
			"role: reviewer",
			"",
			"Do second.",
			"",
			"## third",
			"",
			"Do third with default role.",
			"",
		].join("\n"), "utf-8");
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((entry) => entry.name === "more-mixed");
		assert.deepEqual(workflow?.steps.map((step) => step.id), ["first", "second", "third"]);
		assert.deepEqual(workflow?.steps.map((step) => step.role), ["first", "reviewer", "third"]);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow parser supports blank lines before explicit step config", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-workflow-blank-config-"));
	try {
		const workflowsDir = path.join(cwd, ".crew", "workflows");
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsDir, "blank-config.workflow.md"), [
			"---",
			"name: blank-config",
			"description: Blank config workflow",
			"---",
			"",
			"## plan",
			"",
			"role: planner",
			"",
			"Plan the work.",
			"",
			"## docs",
			"",
			"Write docs.",
			"",
		].join("\n"), "utf-8");
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((entry) => entry.name === "blank-config");
		assert.deepEqual(workflow?.steps.map((step) => step.id), ["plan", "docs"]);
		assert.equal(workflow?.steps[0]?.role, "planner");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow parser preserves single-token level-two headings inside task bodies", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-workflow-notes-heading-"));
	try {
		const workflowsDir = path.join(cwd, ".crew", "workflows");
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsDir, "notes-heading.workflow.md"), [
			"---",
			"name: notes-heading",
			"description: Notes heading workflow",
			"---",
			"",
			"## write",
			"role: writer",
			"",
			"Intro.",
			"## Notes",
			"Keep notes in body.",
			"",
		].join("\n"), "utf-8");
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((entry) => entry.name === "notes-heading");
		assert.equal(workflow?.steps.length, 1);
		assert.match(workflow?.steps[0]?.task ?? "", /## Notes/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("workflow parser preserves level-two headings inside task bodies", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-workflow-heading-body-"));
	try {
		const workflowsDir = path.join(cwd, ".crew", "workflows");
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(path.join(workflowsDir, "heading-body.workflow.md"), [
			"---",
			"name: heading-body",
			"description: Body heading workflow",
			"---",
			"",
			"## write",
			"role: writer",
			"",
			"Write docs.",
			"## This is a document heading, not a step",
			"Keep this heading in the task body.",
			"",
		].join("\n"), "utf-8");
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((entry) => entry.name === "heading-body");
		assert.equal(workflow?.steps.length, 1);
		assert.match(workflow?.steps[0]?.task ?? "", /## This is a document heading/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("agent config overrides builtin agents case-insensitively and can disable them", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-override-"));
	const previousHome = process.env.PI_TEAMS_HOME;
	try {
		const home = path.join(cwd, "home");
		process.env.PI_TEAMS_HOME = home;
		const configDir = path.join(home, ".pi", "agent", "extensions", "pi-crew");
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
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("team discovery round-trips role metadata", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-team-role-metadata-"));
	try {
		const teamsDir = path.join(cwd, ".crew", "teams");
		fs.mkdirSync(teamsDir, { recursive: true });
		fs.writeFileSync(path.join(teamsDir, "metadata.team.md"), [
			"---",
			"name: metadata-team",
			"description: Metadata team",
			"---",
			"",
			"- executor: agent=executor model=openai/gpt-5 skills=safe-bash,verify-evidence maxConcurrency=2 implement safely",
			"- reviewer: agent=reviewer skills=false review without default skills",
			"",
		].join("\n"), "utf-8");
		const team = allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === "metadata-team");
		assert.equal(team?.roles[0]?.model, "openai/gpt-5");
		assert.deepEqual(team?.roles[0]?.skills, ["safe-bash", "verify-evidence"]);
		assert.equal(team?.roles[0]?.maxConcurrency, 2);
		assert.equal(team?.roles[0]?.description, "implement safely");
		assert.equal(team?.roles[1]?.skills, false);
		fs.writeFileSync(path.join(teamsDir, "colon.team.md"), [
			"---",
			"name: colon-team",
			"description: Colon team",
			"---",
			"",
			"- reviewer: agent=reviewer review API: security and auth",
			"",
		].join("\n"), "utf-8");
		const colonTeam = allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === "colon-team");
		assert.equal(colonTeam?.roles[0]?.description, "review API: security and auth");
		fs.writeFileSync(path.join(teamsDir, "skill-space.team.md"), [
			"---",
			"name: skill-space-team",
			"description: Skill space team",
			"---",
			"",
			"- executor: agent=executor skills=safe-bash, verify-evidence implement",
			"",
		].join("\n"), "utf-8");
		const skillSpaceTeam = allTeams(discoverTeams(cwd)).find((candidate) => candidate.name === "skill-space-team");
		assert.deepEqual(skillSpaceTeam?.roles[0]?.skills, ["safe-bash", "verify-evidence"]);
		assert.equal(skillSpaceTeam?.roles[0]?.description, "implement");
		const serialized = serializeTeam(team!);
		assert.match(serialized, /skills=safe-bash,verify-evidence/);
		assert.match(serialized, /skills=false/);
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
