/**
 * Widget rendering — builds and colorizes widget lines.
 *
 * Extracted from crew-widget.ts.
 */

import { pathToFileURL } from "node:url";
import * as piTui from "@earendil-works/pi-tui";
import { getCrewScheduler, getScheduledJobs, getScheduledJobsHiddenCountView } from "../../extension/team-tool/handle-schedule.ts";
import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import { isPlanApprovalStatePending } from "../../runtime/plan-approval.ts";
import { isFinishedRunStatus } from "../../runtime/process-status.ts";
import type { ScheduledJob } from "../../runtime/scheduling/scheduler.ts";
import type { TeamRunManifest } from "../../state/types.ts";
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

/** The ` · ` the dock row joins its canopy and segments with. */
const DOCK_SEPARATOR = " · ";

/** Content-budget floor: a degenerate width still paints a (clipped) rail row. */
const MIN_DOCK_WIDTH = 8;

/** One ` · `-separated piece of the dock row, with its budget priority. */
interface DockPiece {
	text: string;
	/**
	 * L9 (ui-instability review 2026-10-07, T13 evidence: the 40-column dock
	 * rendered `1 runnin…`): `status` pieces (`2 running`, `3/5 done`, `⚠
	 * plan:<id>`) are ATOMIC — they render whole or drop as a unit, never
	 * split mid-word; `meta` pieces (`⏰ …`, alerts badge) are dropped first
	 * under width pressure. The subject (run id / label) clips LAST, with `…`
	 * at its own boundary — never a blind truncate() across a concatenation
	 * that mixes a must-survive token with a droppable one.
	 */
	kind: "status" | "meta";
}

/** Clip `text` at WORD boundaries (trailing words drop, `…` marks the
 *  elision) — the finest clip the dock ever applies inside a piece. */
function clipWords(text: string, budget: number): string {
	if (visibleWidth(text) <= budget) return text;
	const words = text.split(" ");
	let kept = words.length;
	while (kept > 1 && visibleWidth(words.slice(0, kept).join(" ")) > budget - 1) kept--;
	const base = words.slice(0, kept).join(" ");
	return visibleWidth(base) <= budget - 1 ? `${base}…` : truncate(text, budget);
}

/**
 * Compose the dock row's left side under a width budget, by explicit
 * priority (L9/T13): meta pieces drop first (right-to-left), then the subject
 * (id) clips with `…` at its own boundary, then the `↓·enter` hint yields,
 * and only then does a piece drop as a WHOLE unit. A status word is therefore
 * never split — the ellipsis only ever lands at a segment boundary.
 */
function budgetDockLeft(
	buildLeft: (subject: string, pieces: readonly DockPiece[]) => string,
	subject: string,
	pieces: readonly DockPiece[],
	/** Left budget while the hint rides (hint + the 2-space collapsed gap). */
	withHint: number,
	/** Left budget once the hint is dropped. */
	full: number,
): { left: string; hint: boolean } {
	let subjectText = subject;
	let kept = pieces;
	const current = (): string => buildLeft(subjectText, kept);
	const fits = (limit: number): boolean => visibleWidth(current()) <= limit;

	if (fits(withHint)) return { left: current(), hint: true };

	// (1) meta drops first, right-to-left — but never the row's LAST piece: an
	// idle row whose only piece is the schedule must clip it, not lose it (a
	// content-free row is indistinguishable from no row at all).
	while (kept.length > 1 && kept.at(-1)?.kind === "meta" && !fits(withHint)) kept = kept.slice(0, -1);
	if (fits(withHint)) return { left: current(), hint: true };

	// (2) the subject (id) clips — the lowest-priority clippable piece. `…`
	// lands at the subject's own boundary; the pieces stay untouched.
	const room = withHint - visibleWidth(buildLeft("", kept));
	subjectText = room >= 4 ? truncate(subject, room - 3) : "";
	if (fits(withHint)) return { left: current(), hint: true };

	// (3) the hint yields before ANY piece is dropped or mangled: status
	// outranks the affordance — `↓·enter` may survive per budget, never at the
	// cost of `1 running`.
	if (fits(full)) return { left: current(), hint: false };

	// (4) whole pieces drop right-to-left — status included, but as a UNIT.
	while (kept.length > 1 && !fits(full)) kept = kept.slice(0, -1);
	if (fits(full)) return { left: current(), hint: false };

	// (5) one piece left: meta clips word-wise (the idle schedule); a lone
	// status piece drops whole rather than split.
	const last = kept.at(-1);
	if (last?.kind === "meta") {
		const pieceBudget = full - visibleWidth(buildLeft(subjectText, [])) - visibleWidth(DOCK_SEPARATOR);
		kept = [{ kind: "meta", text: clipWords(last.text, Math.max(pieceBudget, 1)) }];
		if (fits(full)) return { left: current(), hint: false };
	}
	// (6) pathological width (< ~12 cols): the width invariant wins.
	return { left: truncate(buildLeft(subjectText, []), Math.max(full, 1)), hint: false };
}

