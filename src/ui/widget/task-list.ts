/**
 * task-list.ts — the run's plan, painted above the editor (pi-tasks /
 * Claude Code style): a `● N tasks (…)` header, then one row per task in
 * PLAN ORDER with task numbers (#1, #2, …) instead of technical ids.
 * Completed rows are dimmed and struck through; the task actively executing
 * carries a spinner frame with elapsed time and token counts; queued rows
 * name the dependencies they wait on.
 *
 * Example:
 * ```
 * ● 4 tasks (1 done, 1 in progress, 2 open)
 *   ✔ #1 Design the flux capacitor
 *   ⠙ #2 Wire the overlay scroll (2m 49s · ↑ 4.1k ↓ 1.2k)
 *   ◻ #3 Run the suite › blocked by #2
 *   ◻ #4 Report the result
 * ```
 *
 * Pure plan surface: which worker/agent/model runs a task is the dock's
 * story below the editor, never the plan's. Pure display — the interactive
 * surface stays that dock. Rows come from the run snapshot's `tasks` slice
 * (plan order), so the list repaints on task transitions only; the running
 * row's spinner/elapsed/token suffix rides the render signature's spinner
 * bucket while any worker is alive.
 */

import type { TeamTaskState } from "../../state/types.ts";
import { truncate } from "../../utils/visual.ts";
import { spinnerFrame } from "../spinner.ts";
import { shortRunLabel } from "./widget-model.ts";
import type { WidgetRun } from "./widget-types.ts";

/** Task rows painted before the "… and N more" overflow line (pi-tasks
 *  defaults its `maxVisible` to 10). */
const MAX_TASK_ROWS = 10;

const ACTIVE_TASK_STATUSES = new Set(["running", "queued", "waiting", "needs_attention"]);

// pi-tasks-style strikethrough + dim for completed rows: raw SGR because the
// theme adapter has no strike; the truncate/colorize paths are ANSI-aware.
const DIM_ON = "\x1b[2m";
const DIM_OFF = "\x1b[22m";
const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";

function isDoneStatus(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "skipped";
}

function taskTitle(task: TeamTaskState): string {
	return (task.displayName ?? task.title ?? "").replace(/\s+/g, " ").trim();
}

/** pi-tasks status glyph per row: ✔ done (struck through), spinner for the
 *  actively executing task, ◼ parked/needs input, ◻ queued, ✗ dead. */
function taskStatusIcon(task: TeamTaskState): string {
	switch (task.status) {
		case "running":
			return spinnerFrame("crew-task-list");
		case "queued":
			return "◻";
		case "waiting":
		case "needs_attention":
			return "◼";
		case "completed":
			return "✔";
		case "failed":
		case "cancelled":
		case "skipped":
			return "✗";
		default:
			return "?";
	}
}

/** `45s` / `2m 49s` / `1h 03m`. */
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "";
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `4.1k` / `1.2M` / `918` — no unit suffix; the arrow pair carries it. */
function compactTokens(count: number): string {
	if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) return "";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return `${count}`;
}

/** `(2m 49s · ↑ 4.1k ↓ 1.2k)` — elapsed plus tokens, pi-tasks style. Live
 *  totals come from agentProgress until the final usage lands. */
function runningSuffix(task: TeamTaskState): string {
	const parts: string[] = [];
	const start = Date.parse(task.startedAt ?? "");
	if (Number.isFinite(start) && start > 0) {
		const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
		const elapsed = formatDuration(end - start);
		if (elapsed) parts.push(elapsed);
	}
	const input = task.usage?.input ?? 0;
	const output = task.usage?.output ?? 0;
	if (input > 0 || output > 0) {
		parts.push(`↑ ${compactTokens(input) || "0"} ↓ ${compactTokens(output) || "0"}`);
	} else {
		const live = compactTokens(task.agentProgress?.tokens ?? 0);
		if (live) parts.push(live);
	}
	return parts.length ? ` (${parts.join(" · ")})` : "";
}

