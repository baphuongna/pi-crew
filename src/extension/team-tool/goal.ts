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

import { GoalStore } from "../../runtime/goal-state-store.ts";
import { snapshotManifests } from "../../runtime/verification-integrity.ts";
import { acquireWorkspaceLock, isWorkspaceBusy, type WorkspaceLockHandle } from "../../runtime/workspace-lock.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import { appendEvent } from "../../state/event-log.ts";
import { createRunPaths, saveRunManifestAsync } from "../../state/state-store.ts";
import type { GoalLoopState, GoalLoopStatus, TeamRunManifest } from "../../state/types.ts";
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { result, type TeamContext } from "./context.ts";

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
		last
			? `  last verdict (turn ${last.turn}): ${last.achieved ? "ACHIEVED" : "not-achieved"} — ${last.reason.slice(0, 300)}`
			: "  (no verdicts yet)",
		goal.nextTurnFeedback ? `  next-turn feedback: ${goal.nextTurnFeedback.slice(0, 200)}` : "",
		goal.currentRunId ? `  current turn runId: ${goal.currentRunId}` : "",
	]
		.filter(Boolean)
		.join("\n");
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
		const maxTurns = typeof params.config?.maxTurns === "number" && params.config.maxTurns > 0 ? params.config.maxTurns : 20; // Claude/Codex parity default
		// P1d (RFC v0.5 §P1d): budget is REQUIRED. Either an explicit budgetTotal (>=1000, enforced
		// by schema) OR an explicit budgetUnlimited:true opt-out (audit-logged). No silent unbounded
		// default — without a cap the loop could spend unboundedly across many turns × workers.
		const budgetUnlimited = params.config?.budgetUnlimited === true;
		const hasBudgetTotal = typeof params.budgetTotal === "number" && params.budgetTotal >= 1000;
		if (!budgetUnlimited && !hasBudgetTotal) {
			throw new Error(
				"`goal start` requires either config.budgetTotal (>=1000, schema-enforced) OR config.budgetUnlimited:true (audit-logged opt-out). No silent unbounded-spend default.",
			);
		}
		// Cold-review #2 nit: reject the mutually-exclusive combination. If both are set the
		// runner silently lets budgetUnlimited win, surprising the user.
		if (budgetUnlimited && hasBudgetTotal) {
			throw new Error("`goal start`: config.budgetTotal and config.budgetUnlimited are mutually exclusive. Set exactly one.");
		}
		// P1g (cold-review #2 BLOCKING fix): pre-check the workspace lock BEFORE spawning. If another
		// goal already owns this cwd's lock, fail-fast with a clear error (the runner would otherwise
		// queue silently inside the background process). isWorkspaceBusy peeks the lockfile without
		// acquiring. The authoritative acquisition happens in runGoalLoop.
		const busyOwner = isWorkspaceBusy(cwd);
		if (busyOwner) {
			throw new Error(
				`Workspace '${cwd}' is already locked by goal '${busyOwner}'. Concurrent goals on the same single-workspace cwd are serialized to prevent edit clobbering. Stop the other goal first, or use a separate workspace.`,
			);
		}
		const verification = params.config?.verification as
			| {
					commands: string[];
					allowManualEvidence?: boolean;
					mode?: string;
			  }
			| undefined;
		const isTextOnly = verification?.mode === "text-only";
		// P1a (RFC v0.5 §P1a): take manifest-integrity snapshot at start IF verification.commands
		// declared. For text-only mode (no objective oracle), mark "none-text-only" explicitly so
		// the runner knows no snapshot guard applies. No auto-detect (B2: auto-detect is a confused
		// deputy — the user MUST declare verification explicitly).
		let verificationIntegrity: import("../../state/types.ts").GoalLoopState["verificationIntegrity"];
		if (isTextOnly || !verification?.commands?.length) {
			verificationIntegrity = "none-text-only";
		} else {
			try {
				const snap = snapshotManifests(cwd);
				verificationIntegrity = { snapshot: snap, takenAt: now };
			} catch (error) {
				logInternalError("goal.start.integritySnapshot", error, `goalId=${goalId}`);
				// Non-fatal: proceed without integrity guard (downgraded to text-only behavior).
				verificationIntegrity = "none-text-only";
			}
		}
		const goalState: import("../../state/types.ts").GoalLoopState = {
			goalId,
			ownerSessionId,
			objective,
			scope: typeof params.config?.scope === "string" ? params.config.scope : undefined,
			verification,
			state: "running",
			maxTurns,
			turnsUsed: 0,
			budgetTotal: hasBudgetTotal ? (params.budgetTotal as number) : undefined,
			budgetUnlimited: budgetUnlimited || undefined,
			budgetWarning: typeof params.budgetWarning === "number" ? params.budgetWarning : 0.8,
			budgetAbort: typeof params.budgetAbort === "number" ? params.budgetAbort : 0.95,
			budgetUsed: 0,
			verificationIntegrity,
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

		// ── Spawn the background goal-loop process (Fix P0-1 v2) ────────────────
		// Convention: the goal-loop manifest's runId IS the goalId, so background-runner's
		// `case "goal-loop"` can load GoalLoopState via `store.load(manifest.runId)`.
		// Fix P0-1: build paths via createRunPaths(cwd, goalId) so ALL paths
		// (stateRoot/artifactsRoot/eventsPath/tasksPath) are consistent with runId=goalId.
		// The previous fix overrode runId AFTER createRunManifest (which used a random id),
		// so the manifest was written to runs/<randomId>/ but background-runner looked for
		// runs/<goalId>/ → "Run not found" → silent death. (Review #2 F1.)
		const paths = createRunPaths(cwd, goalId);
		const now2 = new Date().toISOString();
		const goalLoopManifest: TeamRunManifest = {
			schemaVersion: 1,
			runId: goalId, // paths.runId === goalId by construction
			sessionId: ownerSessionId,
			team: `goal-${goalId}`,
			workflow: "goal-loop",
			goal: objective,
			status: "queued",
			workspaceMode: "single",
			createdAt: now2,
			updatedAt: now2,
			cwd,
			stateRoot: paths.stateRoot,
			artifactsRoot: paths.artifactsRoot,
			tasksPath: paths.tasksPath,
			eventsPath: paths.eventsPath,
			artifacts: [],
			ownerSessionId,
			runKind: "goal-loop",
		};
		await saveRunManifestAsync(goalLoopManifest);
		appendEvent(paths.eventsPath, {
			type: "goal.loop_start",
			runId: goalId,
			data: {
				goalId,
				objective,
				maxTurns,
				statePath: `${cwd}/.crew/state/goals/${goalId}.json`,
			},
		});

		try {
			const spawned = await spawnBackgroundTeamRun(goalLoopManifest);
			const pid = spawned.pid ?? 0;
			const withAsync = {
				...goalState,
				async: {
					pid,
					logPath: spawned.logPath,
					spawnedAt: new Date().toISOString(),
				},
			};
			store.save(withAsync);
			return result(
				`Goal loop started (background pid=${pid}).\n${formatGoalStatus(withAsync)}\n\nNext: \`team action='goal' config.subAction='status' config.goalId='${goalId}'\`. The loop runs up to ${maxTurns} turns, judging each against the objective. Log: ${spawned.logPath}`,
				{
					action: "goal",
					status: "ok",
					data: { goalId, state: goalState.state, maxTurns, pid },
				},
				false,
			);
		} catch (spawnError) {
			const message = spawnError instanceof Error ? spawnError.message : String(spawnError);
			store.setStatus(goalId, "blocked", paths.eventsPath);
			return result(
				`goal start: state saved but background spawn failed: ${message}`,
				{ action: "goal", status: "error", data: { goalId } },
				true,
			);
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
		return result(
			formatGoalStatus(goal),
			{
				action: "goal",
				status: "ok",
				data: { goalId, state: goal.state, turnsUsed: goal.turnsUsed },
			},
			false,
		);
	}
	const goals = store.list();
	if (goals.length === 0)
		return result(
			"No goals found. Start one with `team action='goal' config.subAction='start' config.objective='...' config.evaluatorModel='...'`.",
			{ action: "goal", status: "ok" },
			false,
		);
	return result(
		`Goals (${goals.length}):\n\n${goals.map(formatGoalStatus).join("\n\n")}`,
		{ action: "goal", status: "ok", data: { count: goals.length } },
		false,
	);
}

