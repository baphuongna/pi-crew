/**
 * Parent liveness guard for pi-crew background-runner process.
 *
 * REALITY (verified by grep, RT-19/RT-2): `startParentGuard` is called in
 * exactly ONE production location — `background-runner.ts:508`. The
 * background-runner watches the main pi session that spawned it. If that
 * parent dies, the runner self-terminates so it does not leak.
 *
 * Child pi workers do NOT call `startParentGuard`. They are the external
 * `pi` binary (`@earendil-works/pi-coding-agent`) — pi-crew does not control
 * its entry point. Although `PI_CREW_PARENT_PID` is set in the child's env
 * (`child-pi-spawn.ts:134`), it has ZERO consumers: grep of the Pi binary
 * dist for `PI_CREW_PARENT_PID` / `startParentGuard` / `parent-guard` = 0
 * matches. This means child workers are NOT protected by this guard.
 *
 * The deeper fix (wiring `startParentGuard` into the pi worker entry point) is
 * DEFERRED because workers are an external binary pi-crew doesn't control.
 *
 * Orphan-mitigation for this gap relies on:
 *   1. The RT-2 SIGINT fix in `background-runner.ts` (abort + exitCode pattern
 *      lets the finally/runCleanup block terminate child-pi processes).
 *   2. The reactive `zombie-scanner.ts` sweep (finds workers whose
 *      `PI_CREW_PARENT_PID` points at a dead PID and reports them).
 *
 * Note: `process.kill(pid, 0)` works on both Unix and Windows in Node.js
 * for checking process existence. On Windows, it may throw for processes
 * owned by other users (permission error), but correctly detects dead PIDs.
 *
 * Usage in background-runner.ts (the ONLY consumer):
 * ```ts
 * const parentPid = Number(process.env.PI_CREW_PARENT_PID);
 * if (parentPid > 0) startParentGuard(parentPid);
 * ```
 *
 * ## Trust model
 *
 * `PI_CREW_PARENT_PID` is propagated from the spawning team-runner to each
 * child via the explicit env allow-list in `child-pi.ts`. The PID itself is
 * NOT a secret — process identifiers are public knowledge on Unix-like
 * systems (visible in `ps`, `/proc`, etc.) and carry no privilege.
 *
 * Residual risk: a malicious or compromised child can spoof
 * `process.env.PI_CREW_PARENT_PID` before invoking `startParentGuard()`.
 * This is acceptable because the parent-guard is a self-termination
 * signal, NOT a security boundary:
 *   - It only causes the (already-compromised) child to exit earlier.
 *   - A truly malicious child can simply not call `startParentGuard()`.
 *   - Real protection against hostile children comes from the env-filter
 *     allowlist and redaction — all enforced before spawn.
 *
 * The guard exists for the benign case: a parent dies (user closes the
 * terminal, pi crashes, machine loses power) and we want all detached
 * workers to stop wasting CPU. It is NOT an anti-tampering mechanism.
 */

/**
 * Poll interval for parent liveness checks (in milliseconds).
 * Default: 500ms. A parent killed by SIGKILL is detected within one poll
 * interval (max 500ms latency).
 *
 * For latency-sensitive workloads (e.g., preventing orphaned workers from
 * running with a dead supervisor), you can tune this lower by setting the
 * PI_CREW_PARENT_GUARD_INTERVAL_MS environment variable.
 *
 * WARNING: Values below 100ms significantly increase overhead for large
 * numbers of parallel workers, since each poll issues a process.kill(pid, 0)
 * syscall per worker. Only tune this if immediate detection is critical.
 *
 * FUTURE: An event-based SIGCHLD handler could supplement or replace this
 * polling approach for near-instantaneous parent-death detection on Unix
 * systems, avoiding the polling overhead entirely.
 */
const POLL_INTERVAL_MS = Number(process.env.PI_CREW_PARENT_GUARD_INTERVAL_MS) || 500;

const guardIntervals = new Map<number, ReturnType<typeof setInterval>>();

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function selfTerminate(parentPid: number): never {
	// Best-effort: try to log why we're dying
	try {
		if (typeof process.stderr?.write === "function") {
			process.stderr.write(`[pi-crew] Parent process ${parentPid} is dead — self-terminating worker ${process.pid}\n`);
		}
	} catch {
		// Ignore
	}
	process.exit(124); // 124 = "parent died" exit code
}

/**
 * Start a lightweight poll that checks if the parent process is still alive.
 * If the parent dies, the calling process exits immediately with code 124.
 *
 * CURRENT REALITY: the only production caller is `background-runner.ts`, which
 * uses this to self-terminate when the main pi session dies. Child pi workers
 * do NOT call this (see module header for the DEFERRED deeper fix).
 *
 * FIX: Removed unref() — the guard interval MUST keep the event loop alive
 * to prevent premature runner exit when the parent is still alive but the
 * runner has no other pending work (LLM calls, timers, I/O). Without this,
 * a runner in pure CPU wait could exit even though its parent is alive.
 */
export function startParentGuard(parentPid: number): void {
	if (!parentPid || !Number.isFinite(parentPid) || parentPid <= 0) return;

	// Clear any existing guard for this specific parentPid before setting a new one
	const existing = guardIntervals.get(parentPid);
	if (existing) clearInterval(existing);

	// Add ±20% jitter to prevent synchronized polling across workers that
	// start simultaneously (e.g., after pi restart). Without jitter, all
	// workers would poll at exactly the same interval, creating load spikes.
	const jitter = POLL_INTERVAL_MS * 0.2 * (Math.random() - 0.5) * 2;
	const actualInterval = POLL_INTERVAL_MS + jitter;

	const interval = setInterval(() => {
		// Immediate check on every tick — detects parent death within one poll
		// interval (max POLL_INTERVAL_MS latency, default 500ms).
		if (!isPidAlive(parentPid)) {
			const guard = guardIntervals.get(parentPid);
			if (guard) clearInterval(guard);
			guardIntervals.delete(parentPid);
			selfTerminate(parentPid);
		}
	}, actualInterval);

	guardIntervals.set(parentPid, interval);

	// NOTE: Intentionally NOT calling guardInterval.unref() here.
	// The watchdog timer must keep the event loop alive to ensure the worker
	// doesn't exit while the parent is alive. If other work (child processes,
	// timers, I/O) keeps the loop alive, that's fine — the guard runs as a
	// side effect. If no other work exists, the guard is the only thing
	// keeping the process alive, and that's by design.
}

/**
 * Stop the parent guard. Called when the worker finishes normally
 * and doesn't need to watch the parent anymore.
 */
export function stopParentGuard(): void {
	for (const interval of guardIntervals.values()) {
		clearInterval(interval);
	}
	guardIntervals.clear();
}
