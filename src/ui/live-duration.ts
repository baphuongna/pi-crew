/**
 * Round 23 (BUG 1 fix): live-agent duration computation.
 *
 * The naive `(completedAtMs ?? Date.now()) - startedAtMs` produced giant
 * NEGATIVE durations for every running live agent whenever startedAtMs was
 * 0/undefined/out-of-range, or a race set completedAtMs < startedAtMs.
 *
 * This module consolidates the validated duration math (previously duplicated
 * between widget-formatters.ts and agents-pane.ts) into one pure, fully
 * testable function: it normalizes seconds-vs-ms, sanity-checks the start
 * timestamp against the current time, and never returns a negative value.
 */

export interface LiveActivity {
	startedAtMs?: number;
	completedAtMs?: number;
}

/** Normalize a raw timestamp that may be seconds or milliseconds. */
function toMs(v: number): number {
	if (v <= 0) return 0;
	// 1e9 < seconds < 1e10  → seconds, scale up
	if (v > 1_000_000_000 && v < 10_000_000_000) return v * 1000;
	// 1e10 < ms < 1e13      → already ms (>=10B seconds is 317+ years, implausible)
	if (v > 10_000_000_000 && v < 10_000_000_000_000) return v;
	return v;
}

/**
 * Compute the live elapsed duration in milliseconds for an agent activity.
 *
 * - Never negative (clamped to >= 0).
 * - Returns 0 if the start timestamp is missing or implausible.
 * - Uses `completedAtMs` when present and sane; otherwise `nowMs` (running).
 *
 * @param activity the live agent activity handle
 * @param nowMs    optional override for `Date.now()` (tests / determinism)
 */
export function computeLiveDurationMs(activity: LiveActivity, nowMs: number = Date.now()): number {
	const rawStarted = activity.startedAtMs || 0;
	const rawCompleted = activity.completedAtMs || 0;
	const startedMs = toMs(rawStarted);
	const completedMs = rawCompleted > 0 ? toMs(rawCompleted) : 0;
	// A valid start is positive, not more than 1 minute in the future, and not
	// more than ~1000 years in the past (guards against 0 / garbage / clock skew).
	const isValidStarted = startedMs > 0 && startedMs < nowMs + 60_000 && startedMs > nowMs - 31_556_926_000_000;
	const end = completedMs > 0 && completedMs < nowMs + 60_000 ? completedMs : nowMs;
	const ms = end - (isValidStarted ? startedMs : nowMs);
	return Number.isFinite(ms) && ms >= 0 ? ms : 0;
}

/** Format a live duration in seconds, e.g. `12.3s`. Returns `0.0s` for 0. */
export function formatLiveDuration(activity: LiveActivity, nowMs: number = Date.now()): string {
	return `${(computeLiveDurationMs(activity, nowMs) / 1000).toFixed(1)}s`;
}
