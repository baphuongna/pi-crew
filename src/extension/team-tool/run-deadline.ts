import type { PiTeamsConfig } from "../../config/config.ts";
import { loadConfig } from "../../config/config.ts";
import { isSessionSwitchInFlight } from "../../ui/inline-panel/view-session-store.ts";
import { safeAbort } from "../../utils/safe-abort.ts";
import type { TeamContext } from "./context.ts";

/**
 * Resolved run deadline — a shared AbortController, its signal, and the
 * computed deadline in milliseconds.
 */
export interface RunDeadline {
	/** AbortSignal to pass to run executors (executeTeamRun, runDynamicWorkflow). */
	signal: AbortSignal;
	/** Computed deadline in milliseconds (used for `waitForRun` timeoutMs). */
	deadlineMs: number;
	/** Underlying controller — callers may link additional parent signals. */
	controller: AbortController;
	/** RC-02: the deadline timer handle — callers clear it on normal completion. */
	timer: NodeJS.Timeout | undefined;
}

/** Fallback deadline when no config or param override is available: 1 hour. */
export const DEFAULT_RUN_DEADLINE_MS = 3_600_000;

/**
 * Resolve a unified run deadline with a shared AbortController.
 *
 * CORE-8 fix: previously three code paths in run.ts used inconsistent timeout
 * policies — the DWF path used `AbortSignal.timeout(3_600_000)`, the foreground
 * async path used `waitForRun(timeoutMs: 3_600_000)`, and the inline scaffold
 * path passed `ctx.signal` with **zero** deadline fallback (could hang
 * indefinitely if the caller signal never fires).
 *
 * This helper unifies all three into a single resolution strategy:
 *
 * Priority: `params.timeoutMs` → `config.limits.maxRunMinutes * 60_000` →
 * `DEFAULT_RUN_DEADLINE_MS` (1 hour).
 *
 * The returned AbortController is linked to `ctx.signal` (caller abort
 * propagates immediately) and armed with a deadline timer (`setTimeout` +
 * `unref` so it never keeps the event loop alive). Callers may link additional
 * parent signals to `controller` — e.g. a `startForegroundRun` callback signal.
 *
 * The `params` generic accepts the full `TeamToolParamsValue` (or any object
 * with an optional `timeoutMs`); the value is read defensively via cast so the
 * weak-type TS2559 check does not fire.
 */
export function resolveRunDeadline<T extends object>(
	ctx: Pick<TeamContext, "cwd" | "signal">,
	params: T,
	config?: PiTeamsConfig,
): RunDeadline {
	const timeoutMs = (params as { timeoutMs?: number }).timeoutMs;
	const effectiveConfig = config ?? loadConfig(ctx.cwd).config;
	const maxRunMinutes = effectiveConfig?.limits?.maxRunMinutes;
	const deadlineMs = timeoutMs ?? (maxRunMinutes ? maxRunMinutes * 60_000 : DEFAULT_RUN_DEADLINE_MS);

	const controller = new AbortController();
	// Propagate caller abort (ctx.signal) to the shared controller.
	// R6-F2 (W2/RC-03 consistency): named handler instead of an anonymous
	// { once: true } closure. resolveRunDeadline returns immediately (there is
	// no run-lifetime finally scope inside this module — callers in run.ts only
	// clearTimeout the timer), so removal is wired to the deadline controller's
	// own abort: once the run controller aborts for ANY cause (deadline timer
	// fire, caller-signal propagation, or an explicit controller.abort() from a
	// linked path such as startForegroundRun), the propagation listener is dead
	// weight on ctx.signal and is removed. Behavior-neutral: if the caller's
	// signal fired afterwards, the listener would only call abort() on an
	// already-aborted controller — a no-op.
	if (ctx.signal) {
		if (ctx.signal.aborted) safeAbort(controller, "run-deadline.caller-preaborted");
		else {
			const callerSignal = ctx.signal;
			// The deadline signal is passed down to run executors that may spawn
			// children with it; aborting after a child exited throws AbortError
			// from Node's child_process listener — never let that escape a
			// pi event handler (safe-abort).
			const onCallerAbort = () => {
				// Regression: switching sessions (resume/new/fork — including
				// /crew-view) tears the current turn down via session.abort(),
				// firing the tool-call abort while the run is still forming. A
				// foreground run must survive session switches (P0 — it shares
				// the process), so a teardown abort must NOT cancel it. Only a
				// genuine caller abort OUTSIDE a session switch propagates.
				if (isSessionSwitchInFlight()) return;
				safeAbort(controller, "run-deadline.caller-abort");
			};
			callerSignal.addEventListener("abort", onCallerAbort, { once: true });
			controller.signal.addEventListener("abort", () => callerSignal.removeEventListener("abort", onCallerAbort), { once: true });
		}
	}
	// Arm the deadline timer (unref'd so it never blocks process exit).
	// RC-02: expose the timer so callers can clearTimeout on normal completion —
	// otherwise every run leaves a dangling 1h timer retaining ctx/params in closure.
	// Same abort-after-exit guard as above: the timer may fire after workers
	// already exited and their spawn-signal listeners are gone — Node can throw.
	let timer: NodeJS.Timeout | undefined;
	if (deadlineMs > 0) {
		timer = setTimeout(() => safeAbort(controller, "run-deadline.timer"), deadlineMs);
		timer.unref?.();
	}
	return { signal: controller.signal, deadlineMs, controller, timer };
}
