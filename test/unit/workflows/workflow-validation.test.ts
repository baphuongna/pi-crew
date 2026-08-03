import assert from "node:assert/strict";
import test from "node:test";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import { validateWorkflowForTeam } from "../../../src/workflows/validate-workflow.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "test",
	description: "test",
	source: "builtin",
	filePath: "test.team.md",
	roles: [
		{ name: "planner", agent: "planner" },
		{ name: "executor", agent: "executor" },
	],
};

test("valid workflow has no errors", () => {
	const workflow: WorkflowConfig = {
		name: "ok",
		description: "ok",
		source: "builtin",
		filePath: "ok.workflow.md",
		steps: [
			{ id: "plan", role: "planner", task: "plan" },
			{
				id: "execute",
				role: "executor",
				task: "execute",
				dependsOn: ["plan"],
			},
		],
	};
	assert.deepEqual(validateWorkflowForTeam(workflow, team), []);
});

test("workflow validation catches unknown refs and cycles", () => {
	const workflow: WorkflowConfig = {
		name: "bad",
		description: "bad",
		source: "builtin",
		filePath: "bad.workflow.md",
		steps: [
			{ id: "a", role: "missing", task: "a", dependsOn: ["b"] },
			{
				id: "b",
				role: "executor",
				task: "b",
				dependsOn: ["a", "missing-step"],
			},
		],
	};
	const errors = validateWorkflowForTeam(workflow, team).join("\n");
	assert.match(errors, /unknown team role 'missing'/);
	assert.match(errors, /unknown step 'missing-step'/);
	assert.match(errors, /cycle/i);
});
