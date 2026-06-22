/**
 * goal-wrap.ts — Apply the `goal` completion-guarantee to builtin workflows.
 *
 * RFC v0.5 vision: when `goalWrap[workflowName].enabled` is set in .crew/config.json,
 * the builtin workflow runs as the WORKER TURN inside a goal loop (worker → judge →
 * feedback → redo until achieved / maxTurns / budget / stuck).
 *
 * Design (A + D confirmed with user):
 *   - OUTER wrap: the builtin workflow IS the worker turn (judge evaluates the whole thing)
 *   - KEEP .workflow.md: no convert; the existing adaptive planner (e.g. `implementation`)
 *     keeps its flexibility; we just re-run it per turn with the judge's feedback.
 *   - Per-workflow toggle via team-setting config.
 *
 * Reuses the Phase 1 goal infrastructure: GoalStore, GoalLoopState, runGoalLoop. The
 * builtin workflow's per-turn execution goes through executeTeamRun (same as a normal
 * goal worker turn), so Phase 1's protections (integrity snapshot, budget guard,
 * nonce-token feedback, worker cap, workspace lock) all apply.
 */

import { createRunPaths, saveRunManifest } from "../../state/state-store.ts";
import { atomicWriteJson } from "../../state/atomic-write.ts";
import { appendEvent } from "../../state/event-log.ts";
import { spawnBackgroundTeamRun } from "../../subagents/async-entry.ts";
import { GoalStore } from "../../runtime/goal-state-store.ts";
import { snapshotManifests } from "../../runtime/verification-integrity.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { loadConfig } from "../../config/config.ts";
import type { GoalLoopState, TeamRunManifest } from "../../state/types.ts";
import type { GoalWrapWorkflowConfig } from "../../config/types.ts";
import type { TeamToolParamsValue } from "../../schema/team-tool-schema.ts";
import type { WorkflowConfig } from "../../workflows/workflow-config.ts";
import { result, type TeamContext } from "./context.ts";

/** Builtin workflows eligible for goal-wrap (have a clear "done" condition). */
export const GOAL_WRAP_ELIGIBLE_BUILTINS = new Set([
	"implementation",
	"fast-fix",
	"default",
]);

/**
 * Maximum number of workflow steps allowed for goal-wrap.
 *
 * Multi-step workflows (>=2 steps in their .workflow.md definition) crash
 * non-deterministically when run as goal-wrap worker turns in the background
 * goal-loop process. Root cause: V8/libuv-level race during event-loop yields
 * in the team-runner batch transition (see investigation commit a9f6e09 +
 * Phase 1.5 RFC 15). Sync fs workarounds regress; worker-thread isolation
 * doesn't help. The crash is NOT in fs writes.
 *
 * Decision: REFUSE goal-wrap for multi-step workflows rather than ship a
 * feature with hidden non-deterministic crashes. Single-step workflows
 * (e.g. implementation, which has only the adaptive `assess` step and
 * injects more tasks via the adaptive planner) work reliably end-to-end.
 *
 * Users who want goal completion-guarantee on multi-step work should use
 * `team action='run' workflow=<multi-step>` for the one-shot execution, or
 * break the work into single-step goals.
 */
export const GOAL_WRAP_MAX_STEPS = 1;

// GoalWrapWorkflowConfig is re-exported from config/types.ts (single source of truth).
export type { GoalWrapWorkflowConfig };

/** Read the goal-wrap config for a given workflow name (merged user + project config). */
export function readGoalWrapConfig(
	cwd: string,
	workflowName: string,
): GoalWrapWorkflowConfig | undefined {
	const loaded = loadConfig(cwd);
	const cfg = loaded.config?.goalWrap as Record<string, GoalWrapWorkflowConfig> | undefined;
	if (!cfg) return undefined;
	return cfg[workflowName];
}

/** Is goal-wrap enabled for this workflow (per config)? */
export function isGoalWrapEnabled(cwd: string, workflowName: string): boolean {
	if (!GOAL_WRAP_ELIGIBLE_BUILTINS.has(workflowName)) return false;
	const wc = readGoalWrapConfig(cwd, workflowName);
	return wc?.enabled === true;
}

/**
 * Validate a goal-wrap config entry. Returns an error string if invalid, undefined if OK.
 * Mirrors the Phase 1 validation: budget required (or unlimited), evaluatorModel required.
 */
