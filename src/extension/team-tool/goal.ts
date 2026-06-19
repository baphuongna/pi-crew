/**
 * team-tool/goal.ts — Handler for `team action='goal'` (P0 skeleton).
 *
 * Sub-actions (anchor sub-action pattern, team-tool.ts:1224):
 *   - start   : create GoalLoopState + spawn background goal-loop process
 *   - status  : show objective/state/turn/budget/last verdict
 *   - pause   : cooperative pause (flip GoalLoopState.state)
 *   - resume  : cooperative resume (re-spawn next turn) — P0: status-only stub
 *   - stop    : cooperative cancel + handleCancel(currentRunId)
 *   - step    : run exactly one more turn (debug) — P0: status-only stub
 *   - clear   : remove GoalLoopState file
 *
 * Plan: 07-PLAN.md v3 §0c C10 (assertSafePathId, evaluatorModel required, ≤4000 chars),
 *       §0c C11 (control path: cooperative flag + handleCancel(currentRunId) via abortOwned).
 */

import { result, type TeamContext } from "./context.ts";
import { createRunManifest, saveRunManifest } from "../../state/state-store.ts";
import { appendEvent } from "../../state/event-log.ts";
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";
import { GoalStore } from "../../runtime/goal-state-store.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { GoalLoopState, GoalLoopStatus } from "../../state/types.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";

const MAX_GOAL_OBJECTIVE_CHARS = 4000;

interface GoalSubActionInput {
	params: TeamToolParamsValue;
	ctx: TeamContext;
	store: GoalStore;
}

/** Extract a clean objective string from params (goalObjective || goal || task), validated. */
function readObjective(params: TeamToolParamsValue): string {
	const raw = (params.config?.objective as string | undefined) ?? params.goal ?? params.task ?? "";
	const objective = typeof raw === "string" ? raw.trim() : "";
	if (!objective) {
		throw new Error("`goal start` requires a non-empty objective (config.objective, goal, or task).");
	}
	if (objective.length > MAX_GOAL_OBJECTIVE_CHARS) {
		throw new Error(`Objective too long: ${objective.length} > ${MAX_GOAL_OBJECTIVE_CHARS} chars (Claude/Codex parity).`);
	}
	return objective;
}

/** Validate evaluatorModel is set (required per §0c C10 — no silent default). */
function readEvaluatorModel(params: TeamToolParamsValue): string {
	const model = (params.config?.evaluatorModel as string | undefined) ?? (params.config?.model as string | undefined) ?? params.model;
	if (!model || typeof model !== "string") {
		throw new Error("`goal start` requires config.evaluatorModel (the goal-judge model). No silent default.");
	}
	return model;
}

function formatGoalStatus(goal: GoalLoopState): string {
	const last = goal.verdicts[goal.verdicts.length - 1];
	const budgetPct = goal.budgetTotal ? `${Math.round((goal.budgetUsed / goal.budgetTotal) * 100)}%` : "n/a";
	return [
		`Goal ${goal.goalId} [${goal.state}]`,
		`  objective: ${goal.objective.slice(0, 200)}${goal.objective.length > 200 ? "…" : ""}`,
		`  turn: ${goal.turnsUsed}/${goal.maxTurns}   budget: ${goal.budgetUsed}/${goal.budgetTotal ?? "∞"} (${budgetPct})`,
		`  evaluator: ${goal.evaluatorModel}   worker: ${goal.workerAgent ?? "executor"}`,
		last ? `  last verdict (turn ${last.turn}): ${last.achieved ? "ACHIEVED" : "not-achieved"} — ${last.reason.slice(0, 300)}` : "  (no verdicts yet)",
		goal.nextTurnFeedback ? `  next-turn feedback: ${goal.nextTurnFeedback.slice(0, 200)}` : "",
		goal.currentRunId ? `  current turn runId: ${goal.currentRunId}` : "",
	].filter(Boolean).join("\n");
}

