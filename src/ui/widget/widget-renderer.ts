/**
 * Widget rendering — builds and colorizes widget lines.
 *
 * Extracted from crew-widget.ts.
 */

import { getCrewScheduler, getScheduledJobs, getScheduledJobsHiddenCountView } from "../../extension/team-tool/handle-schedule.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { isPlanApprovalStatePending } from "../../runtime/plan-approval.ts";
import { isFinishedRunStatus } from "../../runtime/process-status.ts";
import type { ScheduledJob } from "../../runtime/scheduling/scheduler.ts";
import { formatRelativeTime } from "../../utils/relative-time.ts";
import { truncate, visibleWidth } from "../../utils/visual.ts";
import { Box, Text } from "../layout-primitives.ts";
import { ACTIVE, RAIL, type RailSlot, railLeaders, railRaw, shortId, statusSlot } from "../rail.ts";
import { spinnerFrame } from "../spinner.ts";
import { colorizeStatusGlyphs } from "../status-colors.ts";
import { asCrewTheme, type CrewTheme } from "../theme-adapter.ts";
import { notificationBadge } from "./widget-formatters.ts";
import { activeWidgetRuns, shortRunLabel } from "./widget-model.ts";
import type { WidgetRun } from "./widget-types.ts";

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

// ── RAIL dock composition (design system §2.B) ─────────────────────────
//
// The dock is the ONE surface that must never grow a second row: it speaks the
// rail grammar with the BODY glyph (`┃`) only — never `┏`/`┗`, which imply a
// multi-line card. The builders below return PLAIN text (that is the exported
// contract: `buildWidgetLines` is the raw row, `colorWidgetLine` the paint
// pass), but they COMPOSE through the shared rail helpers with a no-op theme
// so the glyph/leader vocabulary lives in `rail.ts` alone.
const PLAIN_THEME = asCrewTheme(undefined);

/** Identity word of the dock + status bar. */
const DOCK_WORD = "CREW";

/** The dock's tail: four leaders + the one-key entry hint. */
const DOCK_HINT_RIGHT = "↓·enter";
const DOCK_HINT = `···· ${DOCK_HINT_RIGHT}`;

/** The dock's FOCUS marker (RAIL §2.B: "focused row keeps the `❯ ` prefix").
 *  It is deliberately not `rail.ts`'s `CURSOR` (`›`) — that glyph marks the
 *  selected row of a LIST; the dock is a single line, and `❯` is the marker
 *  the prompt area has always acknowledged the ↓ keystroke with. */
const FOCUS_MARKER = "❯";

/**
 * `···· ↓·enter` appended to a dock row. Composed through `railLeaders` with a
 * budget that pins the leader run at exactly four dots — the dock is a
 * left-aligned single row, so the leaders must NOT stretch to the terminal
 * width the way a card's metrics→elapsed leaders do.
 */
function dockTail(left: string, theme: CrewTheme, maxWidth?: number): string {
	const pinned = visibleWidth(left) + visibleWidth(DOCK_HINT_RIGHT) + 6;
	// The pin gives a fixed four-dot leader on a wide terminal. On a NARROW one
	// the budget shrinks instead, so `railLeaders` trims the LEFT segment (with
	// `…`) and the actionable `↓·enter` hint never gets clipped away — the live
	// row used to end in `↓…` at 50 columns.
	const budget = maxWidth === undefined ? pinned : Math.min(pinned, maxWidth - 2);
	return railLeaders(left, DOCK_HINT_RIGHT, budget, theme);
}

/** `CREW ▸ <subject>` — the dock identity (colour is applied on the paint pass). */
function dockIdentity(subject: string): string {
	return subject ? `${DOCK_WORD} ${ACTIVE} ${subject}` : DOCK_WORD;
}

/** `┃ <content>` — the dock rail, unpadded (`truncate` stays the single clip). */
function dockLine(content: string, theme: CrewTheme, slot: RailSlot): string {
	return railRaw(RAIL.body, slot, content, theme);
}

/**
 * Aggregate run status → the dock's rail colour (§2.B: rail colour = state).
 * A failure outranks live work; live work outranks idle. Zero runs is idle.
 */
export function widgetRailSlot(runs: readonly WidgetRun[]): RailSlot {
	if (runs.length === 0) return "border";
	const slots = runs.map((entry) => statusSlot(entry.run.status));
	if (slots.includes("error")) return "error";
	if (slots.includes("borderAccent")) return "borderAccent";
	return slots[0] ?? "border";
}

/** `<team>` (or `team/workflow` when they differ); several live runs collapse
 *  to `<n> runs` — the counts on the row stay aggregate. */
