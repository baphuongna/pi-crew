import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runTeamTask, type SpawnBudget } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

/**
 * CORE-3 — per-task spawn budget cap.
 *
 * Tests that the model fallback loop in runTeamTask respects the spawnBudget:
 * when total spawns exceed `max`, the loop breaks even if more model
 * candidates remain. Uses the mock child pi ("retryable-failure") so every
 * model attempt fails with a retryable error, forcing the loop to try each
 * candidate. With 3 candidates but a budget of 2, only 2 spawns should occur.
 */

const team = {
	name: "t",
	description: "",
	source: "project",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} satisfies TeamConfig;
const workflow = {
	name: "w",
	description: "",
	source: "project",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "budget test", model: "x" }],
} satisfies WorkflowConfig;
const agent = {
	name: "a",
	description: "",
	source: "project",
	filePath: "a",
	systemPrompt: "test",
	tools: ["read"],
	extensions: [],
	systemPromptMode: "append",
	inheritProjectContext: false,
	inheritSkills: false,
} satisfies AgentConfig;

/** 3-model registry → buildConfiguredModelRouting produces 3 candidates. */
const modelRegistry = {
	getAvailable: () => [
		{ provider: "test", id: "m1" },
		{ provider: "test", id: "m2" },
		{ provider: "test", id: "m3" },
	],
};

function withMockEnv<T>(fn: () => Promise<T>): Promise<T> {
	const prevExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	const prevCrewRole = process.env.PI_CREW_ROLE;
	const prevTeamsRole = process.env.PI_TEAMS_ROLE;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "retryable-failure";
	delete process.env.PI_CREW_ROLE;
	delete process.env.PI_TEAMS_ROLE;
	return fn().finally(() => {
		if (prevExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = prevExecute;
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllowMock;
		if (prevCrewRole === undefined) delete process.env.PI_CREW_ROLE;
		else process.env.PI_CREW_ROLE = prevCrewRole;
		if (prevTeamsRole === undefined) delete process.env.PI_TEAMS_ROLE;
		else process.env.PI_TEAMS_ROLE = prevTeamsRole;
	});
}

test("CORE-3: spawn budget caps model fallback spawns at max", async () => {
	const cwd = createTrackedTempDir("pi-crew-spawn-budget-");
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		await withMockEnv(async () => {
			const created = createRunManifest({ cwd, team, workflow, goal: "budget cap" });
			const task = created.tasks[0]!;
			const spawnBudget: SpawnBudget = { count: 0, max: 2 };

			const result = await runTeamTask({
				manifest: created.manifest,
				tasks: created.tasks,
				task,
				step: workflow.steps[0]!,
				agent,
				executeWorkers: true,
				runtimeKind: "child-process",
				workspaceId: cwd,
				modelOverride: "x",
				modelRegistry,
				spawnBudget,
			});

			const resultTask = result.tasks.find((t) => t.id === task.id);
			assert.ok(resultTask?.modelAttempts, "task must have modelAttempts");
			// Budget max=2 → loop breaks before 3rd spawn. modelAttempts records
			// only actual spawns (2), not the break attempt.
			assert.equal(
				resultTask!.modelAttempts!.length,
				2,
				`expected 2 attempts (budget=2), got ${resultTask!.modelAttempts!.length}: ${JSON.stringify(resultTask!.modelAttempts)}`,
			);
			// Counter was incremented 3 times (2 spawns + 1 overflow detection).
			assert.equal(spawnBudget.count, 3, `spawn counter should be 3 after 2 spawns + 1 overflow`);
			// Budget max should have been auto-computed from attemptModels (3 × 4 = 12)
			// before being overridden... actually no: max was explicitly set to 2.
			assert.equal(spawnBudget.max, 2, "max should remain at explicit value 2");
			// All attempts should be failures (mock always fails).
			assert.ok(
				resultTask!.modelAttempts!.every((a) => !a.success),
				"all attempts should be failures with retryable-failure mock",
			);
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("CORE-3: generous budget allows all model fallback spawns", async () => {
	const cwd = createTrackedTempDir("pi-crew-spawn-budget-gen-");
	fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
	try {
		await withMockEnv(async () => {
			const created = createRunManifest({ cwd, team, workflow, goal: "generous budget" });
			const task = created.tasks[0]!;
			// max=0 → auto-computes as 3 models × (3+1) = 12 in task-runner.ts.
			const spawnBudget: SpawnBudget = { count: 0, max: 0 };

			const result = await runTeamTask({
				manifest: created.manifest,
				tasks: created.tasks,
				task,
				step: workflow.steps[0]!,
				agent,
				executeWorkers: true,
				runtimeKind: "child-process",
				workspaceId: cwd,
				modelOverride: "x",
				modelRegistry,
				spawnBudget,
			});

			const resultTask = result.tasks.find((t) => t.id === task.id);
			assert.ok(resultTask?.modelAttempts, "task must have modelAttempts");
			// With auto-computed budget (12), all 3 candidates should be tried.
			assert.equal(
				resultTask!.modelAttempts!.length,
				3,
				`expected 3 attempts (all candidates), got ${resultTask!.modelAttempts!.length}`,
			);
			// Budget should have been auto-computed: 3 models × (3+1) = 12
			assert.equal(spawnBudget.max, 12, `auto-computed max should be 12, got ${spawnBudget.max}`);
			// 3 spawns → counter = 3 (no overflow)
			assert.equal(spawnBudget.count, 3, `counter should be 3 after 3 spawns`);
		});
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
