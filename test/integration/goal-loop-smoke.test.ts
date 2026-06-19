/**
 * Integration smoke test for runGoalLoop (P0).
 *
 * Uses PI_TEAMS_MOCK_CHILD_PI=json-success so the per-turn `executeTeamRun` → child-pi
 * path returns a canned success WITHOUT spawning a real `pi` binary. The stub
 * evaluator (P0) always returns {achieved:false}, so the loop runs to maxTurns
 * and exits with state='max_turns'.
 *
 * Plan: 07-PLAN.md v3 P0 exit criteria #2 (loop runs N turns) + #5 (budget accumulation).
 * Spec: 00-SPEC.md §2.4.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRunManifest } from "../../src/state/state-store.ts";
import { runGoalLoop, stubGoalEvaluator, deriveTranscriptPath } from "../../src/runtime/goal-loop-runner.ts";
import { GoalStore } from "../../src/runtime/goal-state-store.ts";
import { discoverAgents, allAgents } from "../../src/agents/discover-agents.ts";
import type { GoalLoopState } from "../../src/state/types.ts";

test("runGoalLoop (P1 real evaluator) exits blocked when judge is unreachable or worker unavailable", async () => {
	// P1: loop uses realGoalEvaluator (runChildPi judge). Without PI_CREW_ALLOW_MOCK=1,
	// the mock short-circuits with exit 1 → judge returns BLOCKED → loop exits blocked.
	// This verifies the loop's error containment (P0 tested the max_turns path via stub).
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";

	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-loop-smoke-"));
	try {
		const store = new GoalStore(cwd);
		const goalId = store.createGoalId();
		const now = new Date().toISOString();
		const goalState: GoalLoopState = {
			goalId,
			ownerSessionId: "test-session",
			objective: "Trivial smoke-test objective.",
			state: "running",
			maxTurns: 2,
			turnsUsed: 0,
			budgetUsed: 0,
			evaluatorModel: "stub",
			workerAgent: "executor",
			cwd,
			verdicts: [],
			history: [],
			createdAt: now,
			updatedAt: now,
		};
		store.save(goalState);

		// Build the OUTER goal-loop manifest (runKind:"goal-loop").
		const outer = createRunManifest({
			cwd,
			team: {
				name: `goal-${goalId}`,
				description: "smoke outer",
				source: "dynamic",
				filePath: "<smoke>",
				roles: [{ name: "worker", agent: "executor" }],
				workspaceMode: "single",
			},
			workflow: {
				name: "goal-turn",
				description: "smoke turn",
				source: "dynamic",
				filePath: "<smoke>",
				steps: [{ id: "work", role: "worker", task: "Work toward: {goal}" }],
			},
			goal: goalState.objective,
			ownerSessionId: "test-session",
			runKind: "goal-loop",
		});

		const controller = new AbortController();
		const discovered = discoverAgents(cwd);
		const agents = allAgents(discovered);
		// In an empty tmp cwd there are no discoverable agents, so executeTeamRun will throw
		// "Agent 'executor' not found". The loop catches that and marks the goal `blocked`.
		// We assert BOTH outcomes depending on whether the executor agent is available.
		const result = await runGoalLoop({
			goalState,
			manifest: outer.manifest,
			signal: controller.signal,
			deps: { discoverAgents: () => agents },
		});

		const hasExecutor = agents.some((a) => a.name === "executor");
		if (hasExecutor) {
			// Worker ran, but P1 judge mock (json-success) returns non-verdict text → BLOCKED.
			assert.equal(result.goalState.state, "blocked", "P1 mock judge returns non-verdict → BLOCKED");
			assert.ok(result.goalState.turnsUsed >= 1, "at least one turn ran before judging");
			assert.ok(result.goalState.verdicts.length >= 1, "at least one verdict recorded");
			assert.match(result.goalState.verdicts[0].reason, /BLOCKED:/);
		} else {
			// No executor available → loop catches and goes blocked.
			assert.equal(result.goalState.state, "blocked", "loop should go blocked when worker agent is unavailable");
		}
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("stubGoalEvaluator always returns {achieved:false} with a descriptive reason", async () => {
	const goal: GoalLoopState = {
		goalId: "goal_test_stub",
		ownerSessionId: "s",
		objective: "x",
		state: "running",
		maxTurns: 5,
		turnsUsed: 1,
		budgetUsed: 0,
		evaluatorModel: "stub",
		cwd: os.tmpdir(),
		verdicts: [],
		history: [],
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	const verdict = await stubGoalEvaluator(goal, "team_turnrun_123");
	assert.equal(verdict.achieved, false);
	assert.ok(verdict.reason.includes("stub"), "stub reason should identify itself");
	assert.equal(verdict.evaluatorModel, "stub");
	assert.equal(verdict.turn, 1);
});

test("deriveTranscriptPath uses the REAL task id (Fix P0-2 regression — was hardcoded 'work')", () => {
	// Regression for the review finding P0-2: createTaskId prefixes the index,
	// so step "work" → task id "01_work" → transcript "01_work.attempt-0.jsonl".
	// The old code hardcoded "work.attempt-0.jsonl" and always missed the file.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-transcript-"));
	try {
		const transcriptsDir = path.join(cwd, "artifacts", "transcripts");
		fs.mkdirSync(transcriptsDir, { recursive: true });
		const realTaskId = "01_work"; // what createTaskId("work", 0) produces
		fs.writeFileSync(path.join(transcriptsDir, `${realTaskId}.attempt-0.jsonl`), '{"type":"message"}\n');

		const tasks = [{ id: realTaskId }] as never;
		const derived = deriveTranscriptPath(`${cwd}/artifacts`, tasks);
		assert.ok(derived, "transcript path should be derived");
		assert.ok(derived!.includes("01_work"), "must use the real task id, not 'work'");
		assert.ok(fs.existsSync(derived!), "derived path must exist on disk");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
