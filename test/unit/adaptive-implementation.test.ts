import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { __test__parseAdaptivePlan, __test__repairAdaptivePlan, executeTeamRun } from "../../src/runtime/team-runner.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/state-store.ts";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";
import { allTeams, discoverTeams } from "../../src/teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../src/workflows/discover-workflows.ts";
import { readEvents } from "../../src/state/event-log.ts";

const roles = ["explorer", "analyst", "planner", "critic", "executor", "reviewer", "security-reviewer", "test-engineer", "verifier", "writer"];

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("adaptive plan parser uses planner-selected phases instead of fixed fanout", () => {
	const text = `Rationale\nADAPTIVE_PLAN_JSON_START\n{"phases":[{"name":"research","tasks":[{"role":"explorer","task":"Inspect UI"},{"role":"analyst","task":"Analyze risks"}]},{"name":"build","tasks":[{"role":"executor","task":"Implement smallest fix"}]},{"name":"check","tasks":[{"role":"reviewer","task":"Review"},{"role":"test-engineer","task":"Run tests"},{"role":"writer","task":"Summarize"}]}]}\nADAPTIVE_PLAN_JSON_END`;
	const plan = __test__parseAdaptivePlan(text, roles);
	assert.equal(plan?.phases.length, 3);
	assert.deepEqual(plan?.phases.map((phase) => phase.tasks.length), [2, 1, 3]);
	assert.deepEqual(plan?.phases.flatMap((phase) => phase.tasks.map((task) => task.role)), ["explorer", "analyst", "executor", "reviewer", "test-engineer", "writer"]);
});

test("adaptive plan parser rejects partial or oversized invalid plans", () => {
	assert.equal(__test__parseAdaptivePlan(`ADAPTIVE_PLAN_JSON_START\n{"phases":[{"name":"bad","tasks":[{"role":"unknown","task":"x"}]}]}\nADAPTIVE_PLAN_JSON_END`, roles), undefined);
	assert.equal(__test__parseAdaptivePlan(`ADAPTIVE_PLAN_JSON_START\n{"phases":[{"name":"bad","tasks":[{"role":"executor","task":""}]}]}\nADAPTIVE_PLAN_JSON_END`, roles), undefined);
	const tooMany = { phases: [{ name: "too-many", tasks: Array.from({ length: 13 }, () => ({ role: "executor", task: "x" })) }] };
	assert.equal(__test__parseAdaptivePlan(`ADAPTIVE_PLAN_JSON_START\n${JSON.stringify(tooMany)}\nADAPTIVE_PLAN_JSON_END`, roles), undefined);
});

test("adaptive plan repair recovers malformed, oversized, and aliased-role plans", () => {
	const malformed = __test__repairAdaptivePlan(`ADAPTIVE_PLAN_JSON_START\n{"phases":[{"name":"build","tasks":[{"role":"executor","task":"Implement"}]}]\nADAPTIVE_PLAN_JSON_END`, roles);
	assert.ok(malformed.plan);
	assert.equal(malformed.plan.phases[0]!.tasks[0]!.role, "executor");

	const oversized = { phases: [{ name: "many", tasks: Array.from({ length: 15 }, (_, index) => ({ role: "executor", task: `Task ${index}` })) }] };
	const trimmed = __test__repairAdaptivePlan(`ADAPTIVE_PLAN_JSON_START\n${JSON.stringify(oversized)}\nADAPTIVE_PLAN_JSON_END`, roles);
	assert.equal(trimmed.plan?.phases[0]!.tasks.length, 12);

	const aliased = __test__repairAdaptivePlan(`ADAPTIVE_PLAN_JSON_START\n${JSON.stringify({ phases: [{ name: "review", tasks: [{ role: "code-review", task: "Review" }, { role: "mystery", task: "Skip me" }] }] })}\nADAPTIVE_PLAN_JSON_END`, roles);
	assert.equal(aliased.plan?.phases[0]!.tasks.length, 1);
	assert.equal(aliased.plan?.phases[0]!.tasks[0]!.role, "reviewer");
});

