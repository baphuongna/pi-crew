/**
 * RAIL design system — the shared visual language for EVERY pi-crew surface.
 *
 * Extracted from the tool-card renderer (R3, 2026-09-16) so the widget, the
 * dashboard, the agents & jobs browser, the settings overlay, the mailbox /
 * help / confirm / live-conversation overlays and the dashboard panes all
 * speak one grammar instead of each inventing its own frame.
 *
 * ── Grammar ───────────────────────────────────────────────────────────
 *
 *   ┏ ┣ ┃ ┗   one vertical rail down the LEFT edge marks a surface.
 *              `┏` opens it (identity), `┣` starts a section, `┃` continues
 *              it, `┗` closes it (outcome + end cap). The rail colour
 *              carries state: neutral idle, accent active, green success,
 *              red failure, warning attention.
 *
 *   `NAME ▸ SUBJECT`   the identity canopy: `┏ CREW ▸ implementation`,
 *                      `┏ AGENTS ▸ a3f9c1d2`, `┏ HELP ▸ dashboard`.
 *
 *   `······`           dot leaders join a left and a right segment
 *                      (`left ······ right`). They absorb all slack and
 *                      collapse to a two-space gap on a narrow column, so
 *                      the right segment (elapsed / key hint) never moves
 *                      and never wraps.
 *
 *   `▕████▎░░▏`        gauge with EIGHTH-BLOCK sub-cell precision.
 *
 *   `›` cursor · `▸` active/section marker · `▲ n above` / `▼ m below`
 *                      the single selection, active and overflow dialects.
 *
 * ── Width contract ────────────────────────────────────────────────────
 *
 * Every helper takes an explicit `budget` (content width = render width
 * minus the 2 columns of `glyph + space`) and NEVER emits a line wider than
 * it. Callers that render into a live TUI must defer width through
 * `AdaptiveCard` (see src/ui/adaptive-card.ts) rather than baking a width at
 * build time — that is the R2 lesson: a frame built for 116 columns tears
 * apart at 100.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import { truncateToWidth } from "../utils/visual.ts";
import type { CrewTheme, CrewThemeColor } from "./theme-adapter.ts";

// ── Glyph vocabulary ───────────────────────────────────────────────────

/** Rail glyphs: open, section, continue, close. */
export const RAIL = { open: "┏", section: "┣", body: "┃", close: "┗" } as const;

/**
 * Pi's own chord for collapsing/expanding a tool output block — the only key
 * that ACTUALLY expands a pi-crew card, so it is what the card caps advertise.
 *
 * Verified against pi 0.85.1 `docs/keybindings.md`: `app.tools.expand` = `ctrl+o`.
 * The cards used to print `⌘E`, which pi binds to `tui.editor.cursorLineEnd`
 * (move the EDITOR cursor to end of line) — a phantom affordance: pressing it
 * moved the cursor and left the card collapsed (live 2026-09-16).
 */
export const PI_EXPAND_CHORD = "ctrl+o";

/** Selection cursor (lists) and active/step marker (sections, goals). */
export const CURSOR = "›";
export const ACTIVE = "▸";

/** Canonical overflow dialect — the ONLY one; the old `↑ 3 more above`
 *  / `… 3 above` / `↓2` variants are retired. */
export const OVERFLOW = { above: "▲", below: "▼" } as const;

// ── ANSI-aware width helpers ───────────────────────────────────────────

/** Pad a string (which may contain ANSI codes) to a target VISUAL width. */
export function padVisual(str: string, targetWidth: number): string {
	const vw = visibleWidth(str);
	if (vw >= targetWidth) return str;
	return str + " ".repeat(targetWidth - vw);
}

/** Truncate a string (which may contain ANSI codes) to a target VISUAL width. */
export function truncVisual(str: string, maxWidth: number): string {
	if (visibleWidth(str) <= maxWidth) return str;
	// Round 23 (BUG 3): String.slice counts UTF-16 code units — for CJK that
	// overflows by up to 2x and for emoji it splits a surrogate pair. Use the
	// grapheme/ANSI-aware truncateToWidth with empty ellipsis (the caller
	// appends its own '…').
	return truncateToWidth(str, maxWidth, "");
}

/** Short id (last 8 chars — the disambiguating suffix). */
export function shortId(id: string | undefined): string {
	return id ? id.slice(-8) : "????????";
}

// ── Rail slots ─────────────────────────────────────────────────────────

export type RailSlot = "border" | "borderAccent" | "success" | "error" | "warning";

