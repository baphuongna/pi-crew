/**
 * Widget formatting utilities.
 *
 * Extracted from crew-widget.ts for reuse and testability.
 */

import type { CrewAgentRecord } from "../../runtime/crew-agent-runtime.ts";
import type { LiveAgentHandle } from "../../runtime/live-session/live-agent-manager.ts";
import { getTaskUsage } from "../../runtime/usage-tracker.ts";
import { truncateToWidth, visibleWidth } from "../../utils/visual.ts";
import { computeLiveDurationMs } from "../live-duration.ts";

// ── No-color mode (UI-10) ─────────────────────────────────────────────
// Comprehensive color/emoji suppression. Color + emoji formatting is
// disabled when (a) NO_COLOR is set to a non-empty value (de-facto standard,
// https://bixense.com/clicolors/), OR (b) stdout is not a TTY (piped/
// redirected — escape codes & wide glyphs are noise there). Detected once at
// module init; `paint()` and the notification-badge emoji decision consult
// `colorEnabled`, so EVERY formatter in this file emits plain strings when the
// mode is active. Previously (line ~179) only the notification badge checked
// `NO_COLOR !== "1"` — a partial check that ignored the broader NO_COLOR-any-
// value standard and the non-TTY case, so color codes could still leak to
// pipes/logs. This makes the suppression uniform across the file.

const RESET = "\x1b[0m";
const ANSI_SGR_RE = /\u001b\[[0-9;]*m/g;

// Status foreground colors used by the activity formatters below.
const COLOR_RED = "\x1b[31m"; // failures
const COLOR_YELLOW = "\x1b[33m"; // needs-attention / warning

function computeColorEnabled(): boolean {
	if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
	// Treat both `false` and `undefined` (piped/redirected/captured) as non-TTY:
	// color is only enabled when stdout is positively a TTY.
	if (process.stdout?.isTTY !== true) return false;
	return true;
}

let colorEnabled = computeColorEnabled();

/**
 * Wrap `text` in an ANSI SGR sequence (e.g. `\x1b[31m`) when color is active.
 * In no-color mode the text is returned verbatim — no escape sequences — so the
 * formatters are safe to feed into logs, pipes, and other non-TTY sinks.
 */
function paint(text: string, sgr: string): string {
	if (!colorEnabled || !text) return text;
	return `${sgr}${text}${RESET}`;
}

/** Strip ANSI SGR escape sequences from a string. */
export function stripAnsi(text: string): string {
	return text.replace(ANSI_SGR_RE, "");
}

/** Re-evaluate the color mode from the current env/stdout (repeat of init). */
export function __resetColorMode(): void {
	colorEnabled = computeColorEnabled();
}

/** Test-only: force the color mode into a known state. */
export function __setColorModeForTest(enabled: boolean): void {
	colorEnabled = enabled;
}

// ── Token formatting ──────────────────────────────────────────────────

// V-1: fixed visible widths for per-agent numeric metrics so columns don't
// jitter every tick as values change width (e.g. 9.9s→10.0s, 950→1.0k).
// alignMetric right-aligns to the width; values wider than the width overflow
// verbatim (no truncation/crash) — these are rare one-off states, not jitter.
const TOOLS_METRIC_WIDTH = 8; // "127 tools"
const TOKENS_METRIC_WIDTH = 10; // "1.2k tok", "12.3M tok"
const TPS_METRIC_WIDTH = 9; // "411 tok/s"
const CTX_METRIC_WIDTH = 7; // "100% ctx"
const DURATION_METRIC_WIDTH = 6; // "120.0s"
const COST_METRIC_WIDTH = 9; // "$0.001234"

function alignMetric(value: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(value));
	return " ".repeat(pad) + value;
}

export function formatTokensCompact(count: number): string {
	// Display-layer guard: state records have at least once carried the
	// literal "***" in a numeric field (redaction false-positive, fixed at
	// the source). A string here would print `*** tok` verbatim, so non-
	// numeric/undefined input renders as an empty metric instead.
	if (typeof count !== "number" || !Number.isFinite(count)) return "";
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M tok`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k tok`;
	return `${count} tok`;
}

