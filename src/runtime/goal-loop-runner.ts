/**
 * goal-loop-runner.ts — Autonomous goal-loop coordinator (P0 skeleton; P1 wires real evaluator).
 *
 * Spec: research-findings/goal-workflow/00-SPEC.md §2.4
 * Plan: research-findings/goal-workflow/07-PLAN.md v3
 *   - §0a A2/A3: background-process host; feedback via manifest.goal NOT session.steer
 *   - §0b G1: each turn = createRunManifest({goal: objective + feedback}) + 1-step workflow task:"Work toward: {goal}"
 *   - §0b G2: ONE manifest PER turn (reuse blocked by TEAM_RUN_STATUS_TRANSITIONS); budget via collectRunMetrics
 *   - §0c C2: collectRunMetrics (NOT loadRunMetrics — 0 callers)
 *   - §0c C9: synthesize team (source:"dynamic") — createRunManifest requires team
 *   - §0c C11: cooperative pause/stop via GoalLoopState.state checked between turns
 *
 * Hosts inside the background-runner.ts process (runKind:"goal-loop" arm, P0a).
 * Each turn spawns one executeTeamRun; the loop is the outer coordinator.
 */

import { createRunManifest, saveRunTasks } from "../state/state-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { collectRunMetrics } from "../state/run-metrics.ts";
import { registerActiveRun, unregisterActiveRun } from "../state/active-run-registry.ts";
import { executeTeamRun } from "./team-runner.ts";
import { GoalStore } from "./goal-state-store.ts";
import { evaluateGoal, bundleEvidence } from "./goal-evaluator.ts";
import { existsSync, readdirSync } from "node:fs";
import { logInternalError } from "../utils/internal-error.ts";
import type {
	GoalLoopState,
	GoalLoopStatus,
	GoalVerdict,
	TeamRunManifest,
	TeamTaskState,
} from "../state/types.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { WorkflowConfig } from "../workflows/workflow-config.ts";
import type { AgentConfig } from "../agents/agent-config.ts";

/** Required minimal shape for the worker + agents discovery (P0 uses the goal's workerAgent). */
export interface GoalLoopRuntimeDeps {
	/** Resolve the agent configs reachable from cwd (used for executeTeamRun's agents arg). */
	discoverAgents: (cwd: string) => AgentConfig[];
}

export interface RunGoalLoopInput {
	goalState: GoalLoopState;
	manifest: TeamRunManifest;
	signal: AbortSignal;
	deps: GoalLoopRuntimeDeps;
}

export interface RunGoalLoopResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	goalState: GoalLoopState;
}

/**
 * The placeholder evaluator for P0: always returns {achieved:false}.
 * Kept for unit tests of the loop's max_turns exit path. The production loop
 * uses `realGoalEvaluator` (P1) which calls the LLM judge.
 */
export const stubGoalEvaluator = async (goal: GoalLoopState, _turnRunId: string, _m?: import("../state/types.ts").TeamRunManifest, _t?: import("../state/types.ts").TeamTaskState[], _s?: AbortSignal): Promise<GoalVerdict> => ({
	turn: goal.turnsUsed,
	achieved: false,
	reason: `not-achieved: stub evaluator (P0). Turn ${goal.turnsUsed}/${goal.maxTurns} completed; P1 will judge against objective + verification.`,
	evaluatorModel: "stub",
	evaluatedAt: new Date().toISOString(),
});

export type GoalEvaluatorFn = (
	goal: GoalLoopState,
	turnRunId: string,
	turnManifest: import("../state/types.ts").TeamRunManifest,
	turnTasks: import("../state/types.ts").TeamTaskState[],
	signal: AbortSignal,
) => Promise<GoalVerdict>;

/**
 * Production evaluator (P1): bundles turn evidence + calls the LLM judge.
 * Derives the worker transcript path from the turn's task id (Fix P0-2 — was
 * hardcoded to `work.attempt-0.jsonl`, but createTaskId prefixes the index so the
 * real file is `01_work.attempt-0.jsonl`). If no task is found, scans the transcripts dir.
 */