/** `› blocked by #2, #3` for queued tasks — open (non-completed)
 *  dependencies only, named by task number (pi-tasks display rule). */
function blockedSuffix(task: TeamTaskState, tasks: readonly TeamTaskState[], numberById: Map<string, number>): string {
	if (task.status !== "queued") return "";
	const openDeps = (task.dependsOn ?? [])
		.map((depId) => tasks.find((entry) => entry.id === depId))
		.filter((dep): dep is TeamTaskState => dep !== undefined && dep.status !== "completed");
	if (openDeps.length === 0) return "";
	const labels = openDeps.map((dep) => `#${numberById.get(dep.id) ?? "?"}`);
	return ` › blocked by ${labels.join(", ")}`;
}

/** One line per task: `#n title` behind its status glyph — pi-tasks style.
 *  Completed titles are dimmed and struck through. */
function taskRow(
	task: TeamTaskState,
	taskNumber: number,
	tasks: readonly TeamTaskState[],
	numberById: Map<string, number>,
	width: number,
): string {
	const title = taskTitle(task);
	const suffix = task.status === "running" ? runningSuffix(task) : blockedSuffix(task, tasks, numberById);
	if (task.status === "completed") {
		const struck = `${STRIKE_ON}${DIM_ON}#${taskNumber} ${title}${DIM_OFF}${STRIKE_OFF}`;
		return truncate(`  ✔ ${struck}`.trimEnd(), width);
	}
	return truncate(`  ${taskStatusIcon(task)} #${taskNumber} ${title}${suffix}`.trimEnd(), width);
}

/** The run whose plan is shown: the first with unfinished work, else the first. */
function primaryRun(runs: readonly WidgetRun[]): WidgetRun | undefined {
	return runs.find((entry) => (entry.snapshot?.tasks ?? []).some((task) => ACTIVE_TASK_STATUSES.has(task.status))) ?? runs[0];
}

/** Which rows fit the cap: plan order, but never drop an unfinished task —
 *  if active work falls outside the first MAX_TASK_ROWS rows it stays and
 *  finished rows give way instead. */
function visibleTasks(tasks: readonly TeamTaskState[]): TeamTaskState[] {
	if (tasks.length <= MAX_TASK_ROWS) return [...tasks];
	const active = tasks.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
	if (active.length >= MAX_TASK_ROWS) return active.slice(0, MAX_TASK_ROWS);
	const keep = new Set(active.map((task) => task.id));
	for (const task of tasks) {
		if (keep.size >= MAX_TASK_ROWS) break;
		keep.add(task.id);
	}
	return tasks.filter((task) => keep.has(task.id));
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

	const numberById = new Map(tasks.map((task, index) => [task.id, index + 1]));
	const done = tasks.filter((task) => task.status === "completed").length;
	const dead = tasks.filter((task) => isDoneStatus(task.status) && task.status !== "completed").length;
	const inProgress = tasks.filter(
		(task) => task.status === "running" || task.status === "waiting" || task.status === "needs_attention",
	).length;
	const open = tasks.filter((task) => task.status === "queued").length;

	const counts = [`${done} done`];
	if (dead) counts.push(`${dead} failed`);
	counts.push(`${inProgress} in progress`, `${open} open`);
	const headerParts = [`● ${tasks.length} tasks (${counts.join(", ")})`];
	if (runs.length > 1) headerParts.push(shortRunLabel(entry.run));
	const lines = [truncate(headerParts.join(" · "), width)];

	const visible = visibleTasks(tasks);
	for (const task of visible) {
		lines.push(taskRow(task, numberById.get(task.id) ?? 0, tasks, numberById, width));
	}
	if (tasks.length > visible.length) {
		lines.push(truncate(`  … and ${tasks.length - visible.length} more`, width));
	}
	return lines;
}