// ── Elapsed time ──────────────────────────────────────────────────────

export function elapsed(iso: string | undefined, now = Date.now()): string | undefined {
	if (!iso) return undefined;
	const ms = Math.max(0, now - new Date(iso).getTime());
	if (!Number.isFinite(ms)) return undefined;
	if (ms < 1000) return "now";
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
	return `${Math.floor(ms / 3_600_000)}h`;
}

/** pi-subtask's always-on elapsed tail: `0s` from the start (its fork rows
 *  flatten sub-second ages to 0 — not the legacy widget's "now"). */
export function dockElapsed(iso: string | undefined, now = Date.now()): string {
	const value = elapsed(iso, now);
	return value === undefined ? "" : value === "now" ? "0s" : value;
}

// ── Agent activity description ────────────────────────────────────────

const TOOL_LABELS: Record<string, string> = {
	read: "reading",
	bash: "running command",
	edit: "editing",
	write: "writing",
	grep: "searching",
	find: "finding files",
	ls: "listing",
};

const TOOL_ICONS: Record<string, string> = {
	read: "📖",
	bash: ">",
	edit: "✏",
	write: "📝",
	grep: "🔍",
	find: "📁",
	ls: "📋",
	agent: "🤖",
};

export function describeLiveActivity(handle: LiveAgentHandle): string {
	const act = handle.activity;
	if (act.activeTools.size > 0) {
		const groups = new Map<string, number>();
		for (const toolName of act.activeTools.values()) {
			groups.set(toolName, (groups.get(toolName) ?? 0) + 1);
		}
		const parts: string[] = [];
		for (const [toolName, count] of groups) {
			const icon = TOOL_ICONS[toolName] ?? "?";
			const label = TOOL_LABELS[toolName] ?? toolName;
			if (count > 1) {
				parts.push(`${icon}${count} ${label}s`);
			} else {
				parts.push(`${icon} ${label}`);
			}
		}
		return parts.join(", ") + "…";
	}
	if (act.responseText?.trim()) {
		const line =
			act.responseText
				.split("\n")
				.find((l) => l.trim())
				?.trim() ?? "";
		return line.length > 60 ? line.slice(0, 60) + "…" : line;
	}
	return "thinking…";
}

export function agentActivity(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
	if (liveHandle && liveHandle.status === "running") {
		const live = describeLiveActivity(liveHandle);
		if (live === "thinking…" && agent.progress?.currentTool)
			return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
		return live;
	}
	if (agent.progress?.currentTool) return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
	const recent = agent.progress?.recentOutput?.at(-1);
	if (recent) {
		const cleaned = recent.replace(/\s+/g, " ").trim();
		return cleaned.length > 60 ? cleaned.slice(0, 60) + "…" : cleaned;
	}
	if (agent.progress?.activityState === "needs_attention") return paint("needs attention", COLOR_YELLOW);
	if (agent.status === "queued") return "queued";
	if (agent.status === "running") {
		const age = agent.startedAt ? Date.now() - new Date(agent.startedAt).getTime() : Infinity;
		if (age < 5000 && !agent.progress?.currentTool) return "spawning…";
		return "thinking…";
	}
	if (agent.status === "failed") return paint(agent.error ?? "failed", COLOR_RED);
	return "done";
}

// ── Per-agent cost ────────────────────────────────────────────────────

/**
 * Compact per-agent spend for widget rows, or "" when there is nothing to
 * show. `formatCost`'s 6-decimal sub-cent output (`$0.001000`) wastes a third
 * of a one-line row, so the widget uses a short form: cent precision in
 * dollars, milli-precision below, and a `< $0.001` floor.
 */
