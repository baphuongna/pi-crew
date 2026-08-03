/**
 * Unit tests for buildGoalTeam (goal-loop-runner.ts).
 *
 * Regression: previously the synthetic team's role list was `[{name:"worker",
 * agent:workerAgent}]`. The adaptive planner in implementation workflows
 * emits plans with role names matching the agent config (e.g. "executor").
 * `parseAdaptivePlan` rejected every plan because role "executor" was not
 * in allowedRoles=["worker"]. As a result goal-wrapped implementation
 * workflows ran only the assess task and never executed the planned
 * executor/verifier tasks.
 *
 * Fix: use workerAgent as the role NAME so adaptive plans with matching
 * role names are accepted.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildGoalTeam } from "../../src/runtime/goal-workflow/goal-loop-runner.ts";

function fakeGoal(workerAgent: string): Parameters<typeof buildGoalTeam>[0] {
	return {
		goalId: "goal_test_xxx",
		ownerSessionId: "sess",
		objective: "test",
		state: "running",
		maxTurns: 1,
		turnsUsed: 0,
		budgetUnlimited: true,
		budgetWarning: 0.8,
		budgetAbort: 0.95,
		budgetUsed: 0,
		verification: { commands: ["npm test"] },
		evaluatorModel: "minimax/MiniMax-M3",
		workerAgent,
		cwd: "/tmp",
		verdicts: [],
		history: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		goalWrapWorkflow: "implementation",
	} as never;
}

test("buildGoalTeam: role NAME equals workerAgent so adaptive plans with matching role names are accepted", () => {
	const team = buildGoalTeam(fakeGoal("executor"));
	assert.equal(team.roles.length, 1);
	assert.equal(
		team.roles[0]?.name,
		"executor",
		"role name MUST match workerAgent so parseAdaptivePlan accepts plans with role='executor'",
	);
	assert.equal(team.roles[0]?.agent, "executor");
});

test("buildGoalTeam: custom workerAgent is used verbatim (e.g. 'reviewer')", () => {
	const team = buildGoalTeam(fakeGoal("reviewer"));
	assert.equal(team.roles[0]?.name, "reviewer");
});

test("buildGoalTeam: defaults to 'executor' when workerAgent is undefined", () => {
	const goal = fakeGoal("executor");
	(goal as { workerAgent: string | undefined }).workerAgent = undefined;
	const team = buildGoalTeam(goal);
	assert.equal(team.roles[0]?.name, "executor");
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal team-name pattern in test description
test("buildGoalTeam: team name follows goal-${goalId} convention", () => {
	const team = buildGoalTeam(fakeGoal("executor"));
	assert.match(team.name, /^goal-goal_test_xxx$/);
});

test("buildGoalTeam: source is 'dynamic' so it doesn't conflict with builtin teams", () => {
	const team = buildGoalTeam(fakeGoal("executor"));
	assert.equal(team.source, "dynamic");
});