export const realGoalEvaluator = async (
	goal: GoalLoopState,
	turnRunId: string,
	turnManifest: import("../state/types.ts").TeamRunManifest,
	turnTasks: import("../state/types.ts").TeamTaskState[],
	signal: AbortSignal,
): Promise<GoalVerdict> => {
	const transcriptPath = deriveTranscriptPath(turnManifest.artifactsRoot, turnTasks);
	// Fix round-7 F1: execute verification commands (if configured) so the judge has real evidence.
	// Previously bundleEvidence received `undefined` — the judge was told commands "MUST pass"
	// but had no results, making the acceptance gate a dead letter.
	let verificationResults: import("./goal-evaluator.ts").GoalEvidence["verificationResults"];
	if (goal.verification?.commands?.length) {
		try {
			const { executeVerificationCommands } = await import("./verification-gates.ts");
			const contract = { requiredGreenLevel: "none" as const, commands: goal.verification.commands, allowManualEvidence: goal.verification.allowManualEvidence ?? false };
			const cmdResults = await executeVerificationCommands(contract, goal.cwd, turnRunId, "goal-verify", turnManifest.artifactsRoot, signal);
			verificationResults = cmdResults.map((r) => ({ command: r.cmd, exitCode: r.exitCode ?? null, passed: r.status === "passed" }));
		} catch (error) {
			logInternalError("goal-loop.verification", error, `goalId=${goal.goalId}`);
			verificationResults = [];
		}
	}
	const evidence = bundleEvidence(transcriptPath, verificationResults);
	return evaluateGoal({
		objective: goal.objective,
		scope: goal.scope,
		verification: goal.verification,
		evidence,
		model: goal.evaluatorModel,
		turn: goal.turnsUsed,
		cwd: goal.cwd,
		artifactsRoot: turnManifest.artifactsRoot,
		signal,
	});
};

/** Build the per-turn 1-step workflow (G1): the only step references {goal}. */
function buildTurnWorkflow(): WorkflowConfig {
	return {
		name: "goal-turn",
		description: "Single-step worker turn driven by the autonomous goal loop.",
		source: "dynamic",
		filePath: "<goal-loop>",
		steps: [
			{
				id: "work",
				role: "worker",
				task: "Work toward: {goal}",
			},
		],
	};
}

/**
 * Synthesize a single-role team (§0c C9) — createRunManifest requires a team.
 * Mirrors direct-run.ts but uses source:"dynamic" (not "builtin") per C7/C9.
 */
function buildGoalTeam(goal: GoalLoopState): TeamConfig {
	const workerAgent = goal.workerAgent ?? "executor";
	return {
		name: `goal-${goal.goalId}`,
		description: `Synthetic team for goal loop ${goal.goalId} (worker=${workerAgent}).`,
		source: "dynamic",
		filePath: "<goal-loop>",
		roles: [{ name: "worker", agent: workerAgent, description: `Worker for goal ${goal.goalId}` }],
		workspaceMode: "single",
	};
}

/** Compose manifest.goal = objective + optional feedback (G1). Avoids SYSTEM:/INSTRUCTION: prefixes (§0c C15). */
function composeGoalPrompt(goal: GoalLoopState): string {
	const feedback = goal.nextTurnFeedback?.trim();
	// §0c C15: feedback is composed into manifest.goal which goes through sanitizeTaskText;
	// use a markdown heading (NOT a `SYSTEM:`-style prefix) so it is not stripped.
	return feedback ? `${goal.objective}\n\n## Previous-turn feedback\n${feedback}` : goal.objective;
}

/** Accumulate budget across turns via collectRunMetrics (§0c C2). */
function accumulateBudget(goal: GoalLoopState, turnRunId: string): number {
	try {
		const metrics = collectRunMetrics(goal.cwd, turnRunId);
		if (!metrics) return goal.budgetUsed;
		return goal.budgetUsed + (metrics.totalTokens ?? 0);
	} catch (error) {
		logInternalError("goal-loop.accumulateBudget", error, `turnRunId=${turnRunId}`);
		return goal.budgetUsed;
	}
}

/** Sleep that resolves early when signal aborts or goal is externally paused/stopped. */
async function yieldBetweenTurns(goal: GoalLoopState, signal: AbortSignal, ms = 250): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < ms) {
		if (signal.aborted) return;
		// Cooperative: if a user flipped state to paused/cancelled, stop waiting immediately.
		if (goal.state !== "running") return;
		await new Promise((r) => setTimeout(r, Math.min(50, ms - (Date.now() - start))));
	}
}

/** Fix round-7: re-read disk before applying terminal state. If an external actor
 * (goal stop/pause) already changed the state, don't overwrite — external cancel wins. */
