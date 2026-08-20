/**
 * Widget rendering — builds and colorizes widget lines.
 *
 * Extracted from crew-widget.ts.
 */

import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import { isPlanApprovalStatePending } from "../../runtime/plan-approval.ts";
import { isFinishedRunStatus } from "../../runtime/process-status.ts";
import { truncate } from "../../utils/visual.ts";
import { Box, Text } from "../layout-primitives.ts";
import { spinnerFrame } from "../spinner.ts";
import { colorizeStatusGlyphs, iconForStatus } from "../status-colors.ts";
import type { CrewTheme } from "../theme-adapter.ts";
import { agentActivity, agentStats, budgetedRow, notificationBadge } from "./widget-formatters.ts";
import { activeWidgetRuns, shortRunLabel } from "./widget-model.ts";
import type { WidgetRun } from "./widget-types.ts";

export const MAX_AGENTS_DISPLAY = 3;
const FINISHED_LINGER_MAX_AGE = 1;
/** Default terminal width when caller doesn't pass one explicitly. Keep <= 116
 * (the same default used elsewhere in pi-crew tool renderers) so we never paint
 * a line wider than the smallest expected TUI. Callers SHOULD pass the real
 * width when known (via ctx.width || process.stdout.columns). */
export const DEFAULT_WIDGET_WIDTH = 100;
/** Cap per-component text so a single field cannot blow past width on its own. */
export const TASK_DESC_MAX = 60;
const ERROR_LINGER_MAX_AGE = 2;
const ERROR_STATUSES = new Set(["failed", "cancelled", "stopped", "needs_attention"]);

// ── Header ────────────────────────────────────────────────────────────