export function formatCostCompact(cost: number): string {
	if (cost >= 1) return `$${cost.toFixed(2)}`;
	if (cost >= 0.01) return `$${cost.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
	if (cost >= 0.001) return `$${cost.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
	return "< $0.001";
}

/**
 * Formatted per-agent spend, or "" when there is nothing to show. The value
 * already lives on the durable task record and the dashboard agents pane has
 * shown it since Round 17; the widget omitted it only by oversight.
 */
export function agentCost(agent: CrewAgentRecord): string {
	const cost = agent.usage?.cost;
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return "";
	return formatCostCompact(cost);
}

// ── pi-subtask dock formatters ─────────────────────────────────────────

/**
 * pi-subtask's FIXED per-status glyphs (`statusIcon` in source/pi-subtask:
 * starting ○, running ✻, done ✓, failed ✗, stopped ■). The compact dock
 * deliberately does NOT spin the running marker like the legacy widget —
 * the row set is stable across ticks, which is what makes the keyboard
 * cursor feel anchored.
 */
export function dockStatusIcon(status: string): string {
	switch (status) {
		case "running":
			return "✻";
		case "queued":
		case "waiting":
			return "○";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "needs_attention":
			return "⚠";
		case "cancelled":
		case "stopped":
			return "■";
		default:
			return "?";
	}
}

/** pi-subtask uses the status word as a finished row's activity. */
export function dockStatusLabel(status: string): string {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "failed";
		case "cancelled":
		case "stopped":
			return "stopped";
		case "needs_attention":
			return "needs attention";
		case "queued":
			return "queued";
		case "waiting":
			return "waiting";
		default:
			return status;
	}
}

/** pi-subtask's formatTokens: raw under 1k, `Nk` under 1M, `N.M` above. */
export function tokenCountShort(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export interface DockUsageOptions {
	/** While the agent's pane is open: add tok/s + context % like pi-subtask. */
	viewed?: boolean;
	/** Model context window for the `P% / N` gauge; omitted when unknown. */
	contextWindow?: number;
}

/**
 * pi-subtask's footer-style usage (formatUsage): `↑in ↓out Rcache CH% $cost`,
 * plus `N tok/s` and `P% / window` while viewed. Live agents have split
 * input/output/cacheWrite via the usage tracker; non-live ones show the
 * durable token total + cost.
 */
export function dockUsageText(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle, options: DockUsageOptions = {}): string {
	const parts: string[] = [];
	if (liveHandle) {
		const usage = getTaskUsage(liveHandle.taskId);
		const input = usage.input ?? 0;
		const output = usage.output ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		if (input > 0) parts.push(`↑${tokenCountShort(input)}`);
		if (output > 0) parts.push(`↓${tokenCountShort(output)}`);
		if (cacheWrite > 0) parts.push(`R${tokenCountShort(cacheWrite)}`);
		const promptTokens = input + cacheWrite;
		if (cacheWrite > 0 && promptTokens > 0) {
			parts.push(`CH${((cacheWrite / promptTokens) * 100).toFixed(1)}%`);
		}
		const cost = agent.usage?.cost;
		if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(4)}`);
		if (options.viewed) {
			const act = liveHandle.activity;
			const ms = computeLiveDurationMs(act);
			const totalTokens = input + output + cacheWrite;
			if (totalTokens > 0 && ms > 1000) {
				const tps = Math.round(totalTokens / (ms / 1000));
				if (tps > 0) parts.push(`${tps} tok/s`);
			}
			try {
				const ctxPct = liveHandle.session.getSessionStats?.()?.contextUsage?.percent;
				if (ctxPct != null) {
					const window =
						options.contextWindow && options.contextWindow >= 1_000_000
							? `${(options.contextWindow / 1_000_000).toFixed(1)}M`
							: options.contextWindow
								? tokenCountShort(options.contextWindow)
								: "";
					parts.push(`${Math.round(ctxPct)}%${window ? ` / ${window}` : ""}`);
				}
			} catch {
				/* ignore */
			}
		}
		return parts.join(" ");
	}
	const tokens = agent.progress?.tokens;
	const tokenCount = typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
	if (tokenCount > 0) parts.push(`${tokenCountShort(tokenCount)} tok`);
	const cost = agent.usage?.cost;
	if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(4)}`);
	return parts.join(" ");
}