/**
 * The dock's one row, composed under the segment-priority budget and laid
 * out with the `↓·enter` tail. The pin gives a fixed four-dot leader on a
 * wide terminal (`railLeaders`); on a NARROW one the budget shrinks instead,
 * so `budgetDockLeft` sacrifices meta → subject → hint → whole pieces — in
 * that order — and the actionable hint never gets clipped mid-glyph (the
 * live row used to end in `↓…` at 50 columns, and later in `1 runnin…` at
 * 40). The exact-fit gap is laid out HERE rather than through `railLeaders`:
 * its 0-slack branch cuts ONE visible char off the left side, which is
 * exactly the mid-token regression this composer exists to kill.
 */
function dockRow(args: {
	glyph: string;
	subject: string;
	subjectUrl: string | undefined;
	pieces: readonly DockPiece[];
	maxWidth?: number;
}): string {
	const { glyph, subjectUrl, pieces } = args;
	const buildLeft = (subjectText: string, kept: readonly DockPiece[]): string => {
		const identity = dockIdentity(linkify(subjectText, subjectUrl));
		const head = glyph ? `${glyph} ${identity}` : identity;
		return kept.length > 0 ? `${head}${DOCK_SEPARATOR}${kept.map((piece) => piece.text).join(DOCK_SEPARATOR)}` : head;
	};
	const pinned = visibleWidth(buildLeft(args.subject, pieces)) + visibleWidth(DOCK_HINT_RIGHT) + 6;
	const budget = args.maxWidth === undefined ? pinned : Math.min(pinned, Math.max(args.maxWidth, MIN_DOCK_WIDTH) - 2);
	const outcome = budgetDockLeft(buildLeft, args.subject, pieces, budget - visibleWidth(DOCK_HINT_RIGHT) - 2, budget);
	if (!outcome.hint) return outcome.left;
	const slack = budget - visibleWidth(outcome.left) - visibleWidth(DOCK_HINT_RIGHT) - 2;
	if (slack >= 3) return railLeaders(outcome.left, DOCK_HINT_RIGHT, budget, PLAIN_THEME);
	return `${outcome.left}  ${DOCK_HINT_RIGHT}`;
}

/** The dock's FOCUS marker (RAIL §2.B: "focused row keeps the `❯ ` prefix").
 *  It is deliberately not `rail.ts`'s `CURSOR` (`›`) — that glyph marks the
 *  selected row of a LIST; the dock is a single line, and `❯` is the marker
 *  the prompt area has always acknowledged the ↓ keystroke with. */
const FOCUS_MARKER = "❯";

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
 *  to `<n> runs` — the counts on the row stay aggregate. Returns the RAW
 *  label: the row budget clips it BEFORE the OSC-8 wrap, so a hyperlink
 *  sequence can never be sliced open (the link target survives whole). */
function dockSubjectLabel(runs: WidgetRun[]): string {
	if (runs.length === 0) return "idle";
	return runs.length > 1 ? `${runs.length} runs` : shortRunLabel(runs[0]!.run);
}

// ── R3-9: OSC-8 dock link ─────────────────────────────────────────────

type TuiHyperlink = (text: string, url: string) => string;

/** pi-tui's OSC-8 helper, resolved defensively: the peer range is `*`, so a
 *  host running a pi-tui build without the export must still render the
 *  plain dock instead of failing the namespace import. */
const tuiHyperlink: TuiHyperlink | undefined = (() => {
	const candidate = (piTui as { hyperlink?: unknown }).hyperlink;
	return typeof candidate === "function" ? (candidate as TuiHyperlink) : undefined;
})();

/** `file://` URL for an artifacts dir; `undefined` keeps the label plain. */
function artifactsDirUrl(artifactsRoot: string | undefined): string | undefined {
	if (!artifactsRoot) return undefined;
	try {
		return pathToFileURL(artifactsRoot).href;
	} catch {
		return undefined;
	}
}