/** Status → rail colour. One mapping for every surface (was: per-surface maps). */
export function statusSlot(status: string | undefined): RailSlot {
	switch (status) {
		case "completed":
		case "done":
		case "succeeded":
		case "passed":
		case "healthy":
			return "success";
		case "failed":
		case "cancelled":
		case "error":
		case "stopped":
		case "dead":
			return "error";
		case "running":
		case "in_progress":
		case "streaming":
			return "borderAccent";
		case "waiting":
		case "needs_attention":
		case "stale":
		case "pending":
			return "warning";
		default:
			return "border";
	}
}

/** One rail line: `┃ <content padded to budget>`. The glyph+space separator is
 *  owned HERE so callers pass bare content and no line can spill past the rail. */
export function railLine(glyph: string, slot: RailSlot, content: string, theme: CrewTheme, budget: number): string {
	return theme.fg(slot, glyph) + " " + padVisual(truncVisual(content, budget), budget);
}

/** Content-only rail line (no padding) — for callers that pad themselves. */
export function railRaw(glyph: string, slot: RailSlot, content: string, theme: CrewTheme): string {
	return `${theme.fg(slot, glyph)} ${content}`;
}

/**
 * Left/right segments joined by dot leaders: `left ······· right`.
 * Leaders absorb all slack; on a tight column the left side is truncated so
 * the right segment (elapsed / key hint) always stays visible.
 */
export function railLeaders(left: string, right: string, budget: number, theme: CrewTheme): string {
	const slack = budget - visibleWidth(left) - visibleWidth(right) - 2;
	if (slack >= 3) {
		const dots = theme.fg("dim", "·".repeat(Math.min(slack, 120)));
		return `${left} ${dots} ${right}`;
	}
	if (slack > 0) return `${left}  ${right}`;
	const rightW = visibleWidth(right);
	const leftBudget = budget - rightW - 2;
	// When the left segment has to be cut, mark the elision with `…` — a hard
	// cut mid-word reads as a rendering bug (`Esc/Q clos  auto-scroll`).
	if (leftBudget > 4) return `${truncVisual(left, leftBudget - 1)}…  ${right}`;
	return truncVisual(`${left}  ${right}`, budget);
}

/** `┏ NAME ▸ SUBJECT` — the identity canopy, shared by every surface. */
export function canopyLine(args: {
	word: string;
	subject?: string;
	theme: CrewTheme;
	budget: number;
	slot?: RailSlot;
	glyph?: string;
	/** Trailing right-aligned segment (e.g. `1-8 pane · ? help`), dot-led. */
	right?: string;
}): string {
	const { word, subject, theme, budget, slot = "border", glyph = RAIL.open, right } = args;
	const tail = subject ? ` ${theme.fg("dim", ACTIVE)} ${theme.fg("toolTitle", theme.bold(subject))}` : "";
	const label = `${theme.fg("accent", theme.bold(word))}${tail}`;
	if (right) return railLine(glyph, slot, railLeaders(label, right, budget, theme), theme, budget);
	return railLine(glyph, slot, label, theme, budget);
}

/** `┣ SECTION ▸ subject` — replaces the legacy `── label ──` inline rule. */
export function sectionLine(args: {
	name: string;
	subject?: string;
	theme: CrewTheme;
	budget: number;
	slot?: RailSlot;
	right?: string;
}): string {
	const { name, subject, theme, budget, slot = "border", right } = args;
	const tail = subject ? ` ${theme.fg("dim", ACTIVE)} ${theme.fg("muted", subject)}` : "";
	const label = `${theme.fg("border", theme.bold(name.toUpperCase()))}${tail}`;
	if (right) return railLine(RAIL.section, slot, railLeaders(label, right, budget, theme), theme, budget);
	return railLine(RAIL.section, slot, label, theme, budget);
}

/** `▕████▎░░▏` — eighth-block sub-cell precision, truthful on narrow columns. */
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"] as const;

export function gaugeBar(ratio: number, barWidth: number, theme: CrewTheme, fill: CrewThemeColor = "success"): string {
	const clamped = Math.max(0, Math.min(1, ratio));
	const cells = clamped * barWidth;
	const full = Math.floor(cells);
	const partial = EIGHTHS[Math.round((cells - full) * 8)] ?? "";
	const filledCells = full + (partial ? 1 : 0);
	const empty = Math.max(0, barWidth - filledCells);
	const body = theme.fg(fill, "█".repeat(full) + partial);
	const rest = theme.fg("dim", "░".repeat(empty));
	return `${theme.fg("dim", "▕")}${body}${rest}${theme.fg("dim", "▏")}`;
}

