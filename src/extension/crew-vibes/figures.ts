import type { SpeedConfig } from "./config.ts";

/**
 * Crew figures replacing the original cat glyphs from pi-speeed / pi-chonk.
 * Uses plain ASCII/emoji so no bundled font is required.
 */

// Speed indicator: 16 runner poses stored as PUA glyphs in the bundled
// crew-vibes.ttf (U+E700..U+E70F). Each frame is one glyph + a trailing
// space (mirrors pi-speeed's RunCat layout) so the working indicator keeps
// a constant 2-cell width across frames. Faster tok/s cycles frames faster
// (see intervalForSpeed). Install the font via `npm run install:crew-font`
// or the postinstall hook; without it the glyphs render as tofu boxes.
export const RUN_CREW_FRAMES: readonly string[] = [
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