/** Cooperative pause/resume/stop/clear — flip GoalLoopState.state. */
function assertGoalOwnership(goal: GoalLoopState, ctx: TeamContext, action: string): ReturnType<typeof result> | undefined {
	// Fix round-6 A01: goal sub-actions must check session ownership (like handleCancel's abortOwned).
	// status (read-only) is allowed for any session; mutating actions require ownership or force.
	const owner = goal.ownerSessionId;
	const current = ctx.sessionId;
	// Fix round-7: ownership check must fire for running AND paused goals (paused still has
	// an in-flight turn potentially). Previously only 'running' was gated — a paused goal
	// with an active currentRunId could be stop/cancelled by a foreign session without force.
	if (owner && current && owner !== current && (goal.state === "running" || goal.state === "paused")) {
		return result(
			`Goal '${goal.goalId}' belongs to session '${owner}' (you are '${current}') and is still running. Use force:true to override.`,
			{
				action,
				status: "error",
				data: { goalId: goal.goalId, ownerSessionId: owner },
			},
			true,
		);
	}
	return undefined;
}

function handleStateFlip(input: GoalSubActionInput, nextState: GoalLoopStatus, label: string): ReturnType<typeof result> {
	const { params, ctx, store } = input;
	const goalId = params.config?.goalId as string | undefined;
	if (!goalId) return result(`${label} requires config.goalId.`, { action: "goal", status: "error" }, true);
	const existing = store.load(goalId);
	if (!existing) return result(`Goal '${goalId}' not found.`, { action: "goal", status: "error" }, true);
	if (params.force !== true) {
		const denied = assertGoalOwnership(existing, ctx, "goal");
		if (denied) return denied;
	}
	const eventsPath = createRunPaths(ctx.cwd, goalId).eventsPath;
	const updated = store.setStatus(goalId, nextState, eventsPath);
	if (!updated) return result(`Goal '${goalId}' not found.`, { action: "goal", status: "error" }, true);
	return result(
		`Goal ${goalId} ${label} (state='${updated.state}').`,
		{
			action: "goal",
			status: "ok",
			data: { goalId, state: updated.state },
		},
		false,
	);
}

