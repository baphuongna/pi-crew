import { humanizeSchedule, type ScheduledJob } from "../../runtime/scheduling/scheduler.ts";
import { formatRelativeTime } from "../../utils/relative-time.ts";
import { sanitizeLine, truncate } from "../../utils/visual.ts";
import { formatCount } from "../format-helpers.ts";
import { ACTIVE, CURSOR, formatHint, statusIcon } from "../rail.ts";
import { PANE_THEME } from "./pane-theme.ts";

/**
 * Schedules pane (tier A foundation) — pure string[] renderer following
 * health-pane.ts conventions: no clock reads (D6-T4 — `now` is an injected,
 * REQUIRED parameter), no color (the dashboard colorizes/truncates lines at
 * the emit pipeline), no provider import (callers pass jobs read via
 * getScheduledJobs() — the single source of truth, G17).
 */
export interface SchedulesPaneOptions {
	/** Max visual width of the job-name column before truncation. */
	nameWidth?: number;
	/** Show the interactive key hint (T/N/V/X/R). Dashboard-only; the headless
	 *  text block and non-foreground contexts pass false. Default true. */
	foreground?: boolean;
	/** Include the full job id in the sub line. The headless `/schedules`
	 *  text block needs ids so users can address jobs in `subAction=...` and
	 *  `/schedules log`. Default false. */
	includeIds?: boolean;
	/** Index of the cursor-selected job (dashboard pane 8). Prefixes the main
	 *  line with `›` exactly like the run-list selection marker; undefined
	 *  (headless / text-block callers) renders no marker. */
	selectedIndex?: number;
	/** P2-1 (B2 gate visibility): how many project-tier scheduledJobs the opt-in
	 *  gate is hiding. > 0 renders EXACTLY ONE dim hint line (why + count + the
	 *  opt-in path: BOTH flags in the USER-tier ~/.pi/crew-settings.json).
	 *  Omitted/0 renders nothing — existing layouts stay byte-identical. */
	hiddenCount?: number;
}

export const SCHEDULES_EMPTY_STATE = "No scheduled jobs — create via team tool action='schedule'";

/** Pane-8 actions in the ONE rail hint format (`formatHint`: keys `label`
 *  pairs joined by ` · `). Order preserved from the pre-migration hint. */
const ACTION_HINTS: ReadonlyArray<readonly [string, string]> = [
	["T", "toggle"],
	["N", "run now"],
	["V", "details"],
	["X", "delete"],
	["R", "refresh"],
];

/** P2-1 hint line (single source of truth — pane table, empty state, and the
 *  headless /schedules text block all render THIS text). Empty string when
 *  there is nothing to hint (callers render no line). Pure: no clock, no I/O;
 *  the count comes from the caller's provider read. */
export function schedulesHiddenJobsHintLine(hiddenCount: number): string {
	if (!Number.isFinite(hiddenCount) || hiddenCount <= 0) return "";
	const n = Math.floor(hiddenCount);
	return `⚠ ${n} project-tier job${n === 1 ? "" : "s"} hidden — opt in via ~/.pi/crew-settings.json: schedulingEnabled + allowProjectScheduledJobs`;
}

/**
 * Render the schedules table: one main line per job
 * (●/○ enabled · name · humanizeSchedule · next-run RELATIVE · last status
 * ✓/✗/⟳ · runCount) plus a sub line (subagentType · lastRun · id when
 * includeIds). Empty state is a single shared line.
 */
export function renderSchedulesPane(jobs: ScheduledJob[], now: Date, opts: SchedulesPaneOptions = {}): string[] {
	const hint = schedulesHiddenJobsHintLine(opts.hiddenCount ?? 0);
	if (jobs.length === 0) {
		// P2-1: the all-hidden case is exactly when a bare empty state lied —
		// the hint below it is the only signal project-tier jobs exist.
		return hint ? [SCHEDULES_EMPTY_STATE, hint] : [SCHEDULES_EMPTY_STATE];
	}
	const lines = [`Scheduled jobs (${jobs.length}):`];
	for (const [index, job] of jobs.entries()) {
		lines.push(...renderJobLines(job, now, opts, index === opts.selectedIndex));
	}
	if (hint) lines.push(hint);
	if (opts.foreground !== false) {
		lines.push(`Actions: ${formatHint(ACTION_HINTS)}`);
	}
	return lines;
}

/**
 * Plain text-block variant for the headless `/schedules` command (tier E).
 * Reuses the SAME renderer (no copied table logic): identical table + empty
 * state, interactive keys swapped for the non-interactive manage hint, and
 * job ids included so headless users can address them.
 */
export function renderSchedulesTextBlock(jobs: ScheduledJob[], now: Date, opts: SchedulesPaneOptions = {}): string[] {
	const lines = renderSchedulesPane(jobs, now, { ...opts, foreground: false, includeIds: true });
	if (jobs.length > 0) {
		lines.push("Manage: team action='schedule' subAction='enable|disable|remove|run-now' jobId='<id>'");
	}
	return lines;
}

