/**
 * #2 (assessment): goal-achievement detection — kills the "false-green" lie.
 *
 * The v0.9.13 assessment found run team_20260626170635 reported terminal-success
 * ("completed") while its verifier wrote: "did NOT apply ANY of the three
 * security fixes. git diff --stat for all 6 target files is empty… Tests are
 * green only because nothing was changed." The run status LIED.
 *
 * This module assesses whether a completed run actually achieved its goal, so
 * the false-green is no longer SILENT. It is deliberately conservative:
 *   - read-only / doc-only workflows are never accused (they legitimately make
 *     no project-code edits; their outputs land in gitignored .crew/),
 *   - a goal that EXPLICITLY declares read-only intent (marker phrase) is
 *     never accused either, even when the workflow shape is mutating —
 *     explicit intent beats workflow shape (see `goalDeclaresReadOnly`),
 *   - a false-green is only flagged for CODE-MUTATING runs (executor /
 *     test-engineer steps) in a git repo whose working tree is empty,
 *   - status is downgraded to "failed" ONLY when a corroborating signal (a
 *     task that actually failed) confirms it; otherwise the suspicion is
 *     exposed via `goalAchieved=false` + a prominent event + manifest note,
 *     without breaking a legitimately-no-op run.
 */
import { spawnSync } from "node:child_process";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import { findRepoRoot } from "../../utils/paths.ts";
import type { WorkflowConfig } from "../../workflows/workflow-config.ts";
import { buildGitSafeEnv, hardenGitArgs } from "../../worktree/git-hardening.ts";

/**
 * Roles whose job is to EDIT project source/test files (changes that appear in
 * `git status`). Deliberately NARROW: writer/verifier/security-reviewer write
 * reports (often to gitignored .crew/), so an empty diff is NOT a failure
 * signal for them. Only executor/test-engineer MUST touch project code.
 */
export const MUTATING_ROLES = new Set<string>(["executor", "test-engineer"]);

export type GoalAchieved = boolean | "unknown";

export interface GoalAchievementAssessment {
	achieved: GoalAchieved;
	reason: string;
	/** human-readable corroborating signals (for events/manifest) */
	signals: string[];
}

/** Does this workflow contain any code-mutating role step? */
export function workflowIsMutating(workflow: WorkflowConfig | undefined): boolean {
	const steps = workflow?.steps ?? [];
	return steps.some((step) => typeof step?.role === "string" && MUTATING_ROLES.has(step.role));
}

/** Is the working tree of the repo containing `cwd` clean (no changes)? Throws-safe. */
export function isGitWorkingTreeClean(cwd: string): { clean: boolean; repoRoot: string } | { clean: "unknown"; repoRoot: undefined } {
	try {
		const repoRoot = findRepoRoot(cwd);
		if (!repoRoot) return { clean: "unknown", repoRoot: undefined };
		// `git status --porcelain` → empty stdout means a clean working tree.
		// R-A5 (MED-1): previously spawnSync inherited the FULL process.env —
		// API keys could leak to config-reachable helpers git spawns. Now the
		// sanitized env + hardenGitArgs (cwd is the trusted manifest repo root,
		// so no gitdir-pointer guard is needed here).
		const res = spawnSync("git", hardenGitArgs(["-C", repoRoot, "status", "--porcelain"]), {
			encoding: "utf-8",
			timeout: 5_000,
			env: buildGitSafeEnv(),
		});
		if (res.error || res.status !== 0) return { clean: "unknown", repoRoot: undefined };
		return { clean: res.stdout.trim().length === 0, repoRoot };
	} catch {
		return { clean: "unknown", repoRoot: undefined };
	}
}

/**
 * Goal-text markers that EXPLICITLY declare a read-only task. Each entry is
 * matched as a substring, case-insensitively, against whitespace-collapsed
 * lowercase goal text (`goalDeclaresReadOnly`). Keep this list short and
 * literal — one phrase per line — so it is trivial to extend. Longer phrases
 * already covered by a shorter entry are intentionally omitted (e.g.
 * "do not modify, create, or delete" is covered by "do not modify").
 */
const READ_ONLY_GOAL_MARKERS: readonly string[] = [
	"read-only",
	"read only",
	"do not modify",
	"don't modify",
	"no file modifications",
	"không sửa",
	"không chỉnh sửa",
	"chỉ đọc",
];

