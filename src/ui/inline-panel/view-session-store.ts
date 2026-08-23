/**
 * view-session-store.ts — session-switch guard for run protection.
 *
 * Agent views are in-document panes (see agent-pane.ts / inline-panel's
 * openPane): viewing an agent NEVER switches, resumes, or tears down a
 * session. This store is the one piece of session-switch machinery that
 * remains, and it protects runs from switches the USER makes (/resume, /new,
 * /fork): a switch tears the current session down via session.abort(), which
 * fires the abort signal of any tool call still in flight — a foreground
 * team run created by that tool is linked to the turn's abort, so ANY switch
 * seconds after a run starts used to kill the run's workers ("Child Pi
 * exited with 143" → run cancelled). While the guard is set, the
 * caller-abort propagation is suppressed (run-deadline.ts).
 *
 * Set by the session_before_switch handler (runs before teardown's abort),
 * cleared on the next session_start (the switch landed) and on reconcile.
 */

let sessionSwitchInFlight = false;

export function markSessionSwitchInFlight(): void {
	sessionSwitchInFlight = true;
}

export function clearSessionSwitchInFlight(): void {
	sessionSwitchInFlight = false;
}

export function isSessionSwitchInFlight(): boolean {
	return sessionSwitchInFlight;
}

/** Test isolation. */
export function resetCrewViewSessionState(): void {
	sessionSwitchInFlight = false;
}
