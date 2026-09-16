/**
 * M3-1 (UI-AUDIT P0-2/P1-1): wire the terminal-status controller (tab title +
 * Ghostty OSC 9;4 progress) to the runEventBus.
 *
 * History: `src/ui/terminal-status.ts` shipped in v0.8.3 (819d71ad) with unit
 * tests but NO construction site — `ctx.terminalStatus` was never assigned, so
 * the feature never ran. This module is the missing wire, installed once from
 * `register.ts` in place of the old no-op cleanup handler.
 *
 * Design:
 *   - Subscribe to `runEventBus.onAny` and debounce evaluation (250ms) so a
 *     burst of task events collapses into one state transition.
 *   - State is derived from `listLiveAgents()`: >0 live → active; 0 → idle.
 *     `ctx.terminalStatusActive` (already in RegistrationContext) is the single
 *     source of truth for the current phase, so `runtime-cleanup.ts` resetting
 *     it also resets this state machine on the next event.
 *   - On the idle transition, `onRunCompleted()` fires the green Ghostty flash
 *     and `onIdle()` runs COMPLETE_FLASH_MS later (title restore + re-assert
 *     loop), so the flash is visible before the bar clears.
 *   - The `TerminalStatusUi` adapter reads `ctx.currentCtx` dynamically (getter
 *     + call-time lookup), so a session swap never leaves the controller
 *     holding a stale session's `ui.setTitle` (the P1-10 class of bug).
 *   - Everything is best-effort and guarded by `hasUI`: headless / subagent
 *     contexts evaluate to a no-op and write nothing.
 *   - All timers are `unref()`-ed; dispose unsubscribes, clears timers and
 *     disposes the controller (registered via `registerCleanupHandler`, which
 *     replaces the old no-op `disposeTerminalStatus` handler in register.ts).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listLiveAgents } from "../../runtime/live-session/live-agent-manager.ts";
import { runEventBus } from "../../ui/run-event-bus.ts";
import {
	buildCrewTitleSegment,
	COMPLETE_FLASH_MS,
	createTerminalStatusController,
	setTerminalTitle,
	type TerminalStatusController,
	type TerminalStatusUi,
} from "../../ui/terminal-status.ts";
import { registerCleanupHandler } from "../crew-cleanup.ts";

/**
 * Structural subset of RegistrationContext this module needs. Declared
 * locally (not imported) so tests can pass a 3-field fake without building
 * the full context, while `register.ts` passes the real context unchanged.
 */
export interface TerminalStatusWiringDeps {
	currentCtx: { hasUI: boolean; ui: { setTitle(title: string): void } } | undefined;
	terminalStatus: TerminalStatusController | undefined;
	terminalStatusActive: boolean;
}

/** Debounce window that collapses an event burst into one evaluation. */
const EVAL_DEBOUNCE_MS = 250;

/**
 * Live-agent probe (dependency inversion for tests). Production reads the real
 * registry; tests inject a deterministic count source.
 */
let liveAgentProbe: () => number = () => listLiveAgents().length;

/** @internal Re-subscribe guard: unsubscribe fn from a previous registration. */
let currentUnsubscribe: (() => void) | undefined;
/** @internal Latest install's full dispose (unsubscribe + timers + controller). */
let currentDispose: (() => void) | undefined;

/** Test seam: override the live-agent source (restore with `() => default`). */
export function __test__setLiveAgentProbe(probe: () => number): void {
	liveAgentProbe = probe;
}

/** Test seam: fully dispose any wiring left by a previous install in this process. */
export function __test__resetTerminalStatusWiring(): void {
	currentDispose?.();
	currentDispose = undefined;
	currentUnsubscribe = undefined;
}

export function installTerminalStatus(pi: ExtensionAPI, deps: TerminalStatusWiringDeps): void {
	// A previous registration in this process must not leave a second
	// subscription behind (registerCleanupHandler only keeps the latest
	// dispose fn, so an older subscription would leak otherwise).
	currentUnsubscribe?.();

	// Dynamic adapter: resolves the CURRENT session's UI at call time, so the
	// controller never captures a session-scoped reference.
	const adapter: TerminalStatusUi = {
		get hasUI(): boolean {
			return deps.currentCtx?.hasUI ?? false;
		},
		ui: {
			setTitle(title: string): void {
				deps.currentCtx?.ui.setTitle(title);
			},
		},
	};

	let evalTimer: ReturnType<typeof setTimeout> | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let lastSegment = "";

	const clearTimers = (): void => {
		if (evalTimer) {
			clearTimeout(evalTimer);
			evalTimer = undefined;
		}
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};

	const evaluate = (): void => {
		evalTimer = undefined;
		if (!adapter.hasUI) return;
		if (!deps.terminalStatus) deps.terminalStatus = createTerminalStatusController(adapter);
		const controller = deps.terminalStatus;

		if (liveAgentProbe() > 0) {
			// Active: cancel any pending idle transition, then (re)assert.
			if (idleTimer) {
				clearTimeout(idleTimer);
				idleTimer = undefined;
			}
			if (!deps.terminalStatusActive) {
				deps.terminalStatusActive = true;
				controller.onRunsActive(); // title (best-effort) + Ghostty INDETERMINATE
				lastSegment = buildCrewTitleSegment();
				return;
			}
			// Still active: refresh the title only when the role summary changed
			// (never re-emit the OSC sequence — state 3 persists on its own).
			const segment = buildCrewTitleSegment();
			if (segment && segment !== lastSegment) {
				lastSegment = segment;
				setTerminalTitle(adapter, segment);
			}
			return;
		}

		if (deps.terminalStatusActive) {
			deps.terminalStatusActive = false;
			lastSegment = "";
			controller.onRunCompleted(); // green flash, self-re-evaluates after COMPLETE_FLASH_MS
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				controller.onIdle(); // title restore + idle re-assert loop + Ghostty CLEAR
			}, COMPLETE_FLASH_MS);
			idleTimer.unref?.();
		}
	};

	const unsubscribe = runEventBus.onAny(() => {
		if (evalTimer) return;
		evalTimer = setTimeout(evaluate, EVAL_DEBOUNCE_MS);
		evalTimer.unref?.();
	});
	currentUnsubscribe = unsubscribe;
	const dispose = (): void => {
		unsubscribe();
		currentUnsubscribe = undefined;
		currentDispose = undefined;
		clearTimers();
		deps.terminalStatus?.dispose();
		deps.terminalStatus = undefined;
		deps.terminalStatusActive = false;
	};
	currentDispose = dispose;

	registerCleanupHandler(pi, { disposeTerminalStatus: dispose });
}
