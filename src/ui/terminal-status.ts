/**
 * Terminal tab title + Ghostty native progress bar.
 *
 * Distilled from pi-status (Thinkscape — `source/pi-status/src/index.ts`):
 * two UI channels pi-crew didn't use before, both surviving subprocess and
 * visible even when the TUI isn't in focus:
 *
 * 1. **Tab title** via `ctx.ui.setTitle()` — shows a one-line crew run summary
 *    (e.g. "π-crew · 2 active · explorer, executor"). Cheap, works in any
 *    terminal. pi-status restores the title on idle with an exponential
 *    back-off re-assert loop (pi itself re-sets the title on some events).
 * 2. **Ghostty OSC 9;4** native progress bar — written to `/dev/tty` (a
 *    separate channel from pi's TUI, so it works even when pi runs in a
 *    subprocess). state 3 = indeterminate pulsing while runs are active;
 *    state 1 value 100 = green completion flash; state 0 = clear. Compatible
 *    with all libghostty-based terminals (Ghostty, cmux, muxy).
 *
 * All writes are BEST-EFFORT: `/dev/tty` may be absent (non-interactive /
 * subagent / CI context) and `setTitle` may be unavailable — failures are
 * swallowed and never surface to the user. This module is purely additive:
 * it cannot regress existing behavior because nothing depends on it.
 *
 * Lifecycle (wired from register.ts via runEventBus + turn events):
 *   - run active (running/queued/planning) → title "π-crew · N active · <roles>",
 *     Ghostty state 3 (indeterminate).
 *   - run just completed → Ghostty state 1/100 (green flash), schedule clear.
 *   - idle (no active runs) → restore pi's natural title, Ghostty state 0.
 *
 * @module terminal-status
 */

import { writeFileSync } from "node:fs";
import { listLiveAgents } from "../runtime/live-session/live-agent-manager.ts";

/**
 * Minimal UI surface this module needs. Deliberately narrower than
 * `ExtensionContext["ui"]` so it's trivial to mock in tests (dependency
 * inversion: depend only on what you use).
 */
export interface TerminalStatusUi {
	hasUI: boolean;
	ui: { setTitle(title: string): void };
}

/** Ghostty OSC 9;4 progress states. */
export const GHOSTTY_PROGRESS = {
	CLEAR: 0, // remove the progress indicator
	SET: 1, // set explicit progress (0-100)
	ERROR: 2, // error state
	INDETERMINATE: 3, // pulsing/working animation
} as const;

/** Title prefix so the source is identifiable in the tab. */
const TITLE_PREFIX = "π-crew";
/** Separator between summary segments. */
const SEP = " · ";
/** Max roles listed in the title (keep it short for narrow tabs). */
const MAX_TITLE_ROLES = 3;

/** Idle-reassert backoff bounds (mirrors pi-status, clamped). */
const IDLE_REASSERT_START_MS = 200;
const IDLE_REASSERT_MAX_MS = 5000;
/** How long the green completion flash stays before clearing. */
const COMPLETE_FLASH_MS = 1500;

/** Injected for tests (defaults write to the real /dev/tty). */
export type GhosttyWriter = (seq: string) => void;

let ghosttyWriter: GhosttyWriter | undefined;

/**
 * Set the raw-sequence writer (test seam). Pass `undefined` to restore the
 * default `/dev/tty` writer. Tests inject a buffer-capturing fn.
 */
export function setGhosttyWriterForTest(writer: GhosttyWriter | undefined): void {
	ghosttyWriter = writer;
}

function defaultGhosttyWriter(seq: string): void {
	try {
		writeFileSync("/dev/tty", seq);
	} catch {
		// /dev/tty unavailable (non-interactive, subagent, CI, or Windows) — no-op.
		// This is expected in most automated contexts; never surface it.
	}
}

function writeGhostty(seq: string): void {
	(ghosttyWriter ?? defaultGhosttyWriter)(seq);
}

/**
 * Emit a Ghostty OSC 9;4 progress sequence.
 * Format: `\x1b]9;4;<state>[;<value>]\x07`
 */
export function setGhosttyProgress(state: number, value?: number): void {
	const args = value !== undefined ? `${state};${value}` : `${state}`;
	writeGhostty(`\x1b]9;4;${args}\x07`);
}

/** Indeterminate pulsing — use while crew runs are active. */
export function ghosttyWorking(): void {
	setGhosttyProgress(GHOSTTY_PROGRESS.INDETERMINATE);
}

/** Green completion flash at 100% — use when a run finishes successfully. */
export function ghosttyComplete(): void {
	setGhosttyProgress(GHOSTTY_PROGRESS.SET, 100);
}

/** Clear the progress indicator. */
export function ghosttyClear(): void {
	setGhosttyProgress(GHOSTTY_PROGRESS.CLEAR);
}

/**
 * Build the crew run-summary title segment from live agents.
 * Returns "" when no agents are live (so the title can be restored).
 */