/**
 * `goal stop`/`cancel`/`clear`/`reset` — cooperative flag + cancel the in-flight turn (H-5).
 * Flips GoalLoopState.state='cancelled' so the loop exits at the next turn boundary,
 * AND calls handleCancel(currentRunId) to kill a running turn immediately. §0c C11.
 */
async function handleStop(input: GoalSubActionInput): Promise<ReturnType<typeof result>> {
	const { params, ctx, store } = input;
	const goalId = params.config?.goalId as string | undefined;
	if (!goalId) return result("stop requires config.goalId.", { action: "goal", status: "error" }, true);
	const eventsPath = createRunPaths(ctx.cwd, goalId).eventsPath;
	const before = store.load(goalId);
	if (!before) return result(`Goal '${goalId}' not found.`, { action: "goal", status: "error" }, true);
	if (params.force !== true) {
		const denied = assertGoalOwnership(before, ctx, "goal");
		if (denied) return denied;
	}
	const updated = store.setStatus(goalId, "cancelled", eventsPath)!;
	// If a turn is mid-flight, cancel it now (not just at the next turn boundary).
	let cancelMsg = "";
	if (updated.currentRunId) {
		try {
			// LAZY: defer dynamic import of ./cancel.ts to its call site.
			const { handleCancel } = await import("./cancel.ts");
			const cancelResult = await handleCancel(
				{
					action: "cancel",
					runId: updated.currentRunId,
					force: true,
					config: { intent: "user requested goal stop" },
				},
				ctx,
			);
			cancelMsg = ` In-flight turn ${updated.currentRunId} cancel: ${(cancelResult.content[0] as { text?: string } | undefined)?.text ?? "ok"}.`;
		} catch (error) {
			cancelMsg = ` (in-flight turn ${updated.currentRunId} cancel failed: ${error instanceof Error ? error.message : String(error)}; the loop will still exit at the next turn boundary.)`;
		}
	}
	return result(
		`Goal ${goalId} stopped (state='cancelled').${cancelMsg}`,
		{
			action: "goal",
			status: "ok",
			data: {
				goalId,
				state: "cancelled",
				cancelledRunId: updated.currentRunId,
			},
		},
		false,
	);
}