test("adaptive implementation workflow is planner-assessed, not a fixed specialist template", () => {
	const workflow = fs.readFileSync(path.join(process.cwd(), "workflows", "implementation.workflow.md"), "utf-8");
	assert.match(workflow, /## assess/);
	assert.match(workflow, /ADAPTIVE_PLAN_JSON_START/);
	assert.doesNotMatch(workflow, /## risk-review/);
	assert.doesNotMatch(workflow, /## security-review\n/);
});

test("implementation blocks when planner output has no valid adaptive plan", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-invalid-adaptive-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const run = await handleTeamTool({ action: "run", team: "implementation", goal: "invalid adaptive smoke" }, { cwd });
		assert.equal(run.isError, false);
		const loaded = loadRunManifestById(cwd, run.details.runId!);
		assert.equal(loaded?.manifest.status, "blocked");
		assert.ok(readEvents(loaded!.manifest.eventsPath).some((event) => event.type === "adaptive.plan_missing"));
	} finally {
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("implementation blocks when completed assess artifact is unreadable", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-missing-adaptive-artifact-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const team = allTeams(discoverTeams(cwd)).find((item) => item.name === "implementation")!;
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((item) => item.name === "implementation")!;
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "missing artifact" });
		const persistedTasks = tasks.map((task) => ({ ...task, status: "completed" as const, finishedAt: new Date().toISOString(), resultArtifact: { kind: "result" as const, path: path.join(cwd, "missing.txt"), createdAt: new Date().toISOString(), producer: task.id, retention: "run" as const } }));
		saveRunTasks(manifest, persistedTasks);
		const result = await executeTeamRun({ manifest, tasks: persistedTasks, team, workflow, agents: allAgents(discoverAgents(cwd)), executeWorkers: true, runtime: { kind: "child-process", requestedMode: "child-process", available: true, steer: false, resume: false, liveToolActivity: false, transcript: true } });
		assert.equal(result.manifest.status, "blocked");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("adaptive workflow steps reconstruct from persisted tasks on resume", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-adaptive-resume-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		const team = allTeams(discoverTeams(cwd)).find((item) => item.name === "implementation")!;
		const workflow = allWorkflows(discoverWorkflows(cwd)).find((item) => item.name === "implementation")!;
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "resume adaptive" });
		const persistedTasks = [...tasks.map((task) => ({ ...task, status: "completed" as const, resultArtifact: { kind: "result" as const, path: path.join(cwd, "assess.txt"), createdAt: new Date().toISOString(), producer: task.id, retention: "run" as const } })), {
			id: "adaptive-01-executor",
			runId: manifest.runId,
			stepId: "adaptive-1-1-executor",
			role: "executor",
			agent: "executor",
			title: "resume executor",
			status: "queued" as const,
			dependsOn: [tasks[0]!.id],
			cwd,
			adaptive: { phase: "build", task: "Resume adaptive executor task" },
			graph: { taskId: "adaptive-01-executor", dependencies: [tasks[0]!.id], children: [], queue: "ready" as const },
		}];
		fs.writeFileSync(path.join(cwd, "assess.txt"), "stale plan", "utf-8");
		saveRunTasks(manifest, persistedTasks);
		const result = await executeTeamRun({ manifest, tasks: persistedTasks, team, workflow, agents: allAgents(discoverAgents(cwd)), executeWorkers: true, runtime: { kind: "child-process", requestedMode: "child-process", available: true, steer: false, resume: false, liveToolActivity: false, transcript: true } });
		assert.equal(result.manifest.status, "completed");
		const completed = result.tasks.find((task) => task.id === "adaptive-01-executor");
		assert.equal(completed?.status, "completed");
		assert.deepEqual(completed?.adaptive, { phase: "build", task: "Resume adaptive executor task" });
	} finally {
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
