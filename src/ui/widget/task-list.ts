/**
 * task-list.ts — the run's plan, painted above the editor (Claude Code /
 * droid style): a one-line header with progress counts, then one row per
 * task — active tasks first in plan order, finished tasks after, collapsed
 * behind a "… +N completed" overflow once they no longer fit.
 *
 * Example:
 * ```
 * Plan · 2/6 done · 1 failed
 *   ✻ 04_execute — wire the overlay scroll
 *   ○ 05_verify — run the suite
 *   ✓ 01_explore — map the view stack
 *   ✓ 02_plan — design the overlay
 *   … +2 completed
 * ```
 *
 * Pure plan surface: one row per thing to do, no agent/role info — which
 * worker runs a task is the dock's story below the editor. Pure display —
 * the interactive surface stays that dock (↑/↓ select, enter views). Rows
 * come from the run snapshot's `tasks` slice, so the list repaints on task
 * transitions only.
 */

import type { TeamTaskState } from "../../state/types.ts";
import { truncate } from "../../utils/visual.ts";
import { dockStatusIcon } from "./widget-formatters.ts";
import { shortRunLabel } from "./widget-model.ts";
import type { WidgetRun } from "./widget-types.ts";

/** Active rows shown before the finished section. */
const MAX_ACTIVE_ROWS = 4;
/** Finished rows kept visible; older ones collapse into the overflow line. */
const MAX_DONE_ROWS = 2;

const ACTIVE_TASK_STATUSES = new Set(["running", "queued", "waiting", "needs_attention"]);

function isDoneStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "skipped";
}

function taskTitle(task: TeamTaskState): string {
	return (task.displayName ?? task.title ?? "").replace(/\s+/g, " ").trim();
}

/** One line per task: `id — plan title`. Pure plan — roles/agents are the
 *  dock's story (below the editor), not the plan's. */
function taskRow(task: TeamTaskState, width: number): string {
	return truncate(`  ${dockStatusIcon(task.status)} ${task.id} — ${taskTitle(task)}`, width);
}

/**
 * The RUNNING task's detailed plan text, one indented line under its row —
 * the plan stays readable without opening the full view. Heading lines are
 * dropped: the row already carries the heading as its title. Queued/finished
 * tasks keep their single line (the dock stays compact).
 */
function taskDetail(task: TeamTaskState, width: number): string | undefined {
	const title = taskTitle(task);
	const detail = (task.description ?? "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("#"))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
	if (!detail) return undefined;
	// Runs persisted before the title/description split quoted the run goal in
	// both — don't paint the same sentence twice under its own row.
	if (title.length >= 20 && detail.startsWith(title.slice(0, 40).replace(/\s+/g, " "))) return undefined;
	return truncate(`      ${detail}`, width);
}

/** The run whose plan is shown: the first with unfinished work, else the first. */
function primaryRun(runs: readonly WidgetRun[]): WidgetRun | undefined {
	return runs.find((entry) => (entry.snapshot?.tasks ?? []).some((task) => ACTIVE_TASK_STATUSES.has(task.status))) ?? runs[0];
}

/**
 * Build the task-list lines for the current runs. Empty when no run carries a
 * tasks slice (nothing to say — the dock alone stays).
 */
export function buildTaskListLines(runs: readonly WidgetRun[], width: number): string[] {
	const entry = primaryRun(runs);
	if (!entry) return [];
	const tasks = entry.snapshot?.tasks ?? [];
	if (tasks.length === 0) return [];

	const active = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
	const done = tasks.filter((task) => isDoneStatus(task.status));
	const failed = tasks.filter((task) => task.status === "failed").length;
	const running = tasks.filter((task) => task.status === "running" || task.status === "waiting").length;

	const headerParts = [`Plan · ${done.length}/${tasks.length} done`];
	if (running) headerParts.push(`${running} active`);
	if (failed) headerParts.push(`${failed} failed`);
	if (runs.length > 1) headerParts.push(shortRunLabel(entry.run));
	const lines = [truncate(headerParts.join(" · "), width)];

	const visibleActive = active.slice(0, MAX_ACTIVE_ROWS);
	for (const task of visibleActive) {
		lines.push(taskRow(task, width));
		if (task.status === "running" || task.status === "needs_attention") {
			const detail = taskDetail(task, width);
			if (detail) lines.push(detail);
		}
	}
	if (active.length > visibleActive.length) {
		lines.push(truncate(`  … +${active.length - visibleActive.length} open`, width));
	}

	const visibleDone = done.slice(0, MAX_DONE_ROWS);
	for (const task of visibleDone) lines.push(taskRow(task, width));
	if (done.length > visibleDone.length) {
		lines.push(truncate(`  … +${done.length - visibleDone.length} completed`, width));
	}
	return lines;
}
