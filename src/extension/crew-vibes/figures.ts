import type { SpeedConfig } from "./config.ts";

/**
 * Crew figures replacing the original cat glyphs from pi-speeed / pi-chonk.
 *
 * The working indicator uses braille spinner characters by default — the
 * same characters pi uses for its built-in loading animation (loaders.ts
 * DEFAULT_FRAMES).  These render on ANY terminal with basic Unicode support,
 * no custom font required.
 *
 * PUA glyphs (U+E700..U+E70F) from the bundled crew-vibes.ttf font are
 * available as an opt-in alternative (set speed.indicatorStyle = "pua" in
 * config).  Requires the font to be installed via `npm run install:crew-font`
 * AND a terminal that renders Private Use Area codepoints.
 */

// ── Braille spinner frames (default) ──────────────────────────────────
// Same 10-frame cycle as pi's built-in DEFAULT_FRAMES in loaders.ts.
// Each frame is a braille pattern (U+2800..U+28FF) + trailing space for
// constant 2-cell width across frames.
const BRAILLE_FRAMES: readonly string[] = [
	"\u280B ", // ⠋ dots 1,4,5
	"\u2819 ", // ⠙ dots 1,4
	"\u2839 ", // ⠹ dots 1,4,5,6
	"\u2838 ", // ⠸ dots 4,5,6
	"\u283C ", // ⠼ dots 3,4,5,6
	"\u2834 ", // ⠴ dots 3,5,6
	"\u2826 ", // ⠦ dots 2,3,5,6
	"\u2827 ", // ⠧ dots 1,2,3,5,6
	"\u2807 ", // ⠇ dots 1,2,3
	"\u280F ", // ⠏ dots 1,2,3,4
] as const;

// ── PUA runner frames (opt-in) ────────────────────────────────────────
// 16 runner poses from the bundled crew-vibes.ttf font.  Only usable when
// the font is installed AND the terminal renders PUA codepoints correctly.
// Each frame is one glyph + trailing space for constant 2-cell width.
const PUA_CREW_FRAMES: readonly string[] = [
	"\uE700 ",
	"\uE701 ",
	"\uE702 ",
	"\uE703 ",
	"\uE704 ",
	"\uE705 ",
	"\uE706 ",
	"\uE707 ",
	"\uE708 ",
	"\uE709 ",
	"\uE70A ",
	"\uE70B ",
	"\uE70C ",
	"\uE70D ",
	"\uE70E ",
	"\uE70F ",
] as const;

/**
 * Return the indicator frames for the given style.
 *
 * - `"braille"` (default): standard Unicode braille spinner, works everywhere
 * - `"pua"`: runner-pose glyphs from crew-vibes.ttf, requires font install
 */
export function crewFrames(style: "braille" | "pua" = "pua"): readonly string[] {
	return style === "pua" ? PUA_CREW_FRAMES : BRAILLE_FRAMES;
}

// Re-export PUA frames for backward compatibility and direct consumers.
export const RUN_CREW_FRAMES = PUA_CREW_FRAMES;

/**
 * Map a tok/s reading to a working-indicator frame interval in ms.
 * Ported from pi-speeed's runcatInterval: interval = scale / speed, clamped
 * to [min, max]. A null/zero speed falls back to the default (idle) cadence.
 */
export function intervalForSpeed(config: SpeedConfig, speed: number | null): number {
	if (speed === null || !Number.isFinite(speed) || speed <= 0) return config.defaultIntervalMs;
	return Math.max(config.minIntervalMs, Math.min(config.maxIntervalMs, Math.round(config.scale / speed)));
}

/**
 * Pick the capacity stage index (0..levels-1) for a context-fill percent.
 * Ported from pi-chonk's chonkIndex.
 */
export function capacityIndex(percent: number | null | undefined, levels = 6): number {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return 0;
	return Math.max(0, Math.min(levels - 1, Math.floor((Math.max(0, Math.min(100, percent)) / 100) * levels)));
}

/** The last two stages are "danger" stages and get the error color. */
export function isDangerStage(index: number, levels: number): boolean {
	return index >= Math.max(0, levels - 2);
}
