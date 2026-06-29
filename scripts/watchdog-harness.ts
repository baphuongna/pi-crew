/**
 * Watchdog harness — a minimal script that mimics the background-runner's
 * watchdog + keepAlive mechanism WITHOUT needing a real team/run manifest.
 *
 * This is used by test/integration/background-runner-watchdog-e2e.test.ts to
 * verify the watchdog fires and force-exits a hung process.
 *
 * Usage:
 *   node --experimental-strip-types scripts/watchdog-harness.ts
 *
 * Env vars:
 *   PI_CREW_MAX_RUN_MS          — watchdog timeout (ms). Default: 2h.
 *   PI_CREW_PARENT_PID          — parent guard PID. If parent dies, exit 124.
 *   PI_CREW_HARD_KILL_GRACE_MS  — grace period before force-exit. Default: 15000.
 *
 * The script:
 *   1. Starts the parent guard (self-terminates if parent dies)
 *   2. Starts a keepAlive interval (prevents event-loop exit)
 *   3. Starts a watchdog timer (fires after MAX_RUN_MS, schedules force-exit)
 *   4. NEVER resolves — simulating a hung team run
 *
 * Expected behaviour: process exits via watchdog force-exit within
 *   PI_CREW_MAX_RUN_MS + PI_CREW_HARD_KILL_GRACE_MS milliseconds.
 */

// ─── Config (from env — mirrors background-runner.ts) ─────────────────────────
const MAX_BACKGROUND_RUN_MS = (() => {
	const env = Number.parseInt(process.env.PI_CREW_MAX_RUN_MS ?? "", 10);
	return Number.isFinite(env) && env > 0 ? env : 2 * 60 * 60 * 1000; // 2h default
})();

const HARD_KILL_GRACE_MS = Number.parseInt(
	process.env.PI_CREW_HARD_KILL_GRACE_MS ?? "",
	10,
) || 15_000;

// ─── Global error handlers (mirror background-runner.ts patterns) ─────────────
// These prevent unhandled exceptions/rejections from crashing the process
// before the watchdog can fire. The harness deliberately hangs, so these are
// the only way to keep the process alive long enough for the watchdog to trigger.
process.on("uncaughtException", (err) => {
	console.error(`[watchdog-harness] uncaughtException: ${err.message}`);
});

process.on("unhandledRejection", (reason) => {
	const msg = reason instanceof Error ? reason.message : String(reason);
	console.error(`[watchdog-harness] unhandledRejection: ${msg}`);
});

// ─── Parent Guard ──────────────────────────────────────────────────────────────
const parentPid = Number(process.env.PI_CREW_PARENT_PID);
if (parentPid > 0) {
	const POLL_INTERVAL_MS = 500;

	function isPidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	const guard = setInterval(() => {
		// Wrap in try/catch: if isPidAlive throws unexpectedly (e.g. EPERM on
		// some platforms), we don't want the interval itself to crash and prevent
		// the watchdog from ever firing.
		try {
			if (!isPidAlive(parentPid)) {
				clearInterval(guard);
				process.exit(124); // 124 = "parent died" exit code
			}
		} catch (err) {
			// Unexpected error in parent guard — log and continue polling.
			console.error(`[watchdog-harness] parent-guard error: ${err}`);
		}
	}, POLL_INTERVAL_MS);
	// NOTE: intentionally NOT unref'd — must keep event loop alive while parent is alive.
}

// ─── KeepAlive (same interval as background-runner.ts) ─────────────────────────
const keepAlive = setInterval(() => {}, 5000);
// NOTE: intentionally NOT unref'd — must hold the event loop open while the
// process is alive. The event loop MUST stay alive so the forceExit setTimeout
// below can fire. If keepAlive is cleared too early, the event loop drains
// and all pending setTimeouts are silently cancelled before they fire.

// ─── Watchdog ─────────────────────────────────────────────────────────────────
// Track whether abort+force-exit has already been triggered (prevents double-fire).
let watchdogFired = false;

const watchdogTimer = setTimeout(() => {
	if (watchdogFired) return;
	watchdogFired = true;

	console.error(
		`[watchdog-harness] WATCHDOG: run exceeded ${MAX_BACKGROUND_RUN_MS}ms — scheduling force-exit in ${HARD_KILL_GRACE_MS}ms (zombie prevention)`,
	);

	// Hard-exit safety net: if the abort does not propagate within grace period,
	// force-kill so the process cannot linger. Matches background-runner.ts logic.
	// NOTE: keepAlive is NOT cleared here — it keeps the event loop alive so
	// the forceExit setTimeout below can fire. If keepAlive is cleared, the
	// event loop drains and forceExit is silently cancelled (observed: process
	// exits via module-level finally/runCleanup with the last exit code instead).
	const forceExit = setTimeout(() => {
		// Clear keepAlive only at the very end, right before force-exit.
		clearInterval(keepAlive);
		clearTimeout(watchdogTimer);
		process.exit(1);
	}, HARD_KILL_GRACE_MS);
	// NOTE: intentionally NOT unref'd — this timer MUST fire to force-exit.
}, MAX_BACKGROUND_RUN_MS);

// ─── Hung run simulation ──────────────────────────────────────────────────────
// NEVER resolve this promise — simulates a team run that hangs forever.
// The watchdog setTimeout above fires and force-exits the process first.
await new Promise<void>((resolve) => {
	// Intentionally never resolved. The unhandledRejection handler above keeps
	// the process alive until the watchdog fires and calls process.exit().
	void resolve;
});