function dockSubject(runs: WidgetRun[]): string {
	if (runs.length > 1) return `${runs.length} runs`;
	const first = runs[0];
	return first ? shortRunLabel(first.run) : "idle";
}

/**
 * The zero-run dock row: `┃ CREW ▸ idle · ⏰ 1 sched ···· ↓·enter`.
 *
 * Returns `undefined` when nothing schedules-related paints. The keep-alive
 * path MUST then render NOTHING (`[]`) — a bare hint, and above all the
 * literal `undefined — ↓·enter`, is the live regression this guards against.
 */
export function idleWidgetLine(schedLine: string | undefined, focused = false, maxWidth?: number): string | undefined {
	if (!schedLine) return undefined;
	const left = `${dockIdentity("idle")} · ${schedLine}`;
	const line = dockLine(dockTail(left, PLAIN_THEME, maxWidth), PLAIN_THEME, "border");
	return focused ? `${FOCUS_MARKER} ${line}` : line;
}

/**
 * The dock's leading activity glyph: a braille spinner ONLY while something is
 * actually running, otherwise the outcome glyph of the aggregate state.
 *
 * Live-run bug (2026-09-16): the dock spun forever because `buildWidgetLines`
 * always passed `spinnerFrame("widget-header")` — a finished run painted
 * `┃ ⠹ CREW ▸ fast-fix · 0 running · 3/3 done`, i.e. a spinner with nothing to
 * spin for. `✓`/`✗` are used (not `●`/`✖`) because they are in
 * `STATUS_GLYPH_CHARS`, so the shared colorizer paints them.
 */
export function widgetActivityGlyph(runs: readonly WidgetRun[]): string {
	const anyAgentRunning = runs.some((entry) => entry.agents.some((agent) => agent.status === "running"));
	const anyRunRunning = runs.some((entry) => entry.run.status === "running");
	if (anyAgentRunning || anyRunRunning) return spinnerFrame("widget-header");
	const slot = widgetRailSlot(runs);
	if (slot === "error") return "✗";
	if (slot === "success") return "✓";
	return "";
}

// ── Header ────────────────────────────────────────────────────────────

/**
 * The dock's ONE row (RAIL §2.B):
 *
 *   `┃ ⠧ CREW ▸ fast-fix · 2 running · 3/5 done · ⏰ 1 sched ···· ↓·enter`
 *
 * Zero runs paint `┃ CREW ▸ idle · …` (see `idleWidgetLine`) instead. Returns
 * PLAIN text — the component colorizes index 0 with `colorWidgetLine`.
 */