// ── Adaptive single-line row ───────────────────────────────────────────

export interface BudgetedRowParts {
	/** Marker + glyph prefix; never trimmed. */
	lead: string;
	/** Agent label; grows into whatever the activity leaves over. */
	name: string;
	/** Current activity; shrinks first but keeps a readable floor. */
	activity: string;
	/** Metrics tail; never trimmed, so numbers stay comparable across ticks. */
	suffix: string;
	separator?: string;
}

/** Smallest activity/name slice still worth showing before we drop the field. */
const MIN_FIELD_WIDTH = 12;

/**
 * Assemble one row that fills `width` without wrapping.
 *
 * `lead` and `suffix` are fixed costs; the remaining budget is split between
 * `name` and `activity`. The activity absorbs the trimming first (it changes
 * every tick anyway) but keeps a MIN_FIELD_WIDTH floor, and the name expands
 * into the rest up to its natural length — so a 200-column terminal shows the
 * full description instead of the same clip an 80-column one gets.
 *
 * The closing truncate is a hard guard, not an optimisation: pi's renderer
 * throws on a line wider than the terminal.
 */
export function budgetedRow(parts: BudgetedRowParts, width: number): string {
	const sep = parts.separator ?? " · ";
	const { lead, suffix } = parts;
	const name = parts.name.replace(/\s+/g, " ").trim();
	const activity = parts.activity.replace(/\s+/g, " ").trim();
	if (!name && !activity) return truncateToWidth(lead + suffix, width);
	if (!activity) return fitNameOnly(lead, name, suffix, width);
	if (!name) return fitNameOnly(lead, activity, suffix, width);

	const budget = width - visibleWidth(lead) - visibleWidth(suffix) - visibleWidth(sep);
	// Too narrow to hold name + activity above their floors: keep the name
	// only, and never let the metrics tail eat the clipping.
	if (budget < MIN_FIELD_WIDTH * 2) return fitNameOnly(lead, name, suffix, width);

	const nameNatural = visibleWidth(name);
	const activityNatural = visibleWidth(activity);
	const activityRoom = Math.min(activityNatural, Math.max(MIN_FIELD_WIDTH, budget - nameNatural));
	const nameRoom = Math.max(MIN_FIELD_WIDTH, budget - activityRoom);
	const assembled = lead + truncateToWidth(name, nameRoom) + sep + truncateToWidth(activity, activityRoom) + suffix;
	// The room arithmetic keeps this ≤ width by construction (nameRoom +
	// activityRoom ≤ budget in every branch); this guard is the last line of
	// defense because pi's renderer throws on over-width lines.
	if (visibleWidth(assembled) <= width) return assembled;
	return fitNameOnly(lead, name, suffix, width);
}

/**
 * Narrow-terminal fallback: fixed lead + suffix, the name absorbs every
 * remaining column. The metrics tail is sacred — it must stay comparable
 * across ticks — so clipping always happens in the middle fields.
 */
function fitNameOnly(lead: string, name: string, suffix: string, width: number): string {
	const fixed = visibleWidth(lead) + visibleWidth(suffix);
	if (fixed >= width) return truncateToWidth(lead + suffix, width);
	return lead + truncateToWidth(name, width - fixed) + suffix;
}

// ── Agent stats line ──────────────────────────────────────────────────