export function buildCrewTitleSegment(cwd?: string): string {
	const live = listLiveAgents();
	if (live.length === 0) return "";
	// Distinct roles across active agents, in stable order.
	const roles: string[] = [];
	const seen = new Set<string>();
	for (const handle of live) {
		const role = handle.role || handle.agent || "agent";
		if (!seen.has(role)) {
			seen.add(role);
			roles.push(role);
		}
	}
	const shown = roles.slice(0, MAX_TITLE_ROLES);
	const more = roles.length > shown.length ? ` +${roles.length - shown.length}` : "";
	return `${TITLE_PREFIX}${SEP}${live.length} active${SEP}${shown.join(", ")}${more}`;
}

/** Idle title — what we restore when no runs are active. */
export function buildIdleTitle(): string {
	return TITLE_PREFIX;
}

/**
 * Set the terminal tab title if the UI supports it. Best-effort.
 */
export function setTerminalTitle(ctx: TerminalStatusUi, title: string): void {
	if (!ctx.hasUI) return;
	try {
		ctx.ui.setTitle(title);
	} catch {
		// setTitle unavailable or failed — swallow (purely cosmetic).
	}
}

interface TerminalStatusState {
	/** Idle re-assert timer (mirrors pi-status backoff). */
	idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** Whether we currently show an "active" title (so we know to restore). */
	showingActive: boolean;
	/** Completion-flash clear timer. */
	flashTimer: ReturnType<typeof setTimeout> | undefined;
	/** True after dispose() — stop all timers/writes. */
	destroyed: boolean;
}

/**
 * Terminal status controller. Owns the title + Ghostty progress lifecycle.
 *
 * The controller is a small stateful object (no class hierarchy) so it can be
 * constructed per-session in register.ts and disposed cleanly. It exposes
 * `onRunsActive()`, `onRunCompleted()`, `onIdle()` entry points that the
 * runEventBus + turn handlers call.
 */
export interface TerminalStatusController {
	onRunsActive(): void;
	onRunCompleted(): void;
	onIdle(): void;
	dispose(): void;
}

export function createTerminalStatusController(ctx: TerminalStatusUi): TerminalStatusController {
	const state: TerminalStatusState = {
		idleTimer: undefined,
		showingActive: false,
		flashTimer: undefined,
		destroyed: false,
	};

	const clearIdleTimer = (): void => {
		if (state.idleTimer) {
			clearTimeout(state.idleTimer);
			state.idleTimer = undefined;
		}
	};
	const clearFlashTimer = (): void => {
		if (state.flashTimer) {
			clearTimeout(state.flashTimer);
			state.flashTimer = undefined;
		}
	};

	/**
	 * Idle re-assert loop: pi itself re-sets the title on some events
	 * (session_info_changed, model_select, rebinds), so a single setTitle
	 * is not durable. Re-assert on an exponential backoff until the next
	 * activity. (Pattern from pi-status scheduleIdleReassert.)
	 */
	const scheduleIdleReassert = (delay: number): void => {
		if (state.destroyed || state.showingActive) return;
		clearIdleTimer();
		state.idleTimer = setTimeout(() => {
			if (state.destroyed || state.showingActive) return;
			setTerminalTitle(ctx, buildIdleTitle());
			scheduleIdleReassert(Math.min(delay * 2, IDLE_REASSERT_MAX_MS));
		}, delay);
		// Unref so this recursive backoff timer never keeps the event loop alive
		// (critical on SIGTERM where dispose() is not reached → process hang).
		state.idleTimer.unref?.();
	};

	return {
		onRunsActive(): void {
			if (state.destroyed) return;
			clearIdleTimer();
			clearFlashTimer();
			state.showingActive = true;
			const segment = buildCrewTitleSegment();
			if (segment) setTerminalTitle(ctx, segment);
			ghosttyWorking();
		},
		onRunCompleted(): void {
			if (state.destroyed) return;
			clearFlashTimer();
			ghosttyComplete();
			// Clear the green flash after a short beat, then re-evaluate.
			state.flashTimer = setTimeout(() => {
				if (state.destroyed) return;
				state.flashTimer = undefined;
				// If still active, resume indeterminate; else go idle.
				if (listLiveAgents().length > 0) {
					ghosttyWorking();
				} else {
					ghosttyClear();
				}
			}, COMPLETE_FLASH_MS);
			// Unref so the one-shot flash clear never blocks process exit.
			state.flashTimer.unref?.();
		},
		onIdle(): void {
			if (state.destroyed) return;
			state.showingActive = false;
			clearFlashTimer();
			ghosttyClear();
			setTerminalTitle(ctx, buildIdleTitle());
			scheduleIdleReassert(IDLE_REASSERT_START_MS);
		},
		dispose(): void {
			state.destroyed = true;
			clearIdleTimer();
			clearFlashTimer();
			// Best-effort: clear the Ghostty progress so we don't leave a stale bar.
			try {
				ghosttyClear();
			} catch {
				// swallow
			}
		},
	};
}
