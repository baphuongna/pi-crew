/**
 * G19 (W-E Phase 1): shared goal-achievement surfacing helpers.
 *
 * `manifest.goalAchieved` (set once by `applyGoalAchievement` at run
 * completion) had ZERO readers — the false-green verdict was persisted but
 * never shown. These helpers are the single render rule so every surface
 * (team-tool status, widget label, dashboard rows, live sidebar) agrees:
 *
 * - NEVER render while the run is still active (verdict is not final).
 * - `true`  → silent (a green run needs no extra noise).
 * - `false` / `"unknown"` → ⚠ warning (false-green / not verified).
 * - `undefined` → silent (legacy runs created before the assessment existed,
 *   or goal-loop assessment not enabled).
 */

import { isTerminalRunStatus, type TeamRunStatus } from "../state/contracts.ts";

/** True when the run is terminal AND the goal was NOT confirmed achieved. */
export function isGoalNotAchieved(run: { status?: string; goalAchieved?: boolean | "unknown" }): boolean {
	if (run.status === undefined) return false;
	if (!isTerminalRunStatus(run.status as TeamRunStatus)) return false;
	return run.goalAchieved === false || run.goalAchieved === "unknown";
}

/** Short suffix for one-line labels (widget title, dashboard row, sidebar). */
export function goalFlagSuffix(run: { status?: string; goalAchieved?: boolean | "unknown" }): string {
	return isGoalNotAchieved(run) ? " ⚠" : "";
}

/**
 * Full status line for team-tool status output. Empty string when silent
 * (non-terminal, achieved, or never assessed). Includes the false-green note
 * (the reason string recorded by `applyGoalAchievement`) when present.
 */
export function goalAchievedStatusLabel(run: {
	status?: string;
	goalAchieved?: boolean | "unknown";
	goalAchievementNote?: string;
}): string {
	if (!isGoalNotAchieved(run)) return "";
	const verdict = run.goalAchieved === "unknown" ? "unknown (not verified)" : "not achieved";
	const note = run.goalAchievementNote ? ` — ${run.goalAchievementNote}` : "";
	return `Goal achieved: ⚠ ${verdict}${note}`;
}