function renderJobLines(job: ScheduledJob, now: Date, opts: SchedulesPaneOptions, selected: boolean): string[] {
	const glyph = job.enabled ? "●" : "○";
	const name = truncate(sanitizeLine(job.name ?? "?"), opts.nameWidth ?? 28);
	// The humanized schedule embeds the RAW job.schedule ("cron …"/"once at …")
	// — same untrusted persisted field the details view sanitizes, so the
	// main line gets the identical treatment (headless /schedules notify path
	// applies NO downstream sanitization — security review F-1).
	const schedule = sanitizeLine(humanizeSchedule({ kind: job.scheduleType ?? "once", spec: job.schedule ?? "?" }));
	const next = job.nextRun ? formatRelativeTime(now, new Date(job.nextRun)) : "—";
	// Cursor marker (dashboard pane 8): the RAIL `CURSOR` glyph on the selected
	// job, two spaces on the others — mirroring runLabel's marker. Callers that
	// pass NO selectedIndex (headless text block, foundation tests) get the
	// marker-free legacy layout byte-for-byte.
	const marker = opts.selectedIndex === undefined ? "" : selected ? `${CURSOR} ` : "  ";
	const main = `${marker}${glyph} ${name}  ${schedule} · ${next} · ${statusGlyph(job.lastStatus)} · ${formatCount(job.runCount ?? 0, "run")}`;
	return [main, renderSubLine(job, now, opts)];
}

/**
 * Last-run glyph from the shared RAIL vocabulary. `lastStatus` spells
 * success/error while `statusSlot`/`statusIcon` key off completed/failed, so
 * the two are translated instead of forked; "never ran" keeps the pane's own
 * `·` (rail has no such slot and would render `○`, the disabled/none glyph).
 */
function statusGlyph(status: ScheduledJob["lastStatus"]): string {
	if (status === "success") return statusIcon("completed", PANE_THEME);
	if (status === "error") return statusIcon("failed", PANE_THEME);
	if (status === "running") return statusIcon("running", PANE_THEME);
	return "·";
}

function renderSubLine(job: ScheduledJob, now: Date, opts: SchedulesPaneOptions): string {
	// Security review F-1: every persisted-field interpolation is sanitized —
	// the dashboard emit pipeline sanitizes whole lines, but the headless
	// /schedules text block goes to ui.notify verbatim, and subagentType/id
	// from a crafted settings entry must not inject line breaks there.
	// Persisted jobs are NOT schema-validated at read time, hence the `?? "?"`.
	const parts = [sanitizeLine(job.subagentType ?? "?")];
	parts.push(job.lastRun ? `last: ${formatRelativeTime(now, new Date(job.lastRun))}` : "last: never");
	// Duration: rendered only when the job model carries one ("duration if
	// available" in the approved design). ScheduledJob has no duration field
	// today, so nothing is invented here — a future field slots in below.
	if (opts.includeIds) parts.push(`id: ${sanitizeLine(job.id ?? "?")}`);
	return `  ◦ ${parts.join(" · ")}`;
}

/** Extract the full scheduling goal from a job's prompt payload. The create
 *  path stores `{ action: 'run', team, goal }` as JSON; older/foreign jobs may
 *  carry free text — fall back to description, then name. */
function scheduleGoalOf(job: ScheduledJob): string {
	try {
		const parsed = JSON.parse(job.prompt ?? "") as { goal?: unknown };
		if (parsed && typeof parsed === "object" && typeof parsed.goal === "string" && parsed.goal.length > 0) {
			return parsed.goal;
		}
	} catch {
		/* prompt is not JSON — fall through */
	}
	return job.description || job.name || "?";
}

/**
 * Details view for ONE job (dashboard pane 8, key V): full goal + schedule
 * spec + spawnedRunIds — everything the approved design lists for "details".
 * Pure, clock-injected (D6-T4), plain string[] like the table renderer; the
 * dashboard emit pipeline truncates/sanitizes per line.
 */
export function renderScheduleDetails(job: ScheduledJob, now: Date): string[] {
	// Persisted jobs are NOT schema-validated at read time (design system §2.G:
	// "guard every optional field") — sanitize AFTER the `?? "?"` fallback so a
	// missing field renders `?`, never `undefined`.
	const schedule = humanizeSchedule({ kind: job.scheduleType ?? "once", spec: job.schedule ?? "?" });
	const next = job.nextRun ? formatRelativeTime(now, new Date(job.nextRun)) : "—";
	const last = job.lastRun ? formatRelativeTime(now, new Date(job.lastRun)) : "never";
	return [
		`${ACTIVE} ${sanitizeLine(job.name ?? "?")} — id ${sanitizeLine(job.id ?? "?")}`,
		`  goal: ${sanitizeLine(scheduleGoalOf(job))}`,
		`  schedule: ${sanitizeLine(job.schedule ?? "?")} (${sanitizeLine(job.scheduleType ?? "?")}) · humanized: ${sanitizeLine(schedule)} · next: ${next}`,
		`  agent: ${sanitizeLine(job.subagentType ?? "?")} · runs: ${job.runCount ?? 0} · last: ${last} · status: ${statusGlyph(job.lastStatus)}`,
		`  spawned runs: ${job.spawnedRunIds?.length ? job.spawnedRunIds.map((runId) => sanitizeLine(String(runId ?? "?"))).join(", ") : "none"}`,
	];
}