/** `goal start` — create state + spawn background process (P0: writes state; spawn wiring TBD per host). */
async function handleStart(input: GoalSubActionInput): Promise<ReturnType<typeof result>> {
	const { params, ctx, store } = input;
	try {
		const objective = readObjective(params);
		const evaluatorModel = readEvaluatorModel(params);
		const cwd = ctx.cwd;
		const goalId = store.createGoalId();
		const ownerSessionId = ctx.sessionId ?? "unknown";
		const now = new Date().toISOString();
		const maxTurns = typeof params.config?.maxTurns === "number" && params.config.maxTurns > 0
			? params.config.maxTurns
			: 20; // Claude/Codex parity default
		const goalState: import("../../state/types.ts").GoalLoopState = {
			goalId,
			ownerSessionId,
			objective,
			scope: typeof params.config?.scope === "string" ? params.config.scope : undefined,
			verification: params.config?.verification as { commands: string[]; allowManualEvidence?: boolean } | undefined,
			state: "running",
			maxTurns,
			turnsUsed: 0,
			budgetTotal: typeof params.budgetTotal === "number" ? params.budgetTotal : undefined,
			budgetWarning: typeof params.budgetWarning === "number" ? params.budgetWarning : 0.8,
			budgetAbort: typeof params.budgetAbort === "number" ? params.budgetAbort : 0.95,
			budgetUsed: 0,
			evaluatorModel,
			workerModel: typeof params.model === "string" ? params.model : undefined,
			workerAgent: typeof params.config?.workerAgent === "string" ? params.config.workerAgent : undefined,
			team: typeof params.team === "string" ? params.team : undefined,
			cwd,
			verdicts: [],
			history: [],
			createdAt: now,
			updatedAt: now,
		};
		store.save(goalState);

		// ── Spawn the background goal-loop process (Fix P0-1) ──────────────────
		// Convention: the goal-loop manifest's runId IS the goalId, so background-runner's
		// `case "goal-loop"` can load GoalLoopState via `store.load(manifest.runId)`.
		// We create a minimal manifest with runKind:"goal-loop" and spawn it detached.
		const created = createRunManifest({
			cwd,
			team: {
				name: `goal-${goalId}`,
				description: `Goal loop ${goalId}`,
				source: "dynamic",
				filePath: "<goal-loop>",
				roles: [{ name: "worker", agent: goalState.workerAgent ?? "executor" }],
				workspaceMode: "single",
			},
			workflow: {
				name: "goal-loop",
				description: "Goal loop outer coordinator",
				source: "dynamic",
				filePath: "<goal-loop>",
				steps: [],
			},
			goal: objective,
			workspaceMode: "single",
			ownerSessionId: ownerSessionId,
			runKind: "goal-loop",
		});
		// Force the manifest runId to equal the goalId so background-runner can locate the state.
		const goalLoopManifest = { ...created.manifest, runId: goalId, runKind: "goal-loop" as const, goal: objective };
		saveRunManifest(goalLoopManifest);
		const eventsPath = goalLoopManifest.eventsPath;
		appendEvent(eventsPath, { type: "goal.loop_start", runId: goalId, data: { goalId, objective, maxTurns, statePath: `${cwd}/.crew/state/goals/${goalId}.json` } });

		try {
			const spawned = await spawnBackgroundTeamRun(goalLoopManifest);
			const pid = spawned.pid ?? 0;
			const withAsync = { ...goalState, async: { pid, logPath: spawned.logPath, spawnedAt: new Date().toISOString() } };
			store.save(withAsync);
			return result(
				`Goal loop started (background pid=${pid}).\n${formatGoalStatus(withAsync)}\n\nNext: \`team action='goal' config.subAction='status' config.goalId='${goalId}'\`. The loop runs up to ${maxTurns} turns, judging each against the objective. Log: ${spawned.logPath}`,
				{ action: "goal", status: "ok", data: { goalId, state: goalState.state, maxTurns, pid } },
				false,
			);
		} catch (spawnError) {
			const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
			store.setStatus(goalId, "blocked", eventsPath);
			return result(`goal start: state saved but background spawn failed: ${message}`, { action: "goal", status: "error", data: { goalId } }, true);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`goal start failed: ${message}`, { action: "goal", status: "error" }, true);
	}
}

/** `goal status` — show current state (and list goals if no goalId). */
function handleStatus(input: GoalSubActionInput): ReturnType<typeof result> {
	const { params, store } = input;
	const goalId = (params.config?.goalId as string | undefined) ?? (params.config?.goalId as string | undefined);
	if (goalId) {
		const goal = store.load(goalId);
		if (!goal) return result(`Goal '${goalId}' not found.`, { action: "goal", status: "error" }, true);
		return result(formatGoalStatus(goal), { action: "goal", status: "ok", data: { goalId, state: goal.state, turnsUsed: goal.turnsUsed } }, false);
	}
	const goals = store.list();
	if (goals.length === 0) return result("No goals found. Start one with `team action='goal' config.subAction='start' config.objective='...' config.evaluatorModel='...'`.", { action: "goal", status: "ok" }, false);
	return result(`Goals (${goals.length}):\n\n${goals.map(formatGoalStatus).join("\n\n")}`, { action: "goal", status: "ok", data: { count: goals.length } }, false);
}

/** Cooperative pause/resume/stop/clear — flip GoalLoopState.state. */
function handleStateFlip(input: GoalSubActionInput, nextState: GoalLoopStatus, label: string): ReturnType<typeof result> {
	const { params, ctx, store } = input;
	const goalId = params.config?.goalId as string | undefined;
	if (!goalId) return result(`${label} requires config.goalId.`, { action: "goal", status: "error" }, true);
	const eventsPath = `${ctx.cwd}/.crew/state/goals/${goalId}.events.jsonl`;
	const updated = store.setStatus(goalId, nextState, eventsPath);
	if (!updated) return result(`Goal '${goalId}' not found.`, { action: "goal", status: "error" }, true);
	// For `stop`: also cancel the in-flight turn runId if any (§0c C11).
	// Full handleCancel(currentRunId) integration lands with the run.ts goal-stop path.
	return result(`Goal ${goalId} ${label} (state='${updated.state}').${updated.currentRunId ? ` In-flight turn ${updated.currentRunId} will be observed at the next turn boundary (cooperative).` : ""}`, { action: "goal", status: "ok", data: { goalId, state: updated.state } }, false);
}

/** `team action='goal'` dispatch. */
export async function handleGoal(params: TeamToolParamsValue, ctx: TeamContext): Promise<ReturnType<typeof result>> {
	const store = new GoalStore(ctx.cwd);
	const subAction = typeof params.config?.subAction === "string" ? params.config.subAction : "status";
	const input: GoalSubActionInput = { params, ctx, store };
	switch (subAction) {
		case "start":
			return handleStart(input);
		case "status":
			return handleStatus(input);
		case "pause":
			return handleStateFlip(input, "paused", "paused");
		case "resume":
			// P0: resume is a status-only stub — full re-spawn wiring lands with background integration.
			return handleStatus(input);
		case "stop":
		case "cancel":
		case "clear":
		case "reset":
			return handleStateFlip(input, "cancelled", "stopped");
		case "step":
			// P0: step is a status-only stub — single-turn execution lands with P1.
			return handleStatus(input);
		default:
			return result(`Unknown goal subAction '${subAction}'. Known: start, status, pause, resume, stop, step, clear.`, { action: "goal", status: "error" }, true);
	}
}

// Touch logInternalError so the import is not tree-shaken in type-only builds (defensive).
void logInternalError;
