import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { allTeams, discoverTeams } from "../../src/teams/discover-teams.ts";
import { allWorkflows, discoverWorkflows } from "../../src/workflows/discover-workflows.ts";
import { validateWorkflowForTeam } from "../../src/workflows/validate-workflow.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("implementation workflow delegates fanout decisions to an adaptive planner", () => {
	const cwd = process.cwd();
	const team = allTeams(discoverTeams(cwd)).find((item) => item.name === "implementation");
	const workflow = allWorkflows(discoverWorkflows(cwd)).find((item) => item.name === "implementation");
	assert.ok(team);
	assert.ok(workflow);
	assert.deepEqual(validateWorkflowForTeam(workflow, team), []);
	assert.deepEqual(workflow.steps.map((step) => step.id), ["assess"]);
	assert.match(workflow.steps[0]!.task, /smallest effective number of subagents/i);
	assert.match(workflow.steps[0]!.task, /ADAPTIVE_PLAN_JSON_START/);
});

test("implementation run injects planner-selected multi-agent ready batches", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-implementation-fanout-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "adaptive-plan";
	try {
		const run = await handleTeamTool({ action: "run", team: "implementation", goal: "fanout smoke" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.equal(loaded?.manifest.status, "completed");
		assert.ok(loaded!.tasks.some((task) => task.stepId?.startsWith("adaptive-")), "expected dynamic adaptive tasks to be injected");
		const events = readEvents(loaded!.manifest.eventsPath);
		assert.ok(events.some((event) => event.type === "adaptive.plan_injected"));
		const batchEvents = events.filter((event) => event.type === "task.progress" && typeof event.message === "string" && event.message.includes("Starting ready batch"));
		assert.ok(batchEvents.some((event) => (event.data as { selectedCount?: number } | undefined)?.selectedCount === 3), "expected planner-selected phase with 3 concurrent specialist tasks");
	} finally {
		restoreEnv("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
