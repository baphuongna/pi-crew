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

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { allAgents, discoverAgents } from "../../src/agents/discover-agents.ts";
import { deriveTranscriptPath, runGoalLoop, stubGoalEvaluator } from "../../src/runtime/goal-workflow/goal-loop-runner.ts";
import { GoalStore } from "../../src/runtime/goal-workflow/goal-state-store.ts";
import { createRunManifest } from "../../src/state/stores/state-store.ts";
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
			// GL-1: if the turn ended in blocked/failed manifest status, the loop breaks without
			// calling the judge, so no verdict is recorded. Both outcomes are valid.
			if (result.goalState.verdicts.length >= 1) {
				assert.match(result.goalState.verdicts[0].reason, /BLOCKED:/);
			}
		} else {
			// No executor available → loop catches and goes blocked.
			assert.equal(result.goalState.state, "blocked", "loop should go blocked when worker agent is unavailable");
			// GL-1b (2026-09-22): the failure reason must ALSO live at goal level —
			// turn-run dirs are pruned (keep=10 at session start), which previously
			// made blocked goals undiagnosable after the fact.
			assert.ok(result.goalState.lastTurnError, "blocked goal must persist lastTurnError");
			assert.equal(result.goalState.currentRunId, undefined, "currentRunId must be cleared on terminal failure");
			const events = fs.readFileSync(outer.manifest.eventsPath, "utf-8");
			assert.ok(
				events.includes("goal.loop_error") || events.includes('"reason"'),
				"failure reason must be persisted in the goal event log",
			);
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
	const { verdict } = await stubGoalEvaluator(goal, "team_turnrun_123");
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

test("GL-1b: a failing turn persists its reason at goal level (survives turn-dir pruning)", async () => {
	process.env.PI_TEAMS_MOCK_CHILD_PI = "retryable-failure";
	process.env.PI_CREW_ALLOW_MOCK = "1"; // US-003: let the mock actually fail (parent-env only, per mock-fixtures security model)
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-gl1b-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		// US-003: the goal-turn step dispatches role "worker" — without a worker
		// agent the turn fails at AGENT RESOLUTION (a pre-dispatch config error,
		// correctly NOT deadlettered). Providing the agent routes the turn into the
		// real dispatch → executeWithRetry → mock retryable-failure → exhausted
		// retries — the route the retryable-failure mock was meant to exercise
		// (before this fix the fixture silently failed at resolution instead).
		const agents = [
			...allAgents(discoverAgents(cwd)),
			{
				name: "worker",
				description: "synthetic goal-turn worker",
				source: "builtin" as const,
				filePath: "<synthetic>",
				systemPrompt: "worker",
			},
		];
		const store = new GoalStore(cwd);
		const goalState: GoalLoopState = {
			goalId: store.createGoalId(),
			ownerSessionId: "test-gl1b",
			objective: "make the turn fail",
			state: "running",
			maxTurns: 2,
			turnsUsed: 0,
			budgetUsed: 0,
			evaluatorModel: "stub",
			cwd,
			verdicts: [],
			history: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		store.save(goalState); // patch() loads from disk — goal must exist first
		const outer = createRunManifest({
			cwd,
			team: {
				name: "default",
				description: "",
				source: "builtin",
				filePath: "x",
				roles: [{ name: "executor", agent: "executor" }],
			} as never,
			workflow: {
				name: "default",
				description: "",
				source: "builtin",
				filePath: "x",
				steps: [{ id: "s1", role: "executor", task: "do" }],
			} as never,
			goal: goalState.objective,
			ownerSessionId: "test-gl1b",
			runKind: "goal-loop",
		});
		const controller = new AbortController();
		const result = await runGoalLoop({
			goalState,
			manifest: outer.manifest,
			signal: controller.signal,
			deps: { discoverAgents: () => agents },
		});
		assert.equal(result.goalState.state, "blocked", "failing turn must block the goal");
		// GL-1b: reason persisted at goal level — the turn-run dir carries it in
		// manifest.summary/run.failed, but auto-prune (keep=10) deletes turn dirs
		// at the next session start; without this field blocked goals are
		// undiagnosable after the fact (live incident goal_20260921111305).
		assert.ok(result.goalState.lastTurnError, "failing turn must persist lastTurnError");
		assert.equal(result.goalState.currentRunId, undefined, "currentRunId must be cleared on terminal failure");
		// appendEventBuffered flushes asynchronously — give the buffer a beat.
		await new Promise((r) => setTimeout(r, 200));
		const events = fs.readFileSync(outer.manifest.eventsPath, "utf-8");
		// Either failure route must leave a persisted trace: GL-1 turn-terminal
		// (manifest-level failure) or the outer catch (executeTeamRun threw).
		const traced =
			events.split("\n").find((l) => l.includes("goal.turn_terminal_status") && l.includes('"reason"')) ??
			events.split("\n").find((l) => l.includes("goal.loop_error"));
		assert.ok(traced, "failure reason must reach the goal event log (turn_terminal_status.reason or loop_error)");
		// US-003 (spec integration row): the exhausted-retry failure must ALSO land
		// in BOTH the run-local deadletter.jsonl and the project-level index —
		// the index survives turn-dir pruning (same motivation as GL-1b).
		const deadletterIndexDir = path.join(cwd, ".crew", "state", "deadletter");
		assert.ok(fs.existsSync(deadletterIndexDir), "project dead-letter index dir must exist after exhausted retries");
		const indexFiles = fs.readdirSync(deadletterIndexDir).filter((f) => f.endsWith(".jsonl"));
		assert.ok(indexFiles.length >= 1, "one index file per failing run");
		for (const file of indexFiles) {
			const lines = fs.readFileSync(path.join(deadletterIndexDir, file), "utf-8").split("\n").filter(Boolean);
			assert.ok(lines.length >= 1, `index ${file} must carry at least one entry`);
			for (const line of lines) {
				const parsed = JSON.parse(line) as Record<string, unknown>;
				assert.ok(typeof parsed.taskId === "string", "entry carries taskId");
				assert.ok(typeof parsed.runId === "string", "entry carries runId");
				assert.ok(typeof parsed.timestamp === "string", "entry carries timestamp");
				assert.equal(parsed.reason, "max-retries");
			}
		}
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		delete process.env.PI_CREW_ALLOW_MOCK;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("SR-01 (GL-1b part C): a pre-executeTeamRun throw marks the turn manifest failed, not queued", async () => {
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-sr01-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	try {
		const store = new GoalStore(cwd);
		const goalState: GoalLoopState = {
			goalId: store.createGoalId(),
			ownerSessionId: "test-sr01",
			objective: "force a pre-exec failure",
			state: "running",
			maxTurns: 2,
			turnsUsed: 0,
			budgetUsed: 0,
			evaluatorModel: "stub",
			cwd,
			verdicts: [],
			history: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		store.save(goalState);
		const outer = createRunManifest({
			cwd,
			team: {
				name: "default",
				description: "",
				source: "builtin",
				filePath: "x",
				roles: [{ name: "executor", agent: "executor" }],
			} as never,
			workflow: {
				name: "default",
				description: "",
				source: "builtin",
				filePath: "x",
				steps: [{ id: "s1", role: "executor", task: "do" }],
			} as never,
			goal: goalState.objective,
			ownerSessionId: "test-sr01",
			runKind: "goal-loop",
		});
		const controller = new AbortController();
		const agents = allAgents(discoverAgents(cwd));
		// The seam throws AFTER createRunManifest (turn dir exists) but BEFORE
		// executeTeamRun — the exact SR-01 window that used to leave the turn
		// manifest stuck at "queued".
		const result = await runGoalLoop({
			goalState,
			manifest: outer.manifest,
			signal: controller.signal,
			deps: {
				discoverAgents: () => agents,
				resolveTurnConfig: () => {
					throw new Error("SR-01 simulated config failure");
				},
			},
		});
		assert.equal(result.goalState.state, "blocked", "pre-exec failure must block the goal");
		assert.ok(result.goalState.lastTurnError, "reason must persist at goal level (part B)");

		// The turn manifest must be failed, NOT queued. The turn run is the only
		// run under .crew/state/runs that is NOT the goal-loop run itself.
		const runsRoot = path.join(cwd, ".crew", "state", "runs");
		const turnDirs = fs.readdirSync(runsRoot).filter((d) => d !== outer.manifest.runId && d.startsWith("team_"));
		assert.equal(turnDirs.length, 1, `expected exactly one turn run dir, got ${turnDirs.join(",")}`);
		const turnManifest = JSON.parse(fs.readFileSync(path.join(runsRoot, turnDirs[0]!, "manifest.json"), "utf-8")) as {
			status: string;
			summary?: string;
		};
		assert.equal(turnManifest.status, "failed", "pre-exec throw must mark the turn failed, not queued");
		assert.match(String(turnManifest.summary ?? ""), /pre-execute failure/);
	} finally {
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