export function widgetHeader(runs: WidgetRun[], runningGlyph: string, maxLines = 20, notificationCount = 0): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((a) => a.status === "running").length;
	const queuedAgents = agents.filter((a) => a.status === "queued").length;
	const waitingAgents = agents.filter((a) => a.status === "waiting").length;
	const completedAgents = agents.filter((a) => a.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (waitingAgents) parts.push(`${waitingAgents} waiting`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	return `${runningGlyph} Crew agents${notificationBadge(notificationCount)} · ${parts.join(" · ")} · /team-dashboard`;
}

// ── Agent ordering (shared with the inline panel) ──────────────────────

/**
 * L-4: prioritize RUNNING > QUEUED > WAITING so the most relevant live workers
 * are always shown first. Finished rows fill only the leftover budget and never
 * steal a slot from an active agent.
 */
const ACTIVE_PRIORITY: Record<string, number> = { running: 0, queued: 1, waiting: 2 };

function isActiveStatus(status: string): boolean {
	return status === "running" || status === "queued" || status === "waiting";
}

/**
 * The agent order the widget paints, split into its two sections.
 *
 * Exported because the inline panel navigates the same list: if the panel
 * derived its own order, the cursor index would drift from the rendered rows.
 * One function, one order.
 */
export function orderWidgetAgents(entry: WidgetRun, now = Date.now()): { active: CrewAgentRecord[]; finished: CrewAgentRecord[] } {
	const active = entry.agents.filter((agent) => isActiveStatus(agent.status));
	const finished = entry.agents.filter((agent) => {
		if (isActiveStatus(agent.status)) return false;
		if (!agent.completedAt) return false;
		const maxAgeMs = (ERROR_STATUSES.has(agent.status) ? ERROR_LINGER_MAX_AGE : FINISHED_LINGER_MAX_AGE) * 60_000;
		const age = now - new Date(agent.completedAt).getTime();
		return Number.isFinite(age) && age < maxAgeMs;
	});
	return {
		active: [...active].sort((a, b) => (ACTIVE_PRIORITY[a.status] ?? 9) - (ACTIVE_PRIORITY[b.status] ?? 9)),
		finished,
	};
}

// ── Line builder ──────────────────────────────────────────────────────

/**
 * Row layout for the per-agent lines.
 *
 * - `detailed` — the historical two-line tree (name row + `⊶ activity` row).
 * - `compact`  — one width-budgeted line per agent, so a wide terminal shows the
 *   full description instead of the same clip a narrow one gets.
 */
export type WidgetRowStyle = "compact" | "detailed";

export interface WidgetRenderOptions {
	rowStyle?: WidgetRowStyle;
	/** Task id under the inline panel cursor, if any. */
	selectedTaskId?: string;
	/** Task id whose transcript pane is open, if any. */
	viewedTaskId?: string;
	/**
	 * True while the inline panel holds the cursor. Every agent is then listed
	 * (no MAX_AGENTS_DISPLAY cap) so keyboard navigation can reach all of them;
	 * the idle widget stays capped to keep the prompt area small.
	 */
	focused?: boolean;
}

export function buildWidgetLines(
	cwd: string,
	frame = 0,
	maxLines = 8,
	providedRuns?: WidgetRun[],
	notificationCount = 0,
	width = DEFAULT_WIDGET_WIDTH,
	options: WidgetRenderOptions = {},
): string[] {
	const rowStyle: WidgetRowStyle = options.rowStyle ?? "detailed";
	const focused = options.focused === true;
	// Match the legacy `buildCrewWidgetLines` API: when no runs are supplied,
	// auto-fetch via activeWidgetRuns(cwd). Otherwise widgets calling with
	// only `(cwd, frame)` would render an empty line set (regression vs. the
	// pre-refactor implementation that called activeWidgetRuns here).
	const runs = providedRuns ?? activeWidgetRuns(cwd);
	if (!runs.length) return [];

	const runningGlyph = spinnerFrame("widget-header");
	const lines: string[] = [widgetHeader(runs, runningGlyph, maxLines, notificationCount)];

	for (const entry of runs) {
		const { run, agents, snapshot } = entry;
		const now = Date.now();
		const { active: activeAgents, finished: finishedAgents } = orderWidgetAgents(entry, now);
		const completed = agents.filter((a) => a.status === "completed").length;
		// WP-3 (H4): while a run is parked awaiting plan approval, the spinner
		// glyph is replaced by a `⚠ plan:<last-8 runId>` badge. Plain-unicode ⚠
		// (the same glyph needs_attention already uses) stays legible in no-color
		// mode and is colorized by the shared colorizeStatusGlyphs pass. In-place
		// glyph swap only — no extra line, so the MAX_AGENTS_DISPLAY / maxLines
		// budget and the truncate(width) rule are untouched.
		const planPending = isPlanApprovalStatePending(run.planApproval);
		const runGlyph = planPending ? `⚠ plan:${run.runId.slice(-8)}` : iconForStatus(run.status, { runningGlyph });
		const isTerminal = isFinishedRunStatus(run.status);
		// Run progress line. v1–v3 flickered on snapshot.tasks state, v4 was
		// too minimal (`0/1 agents` only), v5 duplicated the worker activity
		// line (tools/tokens/duration already shown one row below). v6 (this)
		// shows only data that is RUN-level (not already in the per-agent
		// activity line) and is GUARANTEED stable across ticks:
		//   - agents count — from `agents` array, always populated, never empty.
		//   - run elapsed   — from `run.createdAt`, always set on manifest.
		// Both come from sources with no race window — `agents` is read from
		// snapshot.agents OR agentsFor(run) (both always return same length
		// for a healthy run), and `run.createdAt` is immutable. The format
		// shape `"X/Y agents · Ns"` is therefore truly invariant: same number
		// of `·`-separated fields, same field meanings, every render tick.
		//
		// Bug 022 (timer-fix + label): for TERMINAL runs (failed/cancelled/
		// completed) the elapsed counter previously kept ticking up forever
		// from createdAt (a failed run showed `2028s` and climbing, read as
		// "still running"). Now it FREEZES at updatedAt (when the run
		// reached its terminal status). The status label is also surfaced
		// explicitly so the row cannot be misread as an active run.
		const agentCountText = `${completed}/${agents.length} agents`;
		const runEndMs = isTerminal ? new Date(run.updatedAt).getTime() : now;
		const runElapsedMs = Math.max(0, Number.isFinite(runEndMs) ? runEndMs - new Date(run.createdAt).getTime() : 0);
		const runElapsedText = `${Math.floor(runElapsedMs / 1000)}s`;
		const statusLabel = isTerminal ? ` · ${run.status}` : "";
		const progressPart = `${agentCountText} · ${runElapsedText}${statusLabel}`;
		lines.push(truncate(`├─ ${runGlyph} ${shortRunLabel(run)} · ${progressPart} · ${run.runId.slice(-8)}`, width));

		const liveForRun = listLiveAgents().filter((a) => a.runId === run.runId);

		// Focused: list every agent so the keyboard cursor can reach it. Idle: keep
		// the historical cap so the prompt area stays small.
		const activeCap = focused ? activeAgents.length : MAX_AGENTS_DISPLAY;
		// Finished rows only appear in slots not used by active agents (max 2). When
		// there are >= MAX_AGENTS_DISPLAY live workers, finished rows are suppressed
		// entirely so they cannot push a live agent's activity line off-screen.
		const finishedSlots = focused ? finishedAgents.length : Math.max(0, Math.min(2, MAX_AGENTS_DISPLAY - activeAgents.length));

		/** Cursor marker column, mirroring the inline panel's selection. */
		const markerFor = (taskId: string): string => (options.selectedTaskId === taskId ? "❯" : " ");

		const visibleAgents = activeAgents.slice(0, activeCap);
		for (const [index, agent] of visibleAgents.entries()) {
			const last = index === visibleAgents.length - 1 && activeAgents.length <= activeCap && finishedSlots === 0;
			const branch = last ? "└─" : "├─";
			const liveHandle = liveForRun.find((h) => h.taskId === agent.taskId);
			// The agent open in the pane gets the filled glyph, everything else its
			// status glyph — pi-subtask's filled/hollow "where am I" convention.
			const agentGlyph = options.viewedTaskId === agent.taskId ? "⏺" : iconForStatus(agent.status, { runningGlyph });
			const stats = agentStats(agent, liveHandle);
			const name = liveHandle?.agent ?? agent.agent;
			const activity = agentActivity(agent, liveHandle);
			if (rowStyle === "compact") {
				const label = liveHandle?.description ?? agent.role ?? "";
				lines.push(
					budgetedRow(
						{
							lead: `│ ${markerFor(agent.taskId)}${agentGlyph} `,
							name: label ? `${name} · ${label}` : name,
							activity,
							suffix: stats ? ` · ${stats}` : "",
						},
						width,
					),
				);
				continue;
			}
			const desc = truncate(liveHandle?.description ?? agent.role ?? "", TASK_DESC_MAX);
			const _activeMain = truncate(`│  ${branch} ${agentGlyph} ${name}${desc ? ` · ${desc}` : ` · ${agent.role}`}`, width);
			lines.push(_activeMain);
			const _activity = truncate(`│     ⊶ ${activity}${stats ? ` · ${stats}` : ""}`, width);
			lines.push(_activity);
		}

		if (activeAgents.length > activeCap) {
			lines.push(truncate(`│  └─ … +${activeAgents.length - activeCap} more agents`, width));
		}

		for (const [index, agent] of finishedAgents.slice(0, finishedSlots).entries()) {
			const liveHandle = liveForRun.find((h) => h.taskId === agent.taskId);
			const name = liveHandle?.agent ?? agent.agent;
			const icon =
				agent.status === "completed" ? "✓" : agent.status === "failed" ? "✗" : agent.status === "needs_attention" ? "⚠" : "▪";
			const stats = agentStats(agent, liveHandle);
			if (rowStyle === "compact") {
				const label = liveHandle?.description ?? agent.role ?? "";
				lines.push(
					budgetedRow(
						{
							lead: `│ ${markerFor(agent.taskId)}${icon} `,
							name: label ? `${name} · ${label}` : name,
							activity: agent.status,
							suffix: stats ? ` · ${stats}` : "",
						},
						width,
					),
				);
				continue;
			}
			const desc = truncate(liveHandle?.description ?? agent.role ?? "", TASK_DESC_MAX);
			const isLastFinished = index === Math.min(finishedAgents.length, finishedSlots) - 1;
			const branch = isLastFinished ? "└─" : "├─";
			const _finished = truncate(`│  ${branch} ${icon} ${name} · ${desc}${stats ? ` · ${stats}` : ""}`, width);
			lines.push(_finished);
		}

		if (lines.length >= maxLines) break;
	}

	return lines.slice(0, maxLines);
}

// ── Colorization ──────────────────────────────────────────────────────

export function colorWidgetLine(line: string, index: number, theme: CrewTheme): string {
	let result = line;
	if (index === 0) {
		result = result.replace("Crew agents", theme.bold(theme.fg("accent", "Crew agents")));
	}
	// Shared glyph colorizer covers ALL status glyphs — including ⏳ (waiting),
	// ⚠ (needs_attention), and the braille spinner range ⠁-⣿ (running) — which the
	// previous local statusGlyphColor map + regex omitted (F-1, V-3).
	result = colorizeStatusGlyphs(result, theme);
	if (index === 0) {
		result = theme.fg("accent", result);
	}
	return result;
}

export function renderLines(lines: string[], width: number): string[] {
	const box = new Box(0, 0);
	for (const line of lines) {
		box.addChild(new Text(line));
	}
	return box.render(width);
}
