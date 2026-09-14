/**
 * Widget rendering — builds and colorizes widget lines.
 *
 * Extracted from crew-widget.ts.
 */

import { getCrewScheduler, getScheduledJobs, getScheduledJobsHiddenCountView } from "../../extension/team-tool/handle-schedule.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import type { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import { isPlanApprovalStatePending } from "../../runtime/plan-approval.ts";
import { isFinishedRunStatus } from "../../runtime/process-status.ts";
import type { ScheduledJob } from "../../runtime/scheduling/scheduler.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { formatRelativeTime } from "../../utils/relative-time.ts";
import { truncate } from "../../utils/visual.ts";
import { Box, Text } from "../layout-primitives.ts";
import { spinnerFrame } from "../spinner.ts";
import { colorizeStatusGlyphs } from "../status-colors.ts";
import type { CrewTheme } from "../theme-adapter.ts";
import {
	agentActivity,
	budgetedRow,
	dockElapsed,
	dockStatusIcon,
	dockStatusLabel,
	dockUsageText,
	notificationBadge,
} from "./widget-formatters.ts";
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

export function widgetHeader(runs: WidgetRun[], runningGlyph: string, maxLines = 20, notificationCount = 0, schedSegment?: string): string {
	const agents = runs.flatMap((item) => item.agents);
	const runningAgents = agents.filter((a) => a.status === "running").length;
	const queuedAgents = agents.filter((a) => a.status === "queued").length;
	const waitingAgents = agents.filter((a) => a.status === "waiting").length;
	const completedAgents = agents.filter((a) => a.status === "completed").length;
	const parts = [`${runningAgents} running`];
	if (queuedAgents) parts.push(`${queuedAgents} queued`);
	if (waitingAgents) parts.push(`${waitingAgents} waiting`);
	if (completedAgents) parts.push(`${completedAgents}/${agents.length} done`);
	// WP-3 on the single line (2026-09-14 round 2): a run parked awaiting plan
	// approval surfaces as a `⚠ plan:<run8>` segment — the row-level badge is
	// gone with the run tree, so the count row carries the signal.
	const planPending = runs.find((item) => isPlanApprovalStatePending(item.run.planApproval));
	if (planPending) parts.push(`⚠ plan:${planPending.run.runId.slice(-8)}`);
	// Tier C (merged 2026-09-14): the header is the widget's ONE compact status
	// row in detailed mode — agent stats + the schedules segment on a single
	// line, with the `/team-dashboard` hint still trailing so it stays
	// reachable. `schedSegment` is the ALREADY-BUILT `⏰ …` string (jobs, hidden
	// count, and clock are all injected upstream — buildWidgetLines); undefined
	// means nothing schedules-related paints and the header stays
	// byte-identical to the pre-merge format.
	const sched = schedSegment ? ` · ${schedSegment}` : "";
	return `${runningGlyph} Crew agents${notificationBadge(notificationCount)} · ${parts.join(" · ")}${sched} — ↓·enter`;
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
	const runDone = isFinishedRunStatus(entry.run.status);
	const active = entry.agents.filter((agent) => isActiveStatus(agent.status));
	const finished = entry.agents.filter((agent) => {
		if (isActiveStatus(agent.status)) return false;
		if (!agent.completedAt) return false;
		// Mid-run, finished agents are the run's HISTORY: they must stay in
		// the dock until the RUN itself is done, not age out after a minute
		// while later phases are still working. The linger windows below only
		// apply once the run reached a terminal status (and the run-level
		// visibility grace then decides how much longer the dock shows at all).
		if (!runDone) return true;
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
	/**
	 * Injected clock (dialect D6-T4) for the Tier-C schedules line — pinned by
	 * tests; defaults to "now" at the top of buildWidgetLines. The pure
	 * schedules builder never reads the clock itself.
	 */
	now?: Date;
}

/** Short display form of a model id: `zai/glm-5.3` → `glm-5.3`. */
function shortModelLabel(agent: CrewAgentRecord, run: TeamRunManifest): string | undefined {
	const model = agent.model ?? run.modelContext?.parentModel ?? run.modelContext?.override;
	if (typeof model !== "string" || !model) return undefined;
	return model.split("/").at(-1) ?? model;
}

/** One flat dock row (pi-subtask style) for an agent — active or finished. */
function compactAgentRow(
	run: TeamRunManifest,
	agent: CrewAgentRecord,
	finished: boolean,
	runs: readonly WidgetRun[],
	options: WidgetRenderOptions,
	width: number,
	liveHandle: ReturnType<typeof listLiveAgents>[number] | undefined,
	nowMs: number,
): string {
	const marker = options.selectedTaskId === agent.taskId ? "❯" : " ";
	const dockGlyph = options.viewedTaskId === agent.taskId ? "⏺" : dockStatusIcon(agent.status);
	const name = liveHandle?.agent ?? agent.agent;
	const label = liveHandle?.description ?? agent.role ?? "";
	// Task-first: the agent exists to run its task, so the row names the task
	// right after the agent. With multiple runs, prefix each row with its run
	// label so the flat dock still says which run an agent belongs to.
	const runTag = runs.length > 1 ? `${shortRunLabel(run)} · ` : "";
	const taskTag = agent.taskId ? ` · ${agent.taskId}` : "";
	const roleTag = label && label !== agent.taskId && label !== name ? ` · ${label}` : "";
	const nameText = runTag + name + taskTag + roleTag;
	// pi-subtask activity: the worker's latest line while running, otherwise
	// the status word.
	const liveLine = liveHandle?.activity?.responseText
		?.split("\n")
		.find((line) => line.trim())
		?.trim();
	const activity =
		!finished && liveHandle?.status === "running" && liveLine
			? liveLine.length > 60
				? `${liveLine.slice(0, 60)}…`
				: liveLine
			: finished
				? dockStatusLabel(agent.status)
				: agentActivity(agent, liveHandle);
	const usage = dockUsageText(agent, liveHandle, { viewed: options.viewedTaskId === agent.taskId, nowMs });
	const ageText = dockElapsed(agent.completedAt ?? agent.startedAt);
	const model = shortModelLabel(agent, run);
	// Stats tail: `· glm-5.3 · ↑1.2k ↓350 · 41s` — the model the worker is
	// actually on first, then usage, then elapsed.
	const suffix = `${model ? ` · ${model}` : ""}${usage ? ` · ${usage}` : ""}${ageText ? ` · ${ageText}` : ""}`;
	return budgetedRow({ lead: `${marker} ${dockGlyph} `, name: nameText, activity, suffix }, width);
}

// ── Schedules line (Tier C) ───────────────────────────────────────────

/**
 * Tier C (schedules UI): the ONE low-priority schedules line for the crew
 * widget — `⏰ N sched · next Xm`. Painted when ≥1 ENABLED job exists, always
 * as the LAST row (below active-run info, per the widget priority rules),
 * with an optional compact `· N hidden` segment (P2-1) when the B2 gate is
 * hiding project-tier jobs. Pure (dialect D6-T4): jobs, the clock, AND the
 * hidden count are injected — no Date.now()/settings read happens here.
 * Returns undefined when the line must not paint (0 enabled jobs AND nothing
 * hidden), so callers skip the row entirely. With ZERO enabled jobs but a
 * hidden count > 0, the hidden-only line still paints — that is exactly the
 * all-gated case where an invisible gate used to show nothing at all.
 */
export function buildSchedulesWidgetLine(jobs: readonly ScheduledJob[], now: Date, hiddenCount = 0): string | undefined {
	const enabled = jobs.filter((job) => job.enabled);
	const hidden = hiddenCount > 0 ? ` · ${hiddenCount} hidden` : "";
	if (enabled.length === 0) return hiddenCount > 0 ? `⏰ 0 sched${hidden}` : undefined;
	const nextTargets = enabled
		// new Date(iso) here is a STORED-ISO parse, not a clock read.
		.map((job) => (job.nextRun ? new Date(job.nextRun).getTime() : Number.NaN))
		.filter((ms) => Number.isFinite(ms));
	if (nextTargets.length === 0) return `⏰ ${enabled.length} sched${hidden}`;
	const next = Math.min(...nextTargets);
	// "in 84m" → "next 84m": the future prefix is redundant right after
	// "next"; overdue targets keep their "Xm ago" tail so a stale nextRun
	// stays legible instead of silently reading as future work.
	const relative = formatRelativeTime(now, new Date(next)).replace(/^in /, "");
	return `⏰ ${enabled.length} sched · next ${relative}${hidden}`;
}

/**
 * Injectable scheduled-jobs reader for the widget (single source of truth,
 * G17): the default reads through getScheduledJobs(); tests swap in a stub
 * so the render path never touches real scheduler/settings state.
 *
 * The default is gated on a REGISTERED scheduler: without one (unit tests,
 * pre-registration, post-cleanup) there are no armed jobs to report — and we
 * must never hit the settings store from a paint path (P0-6: no disk per
 * render tick).
 */
export type WidgetScheduledJobsReader = (cwd: string) => ScheduledJob[];
let scheduledJobsReader: WidgetScheduledJobsReader = defaultScheduledJobsReader;

function defaultScheduledJobsReader(cwd: string): ScheduledJob[] {
	if (!getCrewScheduler()) return [];
	try {
		return getScheduledJobs(cwd);
	} catch {
		return [];
	}
}

/** @internal — test seam: inject a deterministic jobs view. */
export function setWidgetScheduledJobsReader(reader: WidgetScheduledJobsReader): void {
	scheduledJobsReader = reader;
}

/** @internal — test seam: restore the provider-backed default. */
export function resetWidgetScheduledJobsReader(): void {
	scheduledJobsReader = defaultScheduledJobsReader;
}

/** Injectable hidden-jobs reader (P2-1) — mirrors the jobs reader seam: the
 * default is gated on the REGISTERED scheduler exactly like
 * defaultScheduledJobsReader (P0-6 — a paint path must never hit the settings
 * store), and with a registered scheduler it only ever serves the in-memory
 * registration-time stash from handle-schedule.ts. */
export type WidgetHiddenJobsReader = (cwd: string) => number;
let hiddenJobsReader: WidgetHiddenJobsReader = defaultHiddenJobsReader;

function defaultHiddenJobsReader(_cwd: string): number {
	if (!getCrewScheduler()) return 0;
	return getScheduledJobsHiddenCountView(); // stash-only when registered: no disk
}

/** @internal — test seam: inject a deterministic hidden count. */
export function setWidgetHiddenJobsReader(reader: WidgetHiddenJobsReader): void {
	hiddenJobsReader = reader;
}

/** @internal — test seam: restore the stash-backed default. */
export function resetWidgetHiddenJobsReader(): void {
	hiddenJobsReader = defaultHiddenJobsReader;
}

/** Reader-backed schedules line — the widget's live data path. */
export function schedulesWidgetLine(cwd: string, now: Date): string | undefined {
	return buildSchedulesWidgetLine(scheduledJobsReader(cwd), now, hiddenJobsReader(cwd));
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
	// SINGLE-LINE WIDGET (maintainer design 2026-09-14, round 2): the dock
	// paints EXACTLY ONE row — counts only (running/queued/waiting/done
	// agents + the schedules segment + the ↓·enter interaction hint). No
	// per-agent rows, no run tree, no visible "main" row, no scroll window —
	// ALL browsing lives in the Agents & Jobs browser, opened by ↓·enter from
	// THIS line (crew-editor: idle enter at the line target = browser).
	//
	// Focused (the ↓ cursor sits ON this line): prefix a ❯ marker so the
	// keystroke is visibly acknowledged — the line itself is the cursor
	// target; there is no second row to land on. maxLines/frame remain in the
	// signature for call-site compatibility; a single line is always within
	// budget.
	const schedLine = schedulesWidgetLine(cwd, options.now ?? new Date());
	const runs = providedRuns ?? activeWidgetRuns(cwd);
	if (!runs.length) {
		// Zero runs keep-alive (Tier C): jobs are exactly what run while no
		// interactive run is active. The ⏰ segment stands alone as the row.
		const zero = schedLine ?? null;
		if (!zero) return [];
		const base = `${zero} — ↓·enter`;
		return [truncate(options.focused ? `❯ ${base}` : base, width)];
	}
	const runningGlyph = spinnerFrame("widget-header");
	const base = widgetHeader(runs, runningGlyph, maxLines, notificationCount, schedLine);
	return [truncate(options.focused ? `❯ ${base}` : base, width)];
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
