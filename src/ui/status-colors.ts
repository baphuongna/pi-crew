import type { CrewTheme, CrewThemeColor } from "./theme-adapter.ts";

export type RunStatus =
	| "queued"
	| "running"
	| "waiting"
	| "completed"
	| "failed"
	| "cancelled"
	| "stopped"
	| "blocked"
	| "stale"
	| "needs_attention"
	| (string & {});

export function colorForStatus(status: RunStatus): CrewThemeColor {
	switch (status) {
		case "running":
			return "accent";
		case "waiting":
			return "muted";
		case "completed":
			return "success";
		case "failed":
		case "stale":
			return "error";
		case "cancelled":
		case "blocked":
		case "stopped":
			return "warning";
		case "needs_attention":
			return "warning";
		case "queued":
		default:
			return "dim";
	}
}

export function iconForStatus(status: RunStatus, options?: { runningGlyph?: string }): string {
	const glyph = options?.runningGlyph ?? "▶";
	switch (status) {
		case "completed":
			return "✓";
		case "failed":
		case "stale":
			return "✗";
		case "cancelled":
		case "stopped":
			return "■";
		case "running":
			return glyph;
		case "waiting":
			return "⏳";
		case "queued":
			return "◦";
		case "blocked":
			return "⏸";
		case "needs_attention":
			return "⚠";
		default:
			return "·";
	}
}

/** @internal */
function colorForActivity(activityState: string | undefined): CrewThemeColor {
	if (activityState === "needs_attention") return "warning";
	if (activityState === "stale") return "error";
	return "dim";
}

export function applyStatusColor(theme: CrewTheme, status: RunStatus, text: string): string {
	return theme.fg(colorForStatus(status), text);
}

/**
 * Shared glyph→color map for status glyphs embedded in rendered lines.
 * Consolidates the duplicated `statusGlyphColor` (widget-renderer.ts) and
 * `iconColor` (live-run-sidebar.ts) maps into a single source of truth.
 *
 * Covers ALL status glyphs, including the two previously-missing ones:
 *   ⏳ (waiting) → muted, ⚠ (needs_attention) → warning
 * and the braille spinner range U+2800–U+28FF (⠁–⣿) → accent (V-3).
 */
function glyphColor(glyph: string): CrewThemeColor {
	// Braille Patterns block (U+2800–U+28FF) — running animation frames.
	const code = glyph.codePointAt(0) ?? 0;
	if (code >= 0x2800 && code <= 0x28ff) return "accent";
	switch (glyph) {
		case "✓":
			return "success";
		case "✗":
			return "error";
		case "■":
		case "⏸":
		case "⚠":
			return "warning";
		case "⏳":
			return "muted";
		case "◦":
		case "·":
			return "dim";
		case "▶":
		default:
			return "accent";
	}
}

/**
 * Status glyph characters used in the fast-path check.
 */
const STATUS_GLYPH_CHARS = "\u2713\u2717\u25a0\u23f8\u25e6\u00b7\u25b6\u23f3\u26a0";

/**
 * Colorize status glyphs embedded in a rendered line. Wraps every status glyph
 * (✓ ✗ ■ ⏸ ⏳ ⚠ ◦ · ▶ and braille spinner frames ⠁–⣿) in the appropriate theme
 * color, leaving surrounding text untouched.
 *
 * Replaces the duplicated per-module glyph colorizers in widget-renderer.ts
 * and live-run-sidebar.ts with a single shared helper (F-1, F-2, V-3).
 */
export function colorizeStatusGlyphs(line: string, theme: CrewTheme): string {
	// Fast path: skip regex if line contains no status glyphs at all.
	let hasGlyph = false;
	for (let i = 0; i < STATUS_GLYPH_CHARS.length; i++) {
		if (line.indexOf(STATUS_GLYPH_CHARS[i]) !== -1) {
			hasGlyph = true;
			break;
		}
	}
	if (!hasGlyph) {
		// Check for braille range (U+2800–U+28FF)
		for (let i = 0; i < line.length; i++) {
			const cp = line.codePointAt(i)!;
			if (cp >= 0x2800 && cp <= 0x28ff) {
				hasGlyph = true;
				break;
			}
		}
	}
	if (!hasGlyph) return line;
	return line.replace(/[✓✗■⏸◦·▶⏳⚠]|[\u2800-\u28FF]/g, (glyph) => theme.fg(glyphColor(glyph), glyph));
}