export function validateGoalWrapConfig(
	wc: GoalWrapWorkflowConfig,
): string | undefined {
	if (!wc.evaluatorModel) {
		return "goalWrap config requires evaluatorModel (the goal-judge model). No silent default.";
	}
	const hasBudget = typeof wc.budgetTotal === "number" && wc.budgetTotal >= 1000;
	if (!wc.budgetUnlimited && !hasBudget) {
		return "goalWrap config requires either budgetTotal (>=1000) OR budgetUnlimited:true. No silent unbounded-spend default.";
	}
	if (wc.budgetUnlimited && hasBudget) {
		return "goalWrap config: budgetTotal and budgetUnlimited are mutually exclusive.";
	}
	return undefined;
}

/**
 * Start a goal-wrapped run. Creates a GoalLoopState + goal-loop manifest + spawns the
 * background goal-loop process. The worker turn's workflow is the resolved builtin.
 *
 * The goal-loop-runner's buildTurnWorkflow() generates a 1-step "goal-turn" workflow; for
 * goal-wrap we OVERRIDE that by storing the target workflow name on the GoalLoopState
 * and having the runner use it per turn. (See the `team` field carry-through.)
 */
/**
 * Persist `async: { pid, logPath, spawnedAt }` on a goal-loop manifest and write
 * it atomically to disk. This is the missing piece that makes goal-loop runs
 * detectable by async-notifier.markDeadAsyncRunIfNeeded — without it, the
 * notifier returns early on `!run.async` and the goal appears to hang at "1/3"
 * forever even after the background runner has died.
 *
 * Mirrors the normal-run path in run.ts:371-372 which writes the async field on
 * the team-run manifest via `atomicWriteJson(paths.manifestPath, asyncManifest)`.
 */
