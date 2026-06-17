/**
 * Powerline-style segment rendering.
 *
 * Ported from pi-bar's `renderSegment` technique (see
 * `research-findings/pi-ecosystem-distillation.md` T3): the cleanest filled-bg
 * color-handoff pattern. A powerline segment is a run of background color with
 * foreground text, where adjacent segments visually chain via a separator glyph
 * whose FG is the NEXT segment's BG (creating the smooth arrow/slash transition).
 *
 * The canonical 10-step sequence for ONE segment (bg=A.bg, fg=A.fg):
 *
 *     fg(A.bg) + leading-sep + RESET + bg(A.bg) + fg(A.fg) + text + RESET
 *           + fg(A.bg) + trailing-sep + RESET
 *
 * The leading separator's foreground is THIS segment's bg; the trailing
 * separator's foreground is the NEXT segment's bg. With RESET between every
 * phase, no SGR state leaks across segments — critical because mixed bold/fg/bg
 * across adjacent runs is the #1 source of color bleed in terminal output.
 *
 * `bg?` is OPTIONAL on CrewTheme (some themes can't fill backgrounds), so when
 * `bg` is unavailable we gracefully degrade to a fg-only segment with a plain
 * separator (no powerline arrow), so the widget stays readable everywhere.
 */

import type { CrewTheme } from "./theme-adapter.ts";

export interface PowerlineSegment {
	/** Color slot for the segment fill + leading separator fg. Accepts any
	 * theme color/bg slot name (e.g. "success", "selectedBg"). Typed loosely
	 * because a segment may use EITHER a CrewThemeColor or CrewThemeBg slot. */
	bg: string;
	/** Foreground color slot for the text. Accepts any CrewThemeColor. */
	fg: string;
	/** Text to render inside the segment. */
	text: string;
}

/** Separator glyphs. Override per-call if a font lacks the powerline glyphs. */
export interface PowerlineSeparators {
	/** Glyph drawn BEFORE the segment, fg = this segment's bg (links from prev). */
	leading: string;
	/** Glyph drawn AFTER the segment, fg = next segment's bg (links to next). */
	trailing: string;
}

/** Sensible defaults: a slim right-pointing slash. */
export const DEFAULT_POWERLINE_SEPARATORS: PowerlineSeparators = {
	leading: "\ue0b6", // 
	trailing: "\ue0b0", //  (right-pointing triangle — the classic powerline arrow)
};

const RESET = "\x1b[0m";

/**
 * Render a single powerline segment against the previous + next segments' bg
 * colors. Returns the FULL ANSI string including all RESETs (no SGR leaks).
 *
 * If `theme.bg` is unavailable, degrades to a fg-only segment with a plain
 * separator — readable but not powerline-styled.
 *
 * NOTE (pi-bar variant, verified ansi.ts:31-46): the trailing separator's fg
 * is THIS segment's own bg, NOT the next segment's bg. Both the leading and
 * trailing transitions are RESET-terminated, so the next segment's leading
 * sep (painted in ITS own bg) overlays cleanly on top. This is simpler and
 * more robust than the next-bg handoff variant.
 */
export function renderSegment(
	theme: CrewTheme,
	segment: PowerlineSegment,
	options: {
		/** Previous segment's bg color slot (reserved for future handoff styles). */
		prevBg?: string;
		/** Next segment's bg color slot (reserved for future handoff styles). */
		nextBg?: string;
		separators?: PowerlineSeparators;
	},
): string {
	const sep = options.separators ?? DEFAULT_POWERLINE_SEPARATORS;
	// Graceful degradation: no theme.bg → fg-only segment, plain separator.
	if (typeof theme.bg !== "function") {
		const fgText = theme.fg(segment.fg as never, segment.text);
		return `${sep.leading}${fgText}${sep.trailing}`;
	}
	// Full powerline fill (pi-bar 10-step): leading sep fg=this.bg, trailing
	// sep fg=this.bg (NOT next), all RESET-terminated so transitions overlay.
	//   leading-sep(fg = this.bg) → bg-fill + fg-text → trailing-sep(fg = this.bg)
	//
	// Segment color slots are loose strings because a segment may use EITHER a
	// CrewThemeColor or CrewThemeBg slot; the Pi theme API resolves slot names at
	// runtime regardless of static type, so we cast at the call boundary.
	const fgAny = theme.fg as unknown as (color: string, text: string) => string;
	const bgAny = theme.bg as unknown as (color: string, text: string) => string;
	const leadingFg = fgAny(segment.bg, sep.leading);
	const filled = bgAny(segment.bg, fgAny(segment.fg, segment.text));
	const trailingFg = fgAny(segment.bg, sep.trailing);
	return `${RESET}${leadingFg}${RESET}${filled}${RESET}${trailingFg}${RESET}`;
}

/**
 * Render a chain of powerline segments in sequence. Each segment's leading
 * separator links from the previous segment's bg, and the trailing separator
 * links to the next segment's bg. Returns the joined string.
 *
 * This is the primary entry point for status bars / progress footers built from
 * N colored segments (e.g. " run-abc │ 3/5 tasks │ $0.04 │ claude-sonnet ").
 */
export function renderSegmentChain(
	theme: CrewTheme,
	segments: PowerlineSegment[],
	options?: { separators?: PowerlineSeparators },
): string {
	if (segments.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		const prevBg = i > 0 ? segments[i - 1].bg : undefined;
		const nextBg = i < segments.length - 1 ? segments[i + 1].bg : undefined;
		parts.push(renderSegment(theme, seg, { prevBg, nextBg, separators: options?.separators }));
	}
	return parts.join("");
}
