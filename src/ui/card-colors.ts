/**
 * Color utilities for pi-crew UI — background tinting and ANSI parsing.
 *
 * Ported from pi-diff's mixBg() / autoDeriveBgFromTheme() technique:
 * derive subtle status-tinted backgrounds from the theme's foreground colors
 * so crew cards stay readable across light/dark themes without hardcoding RGB.
 *
 * mixBg(base, accent, intensity) does a LINEAR interpolation:
 *   result = base + (accent - base) * intensity
 *
 * Intensity tiers (per pi-diff research):
 *   10-12% — subtle gutter/hint
 *   15-18% — line background (visible but not loud)
 *   30-35% — word-level emphasis (prominent)
 */
import type { CrewTheme } from "./theme-adapter.ts";
import { visibleWidth as visualWidth } from "../utils/visual.ts";

// ── ANSI parsing ────────────────────────────────────────────────────────

interface Rgb { r: number; g: number; b: number; }

const ANSI_RGB_FG_RE = /^\x1b?\[?38;2;(\d+);(\d+);(\d+)m?$/;
const ANSI_RGB_BG_RE = /^\x1b?\[?48;2;(\d+);(\d+);(\d+)m?$/;

/** Parse a truecolor ANSI SGR sequence (e.g. "\x1b[38;2;255;100;50m") to RGB. */
export function parseAnsiRgb(ansi: string | undefined | null): Rgb | null {
	if (!ansi) return null;
	const stripped = ansi.replace(/^\x1b?\[?/, "").replace(/m?$/, "");
	const fgMatch = stripped.match(/^38;2;(\d+);(\d+);(\d+)$/);
	const bgMatch = stripped.match(/^48;2;(\d+);(\d+);(\d+)$/);
	const m = fgMatch ?? bgMatch;
	if (!m) return null;
	const r = Number(m[1]);
	const g = Number(m[2]);
	const b = Number(m[3]);
	if (![r, g, b].every(Number.isFinite)) return null;
	return { r, g, b };
}

// ── Color mixing ────────────────────────────────────────────────────────

/** Linear-interpolate two RGB colors and emit a 48;2 (truecolor bg) SGR code. */
export function mixBg(base: Rgb, accent: Rgb, intensity: number): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };

// ── Theme → background derivation ───────────────────────────────────────

/**
 * Resolve a subtle status-tinted background for a crew card interior.
 *
 * Reads the theme's fg color for the given status slot (success/error/border),
 * mixes it into a dark base at low intensity (default 8%), and returns a bg SGR
 * sequence. Returns "" if the theme exposes no fg ANSI (graceful — caller
 * renders without background).
 *
 * @param theme       pi-crew theme adapter
 * @param statusSlot  which status color to tint with ("success" | "error" | "borderAccent" | "border")
 * @param intensity   0-1, how strong the tint is (default 0.08 = very subtle)
 */
export function deriveCardBackground(
	theme: CrewTheme,
	statusSlot: "success" | "error" | "borderAccent" | "border",
	intensity = 0.08,
): string {
	// Prefer the theme's bg color as base (matches the card's surroundings).
	let base = BLACK;
	const themeAny = theme as unknown as {
		getBgAnsi?: (slot: string) => string | undefined;
		getFgAnsi?: (slot: string) => string | undefined;
	};
	if (themeAny.getBgAnsi) {
		try {
			const bg = themeAny.getBgAnsi("background");
			const parsed = parseAnsiRgb(bg);
			if (parsed) base = parsed;
		} catch { /* fall back to black */ }
	}

	// Get the accent from the theme's fg for the requested slot.
	let accentRgb: Rgb | null = null;
	if (themeAny.getFgAnsi) {
		try {
			accentRgb = parseAnsiRgb(themeAny.getFgAnsi(statusSlot));
		} catch { /* accent stays null */ }
	}
	if (!accentRgb) return ""; // can't derive — render without bg tint

	return mixBg(base, accentRgb, intensity);
}

// ── Helpers for padding lines with a background ─────────────────────────

const RESET = "\x1b[0m";

/** Strip ANSI SGR codes then compute the VISUAL width (Unicode-aware).
 * Round 23 (BUG 2): previously this used `.length` (UTF-16 code units), which
 * under-counts CJK/emoji → wrong padding → broken frame borders in crew cards.
 * Delegate to the canonical Unicode-aware visualWidth from utils/visual.ts
 * used by every other renderer. */
export function visibleWidth(text: string): number {
	return visualWidth(text);
}

/**
 * Pad a line to `targetWidth` and apply `bgAnsi` as the background for the
 * full visible width (including any trailing padding spaces).
 *
 * `bgAnsi` should be a 48;2 (truecolor bg) SGR sequence from mixBg().
 * The function inserts the bg code after any existing leading SGR, fills the
 * content, pads to width, then resets. This ensures the entire row's background
 * is tinted — not just the characters.
 */
export function padWithBackground(line: string, targetWidth: number, bgAnsi: string): string {
	if (!bgAnsi) {
		// No background — just space-pad (preserving any existing styling).
		const width = visibleWidth(line);
		return width >= targetWidth ? line : line + " ".repeat(targetWidth - width);
	}
	const width = visibleWidth(line);
	const pad = width >= targetWidth ? "" : " ".repeat(targetWidth - width);
	// Re-apply bg after a leading reset if present, otherwise prepend.
	return `${bgAnsi}${line}${pad}${RESET}`;
}
