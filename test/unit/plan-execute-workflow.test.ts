/**
 * Unit tests for builtin `plan-execute` workflow and the analysis channel.
 * @see workflows/plan-execute.workflow.md
 * @see src/extension/team-tool/run.ts (resolveAnalysisText)
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { allTeams, discoverTeams } from "../../src/teams/discover-teams.ts";
import { discoverWorkflows } from "../../src/workflows/discover-workflows.ts";
import { validateWorkflowForTeam } from "../../src/workflows/validate-workflow.ts";

test("plan-execute workflow is discoverable as builtin", () => {
	const cwd = process.cwd();
	const builtins = discoverWorkflows(cwd).builtin;
	const wf = builtins.find((item) => item.name === "plan-execute");
	assert.ok(wf, "expected builtin workflow 'plan-execute' to be discoverable");
	assert.equal(wf?.topology, "sequential");
	assert.equal(wf?.steps.length, 3);
});

test("plan-execute workflow has correct step shape", () => {
	const wf = discoverWorkflows(process.cwd()).builtin.find((item) => item.name === "plan-execute");
	assert.ok(wf);
	const [planStep, executeStep, verifyStep] = wf!.steps;
	assert.equal(planStep.id, "plan");
	assert.equal(planStep.role, "planner");
	assert.equal(planStep.output, "plan.md");
	assert.deepEqual(planStep.reads, ["analysis.md"]);
	assert.equal(executeStep.role, "executor");
	assert.deepEqual(executeStep.dependsOn, ["plan"]);
	assert.equal(verifyStep.role, "verifier");
	assert.deepEqual(verifyStep.dependsOn, ["execute"]);
	assert.equal(verifyStep.verify, true);
});

test("plan-execute workflow is valid for default team", () => {
	const wf = discoverWorkflows(process.cwd()).builtin.find((item) => item.name === "plan-execute");
	const team = allTeams(discoverTeams(process.cwd())).find((item) => item.name === "default");
	assert.ok(team);
	const errors = validateWorkflowForTeam(wf!, team!);
	assert.deepEqual(errors, []);
});
