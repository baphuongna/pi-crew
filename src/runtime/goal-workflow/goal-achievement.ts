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
		const res = spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], { encoding: "utf8", timeout: 5_000 });
		if (res.error || res.status !== 0) return { clean: "unknown", repoRoot: undefined };
		return { clean: res.stdout.trim().length === 0, repoRoot };
	} catch {
		return { clean: "unknown", repoRoot: undefined };
	}
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