export function persistAsyncOnGoalLoopManifest(
	manifestPath: string,
	manifest: TeamRunManifest,
	spawned: { pid: number; logPath: string },
): void {
	const asyncGoalManifest = {
		...manifest,
		async: { pid: spawned.pid, logPath: spawned.logPath, spawnedAt: new Date().toISOString() },
	};
	atomicWriteJson(manifestPath, asyncGoalManifest);
}
export async function startGoalWrappedRun(
	params: TeamToolParamsValue,
	ctx: TeamContext,
	workflow: WorkflowConfig,
	goal: string,
): Promise<ReturnType<typeof result>> {
	const cwd = ctx.cwd;
	const wc = readGoalWrapConfig(cwd, workflow.name);
	if (!wc || wc.enabled !== true) {
		return result(`goal-wrap is not enabled for workflow '${workflow.name}' in .crew/config.json.`, { action: "run", status: "error" }, true);
	}
	const validationError = validateGoalWrapConfig(wc);
	if (validationError) {
		return result(`Invalid goalWrap config for '${workflow.name}': ${validationError}`, { action: "run", status: "error" }, true);
	}
	// SAFETY: refuse goal-wrap for multi-step workflows. They crash
	// non-deterministically in the background goal-loop process due to a
	// V8/libuv-level race during event-loop yields in the team-runner batch
	// transition (see GOAL_WRAP_MAX_STEPS doc + commit a9f6e09 + RFC 15).
	// Single-step workflows (e.g. implementation with only the adaptive
	// `assess` step) work reliably. Refuse here with a helpful message
	// rather than ship a feature that silently hangs the user at "1/N tasks".
	if (workflow.steps.length > GOAL_WRAP_MAX_STEPS) {
		return result(
			[
				`goal-wrap refused for '${workflow.name}': this workflow has ${workflow.steps.length} steps (${workflow.steps.map((s) => s.id).join(", ")}).`,
				`Multi-step workflows crash non-deterministically when run as goal-wrap worker turns in the background (V8/libuv race in team-runner batch transition).`,
				``,
				`Alternatives:`,
				`  1. Use 'team action=\'run\' workflow=${workflow.name}' for one-shot multi-step execution (no goal loop).`,
				`  2. Use a single-step workflow for goal-wrap (e.g. 'implementation', which has only the adaptive assess step).`,
				`  3. Break your goal into smaller single-step goals.`,
			].join("\n"),
			{ action: "run", status: "error", data: { goalWrapRefused: true, workflow: workflow.name, stepCount: workflow.steps.length, maxSteps: GOAL_WRAP_MAX_STEPS } },
			true,
		);
	}

	try {
		const store = new GoalStore(cwd);
		const goalId = store.createGoalId();
		const ownerSessionId = ctx.sessionId ?? "unknown";
		const now = new Date().toISOString();
		const maxTurns = typeof wc.maxTurns === "number" && wc.maxTurns > 0 ? wc.maxTurns : 5; // goal-wrap default: tighter than standalone goal's 20

		// P1a integrity snapshot (only when verification.commands declared).
		const verification = wc.verification;
		const isTextOnly = verification?.mode === "text-only" || !verification?.commands?.length;
		let verificationIntegrity: GoalLoopState["verificationIntegrity"];
		if (isTextOnly) {
			verificationIntegrity = "none-text-only";
		} else {
			try {
				verificationIntegrity = { snapshot: snapshotManifests(cwd), takenAt: now };
			} catch (error) {
				logInternalError("goal-wrap.integritySnapshot", error, `goalId=${goalId}`);
				verificationIntegrity = "none-text-only";
			}
		}

		const goalState: GoalLoopState = {
			goalId,
			ownerSessionId,
			objective: goal,
			state: "running",
			maxTurns,
			turnsUsed: 0,
			budgetTotal: typeof wc.budgetTotal === "number" ? wc.budgetTotal : undefined,
			budgetUnlimited: wc.budgetUnlimited || undefined,
			budgetWarning: 0.8,
			budgetAbort: 0.95,
			budgetUsed: 0,
			verificationIntegrity,
			verification: verification as { commands: string[]; allowManualEvidence?: boolean } | undefined,
			evaluatorModel: wc.evaluatorModel!,
			workerAgent: params.agent ?? "executor",
			workerModel: typeof params.model === "string" ? params.model : undefined,
			team: typeof params.team === "string" ? params.team : undefined,
			cwd,
			verdicts: [],
			history: [],
			createdAt: now,
			updatedAt: now,
		};
		// Carry the target workflow name so the runner uses it (not the default goal-turn).
		// Stored on the state via a documented extension field.
		(goalState as GoalLoopState & { goalWrapWorkflow?: string }).goalWrapWorkflow = workflow.name;
		store.save(goalState);

		const paths = createRunPaths(cwd, goalId);
		const goalLoopManifest: TeamRunManifest = {
			schemaVersion: 1,
			runId: goalId,
			sessionId: ownerSessionId,
			team: `goal-wrap-${goalId}`,
			workflow: "goal-loop",
			goal,
			status: "queued",
			workspaceMode: "single",
			createdAt: now,
			updatedAt: now,
			cwd,
			stateRoot: paths.stateRoot,
			artifactsRoot: paths.artifactsRoot,
			tasksPath: paths.tasksPath,
			eventsPath: paths.eventsPath,
			artifacts: [],
			ownerSessionId,
			runKind: "goal-loop",
		};
		saveRunManifest(goalLoopManifest);
		appendEvent(paths.eventsPath, { type: "goal.loop_start", runId: goalId, data: { goalId, objective: goal, maxTurns, goalWrapWorkflow: workflow.name } });

		const spawned = await spawnBackgroundTeamRun(goalLoopManifest);
		const pid = spawned.pid ?? 0;
		// FIX: persist async.pid on the OUTER goal-loop manifest (not just goal state).
		// Without this, async-notifier.markDeadAsyncRunIfNeeded returns early on
		// `!run.async` and the user sees the goal hang at "1/3" forever even after the
		// background runner dies (it currently dies silently due to a multi-step
		// atomic-write bug — see investigation report). Mirrors run.ts:371-372 which
		// writes asyncManifest = { ...effectiveManifest, async: {...} } to manifestPath.
		persistAsyncOnGoalLoopManifest(paths.manifestPath, goalLoopManifest, { pid, logPath: spawned.logPath });
		const withAsync = { ...goalState, async: { pid, logPath: spawned.logPath, spawnedAt: new Date().toISOString() } };
		store.save(withAsync);

		return result(
			[
				`Goal-wrapped '${workflow.name}' started (background pid=${pid}).`,
				`Goal ${goalId} [running] — worker = '${workflow.name}' workflow, judged each turn by ${wc.evaluatorModel}.`,
				`  turn: 0/${maxTurns}   budget: ${wc.budgetUnlimited ? "∞ (unlimited)" : `${wc.budgetTotal}`}`,
				verification?.commands?.length ? `  verification: ${verification.commands.join(", ")}` : "  verification: text-only (no objective oracle)",
				``,
				`Next: \`team action='goal' config.subAction='status' config.goalId='${goalId}'\`.`,
				`Log: ${spawned.logPath}`,
			].join("\n"),
			{ action: "run", status: "ok", runId: goalId, artifactsRoot: paths.artifactsRoot, data: { goalId, goalWrap: true, workflow: workflow.name, pid } },
			false,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return result(`goal-wrap start failed: ${message}`, { action: "run", status: "error" }, true);
	}
}