/** Animated scanning gauge for indeterminate progress. */
export function scanGauge(barWidth: number, elapsedMs: number, theme: CrewTheme): string {
	const pos = Math.floor((elapsedMs / 400) % (barWidth + 6)) - 3;
	const segW = Math.max(3, Math.floor(barWidth * 0.3));
	let bar = "";
	for (let i = 0; i < barWidth; i++) {
		bar += i >= pos && i < pos + segW ? theme.fg("accent", "█") : theme.fg("dim", "░");
	}
	return `${theme.fg("dim", "▕")}${bar}${theme.fg("dim", "▏")}`;
}

/**
 * Producer emits `role/agent` (e.g. `verifier/verifier`). Collapse the
 * redundant half so a live row reads `verifier` — real run data showed the
 * duplication on every single-agent run.
 */
export function dedupeAgentLabel(label: string): string {
	const slash = label.indexOf("/");
	if (slash <= 0) return label;
	const role = label.slice(0, slash);
	const rest = label.slice(slash + 1); // "agent · tool" hoặc "agent"
	const agent = rest.split(" ")[0] ?? "";
	if (agent && role === agent) return `${role}${rest.slice(agent.length)}`;
	return label;
}

// ── Status glyphs ──────────────────────────────────────────────────────

/** Badge glyph, colour-coded (`●` done, `✖` failed, `◉` running, `○` other). */
export function statusBadge(status: string, theme: CrewTheme): string {
	switch (statusSlot(status)) {
		case "success":
			return theme.fg("success", "●");
		case "error":
			return theme.fg("error", "✖");
		case "borderAccent":
			return theme.fg("warning", "◉");
		default:
			return theme.fg("dim", "○");
	}
}

/** Compact status icon (`✓` done, `✗` failed, `⟳` running, `○` other). */
export function statusIcon(status: string, theme: CrewTheme): string {
	switch (statusSlot(status)) {
		case "success":
			return theme.fg("success", "✓");
		case "error":
			return theme.fg("error", "✗");
		case "borderAccent":
			return theme.fg("warning", "⟳");
		default:
			return theme.fg("dim", "○");
	}
}

/**
 * Canonical overflow hint. Replaces four dialects (`↑ N more above`,
 * `▲ N more above`, `… N above · M below`, `↓N`).
 */
export function overflowHint(above: number, below: number, theme: CrewTheme): string {
	const parts: string[] = [];
	if (above > 0) parts.push(`${OVERFLOW.above} ${above} above`);
	if (below > 0) parts.push(`${OVERFLOW.below} ${below} below`);
	return parts.length ? theme.fg("dim", parts.join(" · ")) : "";
}

// ── Hint text (one format for every surface) ───────────────────────────

/** `Esc` not `ESC`/`esc`; `Enter` not `⏎`; letter keys bare uppercase. */
export function keyToken(key: string): string {
	switch (key) {
		case "escape":
		case "esc":
		case "\u001b":
			return "Esc";
		case "return":
		case "enter":
		case "\r":
		case "\n":
			return "Enter";
		case "\t":
		case "tab":
			return "Tab";
		case "up":
		case "down":
			return "↑/↓";
		case "pageup":
			return "PgUp";
		case "pagedown":
			return "PgDn";
		case " ":
		case "space":
			return "Space";
		default:
			return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
	}
}

/**
 * `↑/↓ move · Enter select · Esc cancel` — the single hint format.
 *
 * Contract: `keys label` pairs joined by ` · `, the close/cancel action LAST,
 * keys rendered through `keyToken` (so `esc`/`ESC`/`q`-as-close collapse to one
 * spelling). Callers should feed keys from `keybinding-map.ts` so a remap
 * cannot silently desync the footer. Pass `{ exactKeys: true }` for a
 * case-sensitive keyspace (plan approval: `A` vs `n`).
 */
export function formatHint(
	pairs: ReadonlyArray<readonly [string | readonly string[], string]>,
	options: { exactKeys?: boolean } = {},
): string {
	return pairs
		.map(([keys, label]) => {
			const list = Array.isArray(keys) ? keys : [keys as string];
			// Dedupe AFTER mapping: `["up","down"]` both map to `↑/↓` and
			// `["enter","\r"]` both map to `Enter`, so the joined token must
			// collapse instead of printing `↑/↓/↑/↓`.
			//
			// `exactKeys` is for the case-SENSITIVE keyspaces (plan approval
			// binds `A` = approve vs `n` = deny — see keybinding-map.ts:75, and
			// the keyspace deliberately relies on that case distinction).
			// Uppercasing there would advertise a key that does not work.
			const tokens = [...new Set(options.exactKeys ? list : list.map(keyToken))];
			return `${tokens.join("/")} ${label}`;
		})
		.join(" · ");
}
