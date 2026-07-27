import { logInternalError } from "../utils/internal-error.ts";
import { RenderScheduler } from "./render-scheduler.ts";
import { runEventBusAsRenderScheduler } from "./run-event-bus.ts";

export interface OverlaySchedulerHandle {
	/** Force a debounced re-render fan-out (e.g. theme change, dashboard interaction). */
	schedule(): void;
	/** Unregister this overlay. Disposes the shared scheduler when the last overlay leaves (ref-count). */
	dispose(): void;
}

/**
 * C3 (Option G): the 3 overlays (widget + sidebar + dashboard) each used to
 * instantiate an identical RenderScheduler (same run-event-bus channels,
 * debounce 75ms, fallback 750ms) → 9 subscriptions + 9 live timers + 3×
 * per-event schedule() CPU during active runs. This module owns ONE shared
 * RenderScheduler (module singleton) whose `render` and `onInvalidate`
 * fan out to all registered overlays, with per-callback try/catch isolation
 * + ref-counted disposal (the underlying scheduler is disposed when the last
 * overlay leaves, and a future register recreates it).
 */

const CHANNELS = ["run:state", "worker:lifecycle", "ui:invalidate"] as const;

interface SharedOverlayState {
	readonly scheduler: RenderScheduler;
	readonly renderers: Set<() => void>;
	readonly invalidators: Set<(payload: unknown) => void>;
}

let shared: SharedOverlayState | undefined;

function ensureShared(): SharedOverlayState {
	if (shared) return shared;
	const renderers = new Set<() => void>();
	const invalidators = new Set<(payload: unknown) => void>();
	const scheduler = new RenderScheduler(
		runEventBusAsRenderScheduler([...CHANNELS]),
		() => {
			// Fan-out: each registered overlay's render runs in its own
			// try/catch so one failing component cannot break the others.
			for (const render of renderers) {
				try {
					render();
				} catch (error) {
					logInternalError("shared-overlay-scheduler.render", error);
				}
			}
		},
		{
			debounceMs: 75,
			fallbackMs: 750,
			events: [...CHANNELS],
			onInvalidate: (payload) => {
				for (const invalidate of invalidators) {
					try {
						invalidate(payload);
					} catch (error) {
						logInternalError("shared-overlay-scheduler.invalidate", error);
					}
				}
			},
		},
	);
	shared = { scheduler, renderers, invalidators };
	return shared;
}

/**
 * Register an overlay's render (+ optional onInvalidate) with the shared
 * scheduler. Returns a handle that lets the overlay force a debounced
 * fan-out (schedule) and unregister itself (dispose). The underlying shared
 * scheduler is created lazily on first register and disposed when the last
 * overlay disposes.
 */
export function registerOverlayScheduler(render: () => void, onInvalidate?: (payload: unknown) => void): OverlaySchedulerHandle {
	const state = ensureShared();
	state.renderers.add(render);
	if (onInvalidate) state.invalidators.add(onInvalidate);
	return {
		schedule: () => {
			state.scheduler.schedule();
		},
		dispose: () => {
			state.renderers.delete(render);
			if (onInvalidate) state.invalidators.delete(onInvalidate);
			// Ref-count: when the last overlay leaves, dispose the underlying
			// scheduler (clears subscriptions + timers) and reset the module
			// variable so a future register recreates a fresh instance.
			if (state.renderers.size === 0) {
				state.scheduler.dispose();
				if (shared === state) shared = undefined;
			}
		},
	};
}