function safeSetStatus(store: GoalStore, goalId: string, proposed: GoalLoopStatus, fallback: GoalLoopState, eventsPath: string): GoalLoopState {
	const current = store.load(goalId);
	if (current && current.state !== "running") {
		// External actor already set a terminal/paused state — respect it.
		return current;
	}
	return store.setStatus(goalId, proposed, eventsPath) ?? { ...fallback, state: proposed };
}

/** Derive the worker transcript path from the turn's tasks (Fix P0-2). Falls back to dir scan.
 *  Exported for unit testing the path-derivation fix. */
export function deriveTranscriptPath(artifactsRoot: string, tasks: import("../state/types.ts").TeamTaskState[]): string | undefined {
	const transcriptsDir = `${artifactsRoot}/transcripts`;
	// Primary: use the first task's id + attempt-0 (task-runner writes ${task.id}.attempt-${i}.jsonl).
	const firstTask = tasks[0];
	if (firstTask) {
		const primary = `${transcriptsDir}/${firstTask.id}.attempt-0.jsonl`;
		if (existsSync(primary)) return primary;
		// Try any attempt for this task.
		try {
			const matches = readdirSync(transcriptsDir).filter((f) => f.startsWith(`${firstTask.id}.attempt-`));
			if (matches.length) return `${transcriptsDir}/${matches.sort().pop()}`;
		} catch { /* dir missing — fall through */ }
	}
	// Fallback: any transcript in the dir (newest).
	try {
		const all = readdirSync(transcriptsDir).filter((f) => f.endsWith(".jsonl"));
		if (all.length) return `${transcriptsDir}/${all.sort().pop()}`;
	} catch (error) {
		logInternalError("goal-loop.deriveTranscriptPath", error, `transcriptsDir=${transcriptsDir}`);
	}
	return undefined;
}

/**
 * Run the autonomous goal loop. Returns {manifest, tasks, goalState} — the OUTER
 * manifest is the synthetic goal-loop manifest (runKind:"goal-loop"); per-turn
 * manifests are recorded in goalState.history[]. Background contract: returns
 * {manifest, tasks} per §0a A2.
 */