export function agentStats(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
	const parts: string[] = [];
	if (liveHandle) {
		const act = liveHandle.activity;
		if (act.toolUses > 0) parts.push(alignMetric(`${act.toolUses} tools`, TOOLS_METRIC_WIDTH));
		const usage = getTaskUsage(liveHandle.taskId);
		const total = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
		if (total > 0) parts.push(alignMetric(formatTokensCompact(total), TOKENS_METRIC_WIDTH));
		// The live usage tracker carries tokens only (LifetimeUsage has no cost
		// field), so cost always comes off the durable task record.
		const liveCost = agentCost(agent);
		if (liveCost) parts.push(alignMetric(liveCost, COST_METRIC_WIDTH));
		try {
			const stats = liveHandle.session.getSessionStats?.();
			const ctxPct = stats?.contextUsage?.percent;
			if (ctxPct != null) parts.push(alignMetric(`${Math.round(ctxPct)}% ctx`, CTX_METRIC_WIDTH));
		} catch {
			/* ignore */
		}
		const ms = computeLiveDurationMs(act);
		if (total > 0 && ms > 1000) {
			const tps = Math.round(total / (ms / 1000));
			if (tps > 0) parts.push(alignMetric(`${formatTokensCompact(tps)}/s`, TPS_METRIC_WIDTH));
		}
		parts.push(alignMetric(`${(ms / 1000).toFixed(1)}s`, DURATION_METRIC_WIDTH));
	} else {
		// Type-narrowed: state has carried the literal "***" (redaction
		// false-positive) in progress.tokens, which is truthy but not a count.
		// Only real numbers produce metrics; formatTokensCompact guards too.
		const tokens = agent.progress?.tokens;
		const tokenCount = typeof tokens === "number" ? tokens : undefined;
		if (agent.toolUses) parts.push(alignMetric(`${agent.toolUses} tools`, TOOLS_METRIC_WIDTH));
		if (tokenCount && tokenCount > 0) parts.push(alignMetric(formatTokensCompact(tokenCount), TOKENS_METRIC_WIDTH));
		const cost = agentCost(agent);
		if (cost) parts.push(alignMetric(cost, COST_METRIC_WIDTH));
		const ageMs = agent.startedAt ? Math.max(0, Date.now() - new Date(agent.startedAt).getTime()) : 0;
		if (tokenCount && tokenCount > 0 && ageMs > 1000) {
			const tps = Math.round(tokenCount / (ageMs / 1000));
			if (tps > 0) parts.push(alignMetric(`${formatTokensCompact(tps)}/s`, TPS_METRIC_WIDTH));
		}
		const age = elapsed(agent.completedAt ?? agent.startedAt);
		if (age) parts.push(alignMetric(age, DURATION_METRIC_WIDTH));
	}
	return parts.join(" · ");
}

// ── Notification badge ────────────────────────────────────────────────

// Bug 021: the bell glyph 🔔 was misread as "queued messages" — users saw
// `🔔227` and concluded there were 227 pending items, when the value is a
// CUMULATIVE warning/error/critical count with zero actual queue behind it.
// Fix: relabel to an explicit "alerts" segment (no bell) and cap the display
// at 99+ (standard badge practice). The cumulative count stays accurate
// internally (widgetState.notificationCount) and remains fully logged in
// .crew/state/notifications/YYYY-MM-DD.jsonl — this bounds presentation only.
// Deeper fixes (decay window, owner-scope, auto-reset on all-runs-terminal,
// full deprecation) are product decisions documented in
// docs/bugs/bug-021-notification-badge-counter-misleading.md.
export const NOTIFICATION_BADGE_CAP = 99;

export function notificationBadge(count: number | undefined, env: NodeJS.ProcessEnv = process.env): string {
	if (!count || count <= 0) return "";
	const term = `${env.TERM ?? ""} ${env.WT_SESSION ?? ""} ${env.TERM_PROGRAM ?? ""}`.toLowerCase();
	// UI-10: emoji is formatting too — gate it on the comprehensive color mode
	// (NO_COLOR / non-TTY) in addition to a per-call env NO_COLOR check (standard:
	// any non-empty value disables) and the dumb-terminal fallback.
	const envNoColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
	const supportsEmoji = colorEnabled && !envNoColor && !term.includes("dumb");
	const label = count > NOTIFICATION_BADGE_CAP ? `${NOTIFICATION_BADGE_CAP}+ alerts` : `${count} alerts`;
	return supportsEmoji ? ` · ${label}` : ` [${label}]`;
}
