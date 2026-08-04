import type { PiTeamsConfig } from "../../config/config.ts";
import { loadConfig } from "../../config/config.ts";
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
	if (ctx.signal) {
		if (ctx.signal.aborted) controller.abort();
		else ctx.signal.addEventListener("abort", () => controller.abort(), { once: true });
	}
	// Arm the deadline timer (unref'd so it never blocks process exit).
	// RC-02: expose the timer so callers can clearTimeout on normal completion —
	// otherwise every run leaves a dangling 1h timer retaining ctx/params in closure.
	let timer: NodeJS.Timeout | undefined;
	if (deadlineMs > 0) {
		timer = setTimeout(() => controller.abort(), deadlineMs);
		timer.unref?.();
	}
	return { signal: controller.signal, deadlineMs, controller, timer };
}