/**
 * Explicit-intent detector, deliberately conservative: returns true ONLY when
 * the goal text contains one of the literal READ_ONLY_GOAL_MARKERS phrases
 * (case-insensitive, whitespace-collapsed). No semantic guessing — a goal
 * that merely *sounds* non-mutating is NOT suppressed. Battery/probe goal
 * conventions use exactly these phrases.
 */
export function goalDeclaresReadOnly(goal: string | undefined): boolean {
	if (typeof goal !== "string" || goal.length === 0) return false;
	const normalized = goal.toLowerCase().replace(/\s+/g, " ").trim();
	return READ_ONLY_GOAL_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Assess whether a completed run achieved its goal. Pure function over manifest
 * + tasks + workflow — no side effects, easy to unit-test.
 */
export function assessGoalAchievement(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	workflow: WorkflowConfig | undefined,
): GoalAchievementAssessment {
	// (1) Only code-mutating workflows can be false-green. Read-only/doc runs
	//     legitimately make no project edits — never accuse them.
	if (!workflowIsMutating(workflow)) {
		return {
			achieved: "unknown",
			reason: "read-only / doc-only workflow (no executor/test-engineer steps)",
			signals: [],
		};
	}

	// (1b) Explicit-intent detector: the WORKFLOW is mutating, but the GOAL TEXT
	//      explicitly declares a read-only task — a clean tree is then EXPECTED,
	//      never an accusation. Deliberately conservative (literal markers only,
	//      no semantic guessing); battery/probe conventions use these phrases.
	if (goalDeclaresReadOnly(manifest.goal)) {
		return {
			achieved: "unknown",
			reason: "goal declared read-only (no edits expected)",
			signals: [],
		};
	}

	// (2) Need a git repo to inspect the working tree.
	const tree = isGitWorkingTreeClean(manifest.cwd);
	if (tree.clean === "unknown" || !tree.repoRoot) {
		return {
			achieved: "unknown",
			reason: "not a git repo or git unavailable",
			signals: [],
		};
	}

	// (3) Non-empty working tree → the mutating run made edits. Achieved.
	if (!tree.clean) {
		return {
			achieved: true,
			reason: "git working tree has changes (mutating run edited project files)",
			signals: [`repoRoot=${tree.repoRoot}`],
		};
	}

	// (4) Mutating run + CLEAN working tree → suspicious. The executor's job was
	//     to edit code and it left zero diff. This is the false-green signature.
	const failedTask = tasks.find((t) => t.status === "failed");
	const signals = ["git working tree clean despite mutating workflow"];
	if (failedTask) signals.push(`corroborating failed task: ${failedTask.id} (${failedTask.role})`);

	return {
		// `false` = false-green detected. Whether to downgrade status is decided
		// by the caller based on the corroborating failed-task signal.
		achieved: false,
		reason: "code-mutating run completed but made no project edits (false-green)",
		signals,
	};
}

/**
 * Apply an assessment to a run result: set manifest.goalAchieved + note, and
 * decide whether to downgrade status. Returns the (possibly mutated) manifest.
 *
 * Downgrade rule (conservative): only flip "completed" → "failed" when a
 * corroborating failed-task signal is present. Otherwise expose goalAchieved
 * = false + a manifest note + let the caller emit an event, but leave status
 * intact so a legitimately-no-op mutating run is not broken.
 */
export function applyGoalAchievement(
	manifest: TeamRunManifest,
	assessment: GoalAchievementAssessment,
): { manifest: TeamRunManifest; downgraded: boolean } {
	const note =
		assessment.achieved === false
			? `goal-achievement: FALSE-GREEN — ${assessment.reason}. ${assessment.signals.join("; ")}`
			: assessment.achieved === true
				? `goal-achievement: OK — ${assessment.reason}`
				: `goal-achievement: unknown — ${assessment.reason}`;

	const updated: TeamRunManifest = {
		...manifest,
		goalAchieved: assessment.achieved,
		goalAchievementNote: note,
	};

	// Downgrade only on the highest-confidence false-green: a failed task
	// corroborates that the run genuinely did not succeed.
	const hasCorroboratingFailure = assessment.signals.some((s) => s.startsWith("corroborating failed task"));
	if (assessment.achieved === false && hasCorroboratingFailure && updated.status === "completed") {
		return { manifest: { ...updated, status: "failed" }, downgraded: true };
	}
	return { manifest: updated, downgraded: false };
}