export async function runGoalLoop(input: RunGoalLoopInput): Promise<RunGoalLoopResult> {
	const { manifest, signal } = input;
	let goal = input.goalState;
	const store = new GoalStore(goal.cwd);
	const evaluator: GoalEvaluatorFn = realGoalEvaluator; // P1: real LLM judge (P0 used stubGoalEvaluator).
	const eventsPath = manifest.eventsPath;
	const team = buildGoalTeam(goal);
	const workflow = buildTurnWorkflow();
	const agents = input.deps.discoverAgents(goal.cwd);

	appendEvent(eventsPath, { type: "goal.loop_start", runId: manifest.runId, data: { goalId: goal.goalId, objective: goal.objective, maxTurns: goal.maxTurns } });

	try {
		while (goal.state === "running" && goal.turnsUsed < goal.maxTurns) {
			if (signal.aborted) {
				goal = store.setStatus(goal.goalId, "cancelled", eventsPath) ?? { ...goal, state: "cancelled" };
				break;
			}

			// Budget check (§0c C2): abort threshold BEFORE spawning the next turn.
			if (goal.budgetTotal !== undefined && goal.budgetAbort !== undefined) {
				if (goal.budgetUsed / goal.budgetTotal >= goal.budgetAbort) {
					goal = store.setStatus(goal.goalId, "budget_exceeded", eventsPath) ?? { ...goal, state: "budget_exceeded" };
					appendEvent(eventsPath, { type: "goal.budget_warning", runId: manifest.runId, data: { goalId: goal.goalId, budgetUsed: goal.budgetUsed, budgetTotal: goal.budgetTotal, threshold: "abort" } });
					break;
				}
				if (goal.budgetUsed / goal.budgetTotal >= (goal.budgetWarning ?? 0.8)) {
					appendEvent(eventsPath, { type: "goal.budget_warning", runId: manifest.runId, data: { goalId: goal.goalId, budgetUsed: goal.budgetUsed, budgetTotal: goal.budgetTotal, threshold: "warning" } });
				}
			}

			const turnIndex = goal.turnsUsed + 1;
			appendEvent(eventsPath, { type: "goal.turn_start", runId: manifest.runId, data: { goalId: goal.goalId, turn: turnIndex, maxTurns: goal.maxTurns } });

			// ── TURN: fresh manifest per turn (G2) + executeTeamRun ──────────────────
			const turnGoalText = composeGoalPrompt(goal);
			const created = createRunManifest({
				cwd: goal.cwd,
				team,
				workflow,
				goal: turnGoalText,
				workspaceMode: "single",
				ownerSessionId: goal.ownerSessionId,
				runKind: "team-run", // §0a v2 note: turns are normal team-runs; the OUTER loop is goal-loop
			});
			goal = store.patch(goal.goalId, { currentRunId: created.manifest.runId, turnsUsed: turnIndex }, eventsPath) ?? goal;
			// Fix round-6: re-check state AFTER patching (user may have paused/stopped in the inter-turn gap).
			// Without this, a pause that lands between store.patch and executeTeamRun lets one extra turn run.
			if (goal.state !== "running") {
				appendEvent(eventsPath, { type: "goal.loop_end", runId: manifest.runId, data: { goalId: goal.goalId, state: goal.state, reason: "state changed before turn spawn" } });
				break;
			}
			registerActiveRun(created.manifest);
			let turnResult: { manifest: TeamRunManifest; tasks: TeamTaskState[] };
			try {
				turnResult = await executeTeamRun({
					manifest: created.manifest,
					tasks: created.tasks,
					team,
					workflow,
					agents,
					executeWorkers: true,
					workspaceId: goal.ownerSessionId ?? goal.cwd,
					signal,
				});
			} finally {
				unregisterActiveRun(created.manifest.runId);
			}

			// Persist final task states for budget/audit reads.
			try {
				saveRunTasks(turnResult.manifest, turnResult.tasks);
			} catch (error) {
				logInternalError("goal-loop.saveTurnTasks", error, `turnRunId=${created.manifest.runId}`);
			}

			// ── BUDGET accumulation (§0c C2: collectRunMetrics) ──────────────────────
			const updatedBudget = accumulateBudget(goal, created.manifest.runId);

			// ── EVALUATE (P1: real LLM judge; pass turn manifest + tasks for transcript lookup) ──
			const verdict = await evaluator({ ...goal, budgetUsed: updatedBudget }, created.manifest.runId, turnResult.manifest, turnResult.tasks, signal);
			const historyEntry = { runId: created.manifest.runId, outcome: verdict.achieved ? "achieved" : "not-achieved", learnedAt: new Date().toISOString(), turn: turnIndex };
			goal = store.patch(goal.goalId, {
				budgetUsed: updatedBudget,
				verdicts: [...goal.verdicts, verdict],
				history: [...goal.history, historyEntry],
				currentRunId: undefined,
				// G1/A3: feedback feeds turn N+1's prompt via manifest.goal (NOT session.steer)
				nextTurnFeedback: verdict.achieved ? undefined : verdict.reason,
			}, eventsPath) ?? goal;

			appendEvent(eventsPath, { type: "goal.turn_evaluated", runId: manifest.runId, data: { goalId: goal.goalId, turn: turnIndex, achieved: verdict.achieved, reason: verdict.reason } });
			if (!verdict.achieved && goal.nextTurnFeedback) {
				appendEvent(eventsPath, { type: "goal.feedback_steered", runId: manifest.runId, data: { goalId: goal.goalId, turn: turnIndex, feedback: goal.nextTurnFeedback } });
			}

			// ── STOP CONDITIONS (round-7: re-read disk before applying — external cancel/pause wins) ─
			if (verdict.achieved) {
				goal = safeSetStatus(store, goal.goalId, "achieved", goal, eventsPath);
				break;
			}
			if (verdict.reason.startsWith("BLOCKED:")) {
				goal = safeSetStatus(store, goal.goalId, "blocked", goal, eventsPath);
				break;
			}
			if (goal.turnsUsed >= goal.maxTurns) {
				goal = safeSetStatus(store, goal.goalId, "max_turns", goal, eventsPath);
				break;
			}

			await yieldBetweenTurns(goal, signal);
		}

		// Loop exited without explicit terminal (e.g. cancelled via signal mid-yield).
		if (goal.state === "running") {
			goal = safeSetStatus(store, goal.goalId, signal.aborted ? "cancelled" : "max_turns", goal, eventsPath);
		}
	} catch (error) {
		logInternalError("goal-loop.run", error, `goalId=${goal.goalId}`);
		goal = store.setStatus(goal.goalId, "blocked", eventsPath) ?? { ...goal, state: "blocked" };
	} finally {
		appendEvent(eventsPath, { type: "goal.loop_end", runId: manifest.runId, data: { goalId: goal.goalId, state: goal.state, turnsUsed: goal.turnsUsed, budgetUsed: goal.budgetUsed } });
	}

	return { manifest, tasks: [], goalState: goal };
}