/** Latest (by createdAt) run's artifacts dir — the dock link target. */
function latestArtifactsUrl(runs: readonly WidgetRun[]): string | undefined {
	let latest: TeamRunManifest | undefined;
	for (const entry of runs) {
		const candidate = entry.run;
		if (!candidate.artifactsRoot) continue;
		if (!latest || (candidate.createdAt ?? "") > (latest.createdAt ?? "")) latest = candidate;
	}
	return artifactsDirUrl(latest?.artifactsRoot);
}

/** Wrap in OSC-8 when both the pi-tui helper and a target exist; plain text
 *  otherwise (clean degrade on non-hyperlink terminals and older hosts). */
function linkify(text: string, url: string | undefined): string {
	if (!url || !tuiHyperlink) return text;
	return tuiHyperlink(text, url);
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
	const line = dockLine(
		dockRow({
			glyph: "",
			subject: "idle",
			subjectUrl: undefined,
			pieces: [{ text: schedLine, kind: "meta" }],
			// The focused ❯ prefix eats two columns of the same terminal row —
			// budget for it here so the final truncate stays a safety net, not
			// the clip.
			maxWidth: maxWidth === undefined ? undefined : Math.max(maxWidth - (focused ? 2 : 0), MIN_DOCK_WIDTH),
		}),
		PLAIN_THEME,
		"border",
	);
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
	const pieces: DockPiece[] = [];
	if (runs.length > 0) {
		const runningAgents = agents.filter((a) => a.status === "running").length;
		const queuedAgents = agents.filter((a) => a.status === "queued").length;
		const waitingAgents = agents.filter((a) => a.status === "waiting").length;
		const completedAgents = agents.filter((a) => a.status === "completed").length;
		// Zero counts are noise on a one-line dock: a finished run reads
		// `3/3 done`, not `0 running · 3/3 done`.
		if (runningAgents) pieces.push({ text: `${runningAgents} running`, kind: "status" });
		if (queuedAgents) pieces.push({ text: `${queuedAgents} queued`, kind: "status" });
		if (waitingAgents) pieces.push({ text: `${waitingAgents} waiting`, kind: "status" });
		if (completedAgents) pieces.push({ text: `${completedAgents}/${agents.length} done`, kind: "status" });
		// WP-3 on the single line (2026-09-14 round 2): a run parked awaiting plan
		// approval surfaces as a `⚠ plan:<run8>` segment — the row-level badge is
		// gone with the run tree, so the count row carries the signal.
		const planPending = runs.find((item) => isPlanApprovalStatePending(item.run.planApproval));
		if (planPending) pieces.push({ text: `⚠ plan:${shortId(planPending.run.runId)}`, kind: "status" });
	}
	// Tier C: `schedSegment` is the ALREADY-BUILT `⏰ …` string (jobs, hidden
	// count and clock are all injected upstream — buildWidgetLines); undefined
	// means nothing schedules-related paints.
	if (schedSegment) pieces.push({ text: schedSegment, kind: "meta" });
	// Bug 021: the alerts badge is one more segment (no 🔔, capped at 99+).
	const badge = notificationBadge(notificationCount)
		.replace(/^\s*·\s*/, "")
		.trim();
	if (badge) pieces.push({ text: badge, kind: "meta" });
	return dockLine(
		dockRow({
			glyph: runningGlyph,
			subject: dockSubjectLabel(runs),
			subjectUrl: latestArtifactsUrl(runs),
			pieces,
			maxWidth,
		}),
		PLAIN_THEME,
		"border",
	);
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
		const idle = idleWidgetLine(schedLine, focused, width);
		return idle ? [truncate(idle, width)] : [];
	}
	// The focused ❯ prefix eats two columns of the same terminal row: budget
	// for it here so the final truncate stays a safety net, never the clip.
	const headerWidth = focused ? Math.max(width - 2, MIN_DOCK_WIDTH) : width;
	const base = widgetHeader(runs, widgetActivityGlyph(runs), maxLines, notificationCount, schedLine, headerWidth);
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
	// R3-9: the guard detects THEME styling (CSI `ESC[`), not any escape — the
	// dock's OSC-8 artifacts link (introduced by `dockSubject`) is not styling
	// and must NOT opt the line out of the identity paint pass.
	if (index === 0 && !result.includes("\u001b[")) {
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