export function widgetHeader(
	runs: WidgetRun[],
	runningGlyph: string,
	maxLines = 20,
	notificationCount = 0,
	schedSegment?: string,
	maxWidth?: number,
): string {
	const agents = runs.flatMap((item) => item.agents);
	const segments: string[] = [];
	if (runs.length > 0) {
		const runningAgents = agents.filter((a) => a.status === "running").length;
		const queuedAgents = agents.filter((a) => a.status === "queued").length;
		const waitingAgents = agents.filter((a) => a.status === "waiting").length;
		const completedAgents = agents.filter((a) => a.status === "completed").length;
		// Zero counts are noise on a one-line dock: a finished run reads
		// `3/3 done`, not `0 running · 3/3 done`.
		if (runningAgents) segments.push(`${runningAgents} running`);
		if (queuedAgents) segments.push(`${queuedAgents} queued`);
		if (waitingAgents) segments.push(`${waitingAgents} waiting`);
		if (completedAgents) segments.push(`${completedAgents}/${agents.length} done`);
		// WP-3 on the single line (2026-09-14 round 2): a run parked awaiting plan
		// approval surfaces as a `⚠ plan:<run8>` segment — the row-level badge is
		// gone with the run tree, so the count row carries the signal.
		const planPending = runs.find((item) => isPlanApprovalStatePending(item.run.planApproval));
		if (planPending) segments.push(`⚠ plan:${shortId(planPending.run.runId)}`);
	}
	// Tier C: `schedSegment` is the ALREADY-BUILT `⏰ …` string (jobs, hidden
	// count and clock are all injected upstream — buildWidgetLines); undefined
	// means nothing schedules-related paints.
	if (schedSegment) segments.push(schedSegment);
	// Bug 021: the alerts badge is one more segment (no 🔔, capped at 99+).
	const badge = notificationBadge(notificationCount)
		.replace(/^\s*·\s*/, "")
		.trim();
	if (badge) segments.push(badge);
	const head = runningGlyph ? `${runningGlyph} ${dockIdentity(dockSubject(runs))}` : dockIdentity(dockSubject(runs));
	const left = segments.length > 0 ? `${head} · ${segments.join(" · ")}` : head;
	return dockLine(dockTail(left, PLAIN_THEME, maxWidth), PLAIN_THEME, "border");
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
	/** Task id under the inline panel cursor, if any. */
	selectedTaskId?: string;
	/** Task id whose transcript pane is open, if any. */
	viewedTaskId?: string;
	/**
	 * True while the inline panel holds the cursor. The inline panel then
	 * gets a visible cursor acknowledgement; the idle widget stays compact
	 * to keep the prompt area small.
	 */
	focused?: boolean;
	/**
	 * Injected clock (dialect D6-T4) for the Tier-C schedules line — pinned by
	 * tests; defaults to "now" at the top of buildWidgetLines. The pure
	 * schedules builder never reads the clock itself.
	 */
	now?: Date;
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
	// SINGLE-LINE DOCK (design system §2.B, maintainer design 2026-09-14): the
	// dock paints EXACTLY ONE row — `┃ <identity> · counts · schedules ····
	// ↓·enter`. No per-agent rows, no run tree, no scroll window; ALL browsing
	// lives in the Agents & Jobs browser, opened by ↓·enter from THIS line
	// (crew-editor: idle enter at the line target = browser). The rail glyph is
	// always `┃` — `┏`/`┗` would imply a multi-line card.
	//
	// Focused (the ↓ cursor sits ON this line): prefix a ❯ marker so the
	// keystroke is visibly acknowledged — the line itself is the cursor target;
	// there is no second row to land on. maxLines/frame remain in the signature
	// for call-site compatibility; a single line is always within budget.
	const schedLine = schedulesWidgetLine(cwd, options.now ?? new Date());
	const runs = providedRuns ?? activeWidgetRuns(cwd);
	const focused = options.focused === true;
	if (!runs.length) {
		// Zero runs keep-alive (Tier C): jobs are exactly what run while no
		// interactive run is active. The ⏰ segment stands alone as the row; with
		// no schedules either there is NOTHING to paint — `[]`, never a bare
		// hint and never the literal `undefined — ↓·enter` (live bug 2026-09-16).
		const idle = idleWidgetLine(schedLine, focused);
		return idle ? [truncate(idle, width)] : [];
	}
	const base = widgetHeader(runs, widgetActivityGlyph(runs), maxLines, notificationCount, schedLine, width);
	return [truncate(focused ? `${FOCUS_MARKER} ${base}` : base, width)];
}

// ── Colorization ──────────────────────────────────────────────────────

/**
 * Paint pass for a PLAIN dock/plan line (`index 0` = the identity row).
 *
 * The builders above return plain text, so this adds the identity/rail/chrome
 * colours: the leading `┃` (or plan `┏`) takes the rail slot — `statusSlot` of
 * the aggregate run status, injected by the component — the identity word goes
 * accent+bold, and the tail hint is dimmed. Lines that were ALREADY built with
 * a real theme (the task-list variant builds through `rail.ts` directly) carry
 * escapes and are passed through untouched, apart from the shared glyph
 * colorizer below.
 */
export function colorWidgetLine(line: string, index: number, theme: CrewTheme, slot: RailSlot = "border"): string {
	let result = line;
	if (index === 0 && !result.includes("\u001b")) {
		// `┏|┃ <WORD> ▸ <subject>`: rail glyph takes the state slot, the identity
		// word accent+bold, the subject toolTitle+bold. The subject is bounded by
		// the first ` ·` so a count segment can never be swallowed.
		result = result.replace(
			/^([❯] )?([┃┏]) (?:(\S+) )?((?:CREW|PLAN)(?: ▸ [^·]+?)?)(?= ·|$)/,
			(_match, cursor: string | undefined, glyph: string, spinner: string | undefined, identity: string) => {
				const [word = "", subject] = identity.split(" ▸ ");
				const tail = subject ? ` ${theme.fg("dim", ACTIVE)} ${theme.fg("toolTitle", theme.bold(subject))}` : "";
				// The spinner is re-emitted raw: the shared glyph colorizer below
				// paints the braille range accent.
				return `${cursor ?? ""}${theme.fg(slot, glyph)} ${spinner ? `${spinner} ` : ""}${theme.fg("accent", theme.bold(word))}${tail}`;
			},
		);
		result = result.replace(DOCK_HINT, theme.fg("dim", DOCK_HINT));
	}
	// Shared glyph colorizer covers ALL status glyphs — including ⏳ (waiting),
	// ⚠ (needs_attention), and the braille spinner range ⠁-⣿ (running) — which the
	// previous local statusGlyphColor map + regex omitted (F-1, V-3).
	return colorizeStatusGlyphs(result, theme);
}

export function renderLines(lines: string[], width: number): string[] {
	const box = new Box(0, 0);
	for (const line of lines) {
		box.addChild(new Text(line));
	}
	return box.render(width);
}