/**
 * `goal resume` (P1b, RFC v0.5 §P1b): promote from P0 stub to real handler.
 * Resumes a paused OR stuck goal via CAS (state -> "running") + injects the user's
 * optional hint into nextTurnFeedback + re-spawns the background loop.
 *
 * No double-turn-execution: the loop is single-threaded per goal, and any in-flight
 * turn (from before the pause) completes normally; nextTurnFeedback is read at turn
 * N+1's composeGoalPrompt, so the hint applies to N+1, not the in-flight turn.
 *
 * `goal start`'s workspace-lock ownership is reused: a resumed goal does NOT re-acquire
 * the lock (the lock was held for the goal's lifetime at start). If the original goal
 * had released its lock (e.g. it crashed and the lock was reclaimed), the resumed
 * loop will fail-fast at the first worker turn that needs it — surfaced via events.
 */
async function handleResume(input: GoalSubActionInput): Promise<ReturnType<typeof result>> {
	const { params, ctx, store } = input;
	const goalId = params.config?.goalId as string | undefined;
	if (!goalId) return result("resume requires config.goalId.", { action: "goal", status: "error" }, true);
	const existing = store.load(goalId);
	if (!existing) return result(`Goal '${goalId}' not found.`, { action: "goal", status: "error" }, true);
	if (params.force !== true) {
		const denied = assertGoalOwnership(existing, ctx, "goal");
		if (denied) return denied;
	}
	// Only paused/stuck goals are resumable. (running = already running; terminal states
	// achieved/max_turns/blocked/cancelled/budget_exceeded are done.)
	if (existing.state !== "paused" && existing.state !== "stuck") {
		return result(
			`Goal '${goalId}' is in state '${existing.state}' — only 'paused' or 'stuck' goals can be resumed.`,
			{
				action: "goal",
				status: "error",
				data: { goalId, state: existing.state },
			},
			true,
		);
	}
	const hint = typeof params.config?.hint === "string" ? params.config.hint.trim() : undefined;
	const eventsPath = createRunPaths(ctx.cwd, goalId).eventsPath;
	// CAS: only resume if the state is still what we loaded. A concurrent stop/cancel wins.
	const updated = store.compareAndSetStatus(goalId, existing.state, "running", eventsPath);
	if (!updated) {
		return result(
			`Goal '${goalId}' state changed concurrently (resume aborted; another actor won the race).`,
			{ action: "goal", status: "error", data: { goalId } },
			true,
		);
	}
	// Inject the hint as next-turn feedback (applies to turn N+1's worker prompt).
	let withHint = updated;
	if (hint) {
		withHint = store.patch(goalId, { nextTurnFeedback: hint }, eventsPath) ?? updated;
	}
	appendEvent(eventsPath, {
		type: "goal.resumed",
		runId: goalId,
		data: { goalId, fromState: existing.state, hint: hint?.slice(0, 200) },
	});
	// Re-spawn the background loop. The loop checks goal.state === "running" before each
	// turn; since we just set it to running, it proceeds.
	try {
		const manifest: TeamRunManifest = {
			schemaVersion: 1,
			runId: goalId,
			sessionId: existing.ownerSessionId,
			team: `goal-${goalId}`,
			workflow: "goal-loop",
			goal: existing.objective,
			status: "queued",
			workspaceMode: "single",
			createdAt: existing.createdAt,
			updatedAt: new Date().toISOString(),
			cwd: existing.cwd,
			stateRoot: createRunPaths(existing.cwd, goalId).stateRoot,
			artifactsRoot: createRunPaths(existing.cwd, goalId).artifactsRoot,
			tasksPath: createRunPaths(existing.cwd, goalId).tasksPath,
			eventsPath,
			artifacts: [],
			ownerSessionId: existing.ownerSessionId,
			runKind: "goal-loop",
		};
		const spawned = await spawnBackgroundTeamRun(manifest);
		return result(
			`Goal ${goalId} resumed from '${existing.state}' (background pid=${spawned.pid ?? 0}).${hint ? ` Hint injected for next turn.` : ""}`,
			{
				action: "goal",
				status: "ok",
				data: {
					goalId,
					state: "running",
					fromState: existing.state,
					pid: spawned.pid,
				},
			},
			false,
		);
	} catch (spawnError) {
		const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
		// Cold-review #2 nit: roll back to the PRIOR state (paused/stuck) so the user can retry
		// 'goal resume' (which requires paused/stuck). Leaving it at 'running' with no process made
		// the goal un-resumable — the user had to pause-then-resume as a workaround.
		store.compareAndSetStatus(goalId, "running", existing.state, eventsPath);
		appendEvent(eventsPath, {
			type: "goal.resume_spawn_failed",
			runId: goalId,
			data: { goalId, error: msg, rolledBackTo: existing.state },
		});
		return result(
			`Goal ${goalId} background re-spawn failed: ${msg}. State rolled back to '${existing.state}'. Retry 'goal resume' to re-attempt.`,
			{
				action: "goal",
				status: "error",
				data: { goalId, spawnFailed: true, state: existing.state },
			},
			true,
		);
	}
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
			return await handleResume(input);
		case "stop":
		case "cancel":
		case "reset":
			return await handleStop(input);
		case "clear": {
			// Fix P1-3 + round-5 P2: remove the goal file. But refuse if the loop is still
			// running (would leave a zombie background process). Require stop first.
			const clearGoalId = params.config?.goalId as string | undefined;
			if (!clearGoalId) return result("clear requires config.goalId.", { action: "goal", status: "error" }, true);
			const existing = store.load(clearGoalId);
			if (!existing) return result(`Goal '${clearGoalId}' not found (already cleared?).`, { action: "goal", status: "error" }, true);
			if (params.force !== true) {
				const denied = assertGoalOwnership(existing, ctx, "goal");
				if (denied) return denied;
			}
			if (existing.state === "running" || existing.state === "paused") {
				return result(
					`Goal '${clearGoalId}' is still ${existing.state}. Stop it first (team action='goal' subAction='stop' goalId='${clearGoalId}'), then clear.`,
					{
						action: "goal",
						status: "error",
						data: { goalId: clearGoalId, state: existing.state },
					},
					true,
				);
			}
			const removed = store.remove(clearGoalId);
			if (!removed) return result(`Goal '${clearGoalId}' could not be removed.`, { action: "goal", status: "error" }, true);
			return result(
				`Goal '${clearGoalId}' cleared (file removed).`,
				{
					action: "goal",
					status: "ok",
					data: { goalId: clearGoalId, cleared: true },
				},
				false,
			);
		}
		case "step":
			// P0: step is a status-only stub — single-turn execution lands with P1.
			return handleStatus(input);
		default:
			return result(
				`Unknown goal subAction '${subAction}'. Known: start, status, pause, resume, stop, step, clear.`,
				{ action: "goal", status: "error" },
				true,
			);
	}
}

// Touch logInternalError so the import is not tree-shaken in type-only builds (defensive).
void logInternalError;
