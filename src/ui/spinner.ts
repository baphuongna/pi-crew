export const SUBAGENT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SUBAGENT_SPINNER_FRAME_MS = 160;

// Clock source indirection (2026-09-22): spinner phase is derived from wall
// time at ~30 call sites that don't thread an injectable `now` through their
// render signatures. Deterministic consumers (docs/ui-samples/capture.ts,
// tests) swap the source once at startup instead of refactoring every
// signature; production keeps the real clock. Same pattern as the `__test__`
// hooks in state-store.
let spinnerClockSource: () => number = Date.now;

/** @internal — swap the spinner clock source. Returns the previous source
 * (pass it back to restore). Production default is Date.now. */
export function __setSpinnerClockSource(source: () => number): () => number {
	const previous = spinnerClockSource;
	spinnerClockSource = source;
	return previous;
}

/** The spinner clock as a shared read: elapsed-time fallbacks that have no
 * injected `now` (tool-progress, record durations) read it here so deterministic
 * captures pin BOTH spinner phase and elapsed text with one hook. Production
 * default stays Date.now(). */
export function spinnerClockNow(): number {
	return spinnerClockSource();
}

export function spinnerBucket(now = spinnerClockSource(), frameMs = SUBAGENT_SPINNER_FRAME_MS): number {
	return Math.floor(now / Math.max(1, frameMs));
}

function hashKey(key: string): number {
	let hash = 0;
	for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
	return hash;
}

export function spinnerFrame(key = "", now = spinnerClockSource()): string {
	const offset = key ? hashKey(key) % SUBAGENT_SPINNER_FRAMES.length : 0;
	return SUBAGENT_SPINNER_FRAMES[(spinnerBucket(now) + offset) % SUBAGENT_SPINNER_FRAMES.length] ?? SUBAGENT_SPINNER_FRAMES[0];
}
