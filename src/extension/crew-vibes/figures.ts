/**
 * Capacity-stage helpers (shared by renderCapacity, which remains exported
 * for its unit tests after the footer retirement).
 *
 * The speed-UI parts of this module (braille/PUA spinner frames,
 * intervalForSpeed) were REMOVED with the tok/s speed UI (maintainer
 * decision 2026-09-14) — pi's built-in working indicator is always used.
 */

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
