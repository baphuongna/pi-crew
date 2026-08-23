/**
 * view-session-store.ts — process-wide state for the "agent session view".
 *
 * Entering an agent row opens a REAL pi session (the agent's transcript as a
 * resume-able session file) via `/crew-view`; escape (or `/crew-back`) returns
 * to the main session. This store remembers WHICH agent is being viewed and
 * the MAIN session file to return to.
 *
 * Unlike panel-store it is NOT reset on session_shutdown: switching sessions
 * tears the old one down, and the return-path must survive that teardown.
 * It is reconciled on every session_start (see installInlinePanel): when the
 * current session file is a crew view file the view stays active; otherwise
 * the store snaps back to "not viewing" and refreshes the main session path.
 *
 * The return path is DEFENSIVE by design: the store can be reset by a stale
 * reconcile before the view's own session_start lands, so `/crew-back` does
 * not rely on `mainSessionFile` alone — it re-reads the parent session from
 * the CURRENT view file's header when the active session IS a view
 * (`resolveReturnSessionFile`).
 */

import { closeSync, openSync, readSync } from "node:fs";

export const CREW_VIEW_SESSION_BASENAME = "view-session.jsonl";

export interface CrewViewSessionState {
	/** True while the active pi session is an agent view session. */
	active: boolean;
	/** Run + task being viewed (used for labels and re-entry). */
	runId?: string;
	taskId?: string;
	/** Absolute path of the main session file to return to on `/crew-back`. */
	mainSessionFile?: string;
	/**
	 * Pi session id of the MAIN session (the run's owner). While the view
	 * session is active, run-scoped surfaces (crew-widget dock rows, powerbar,
	 * live agents) must filter by THIS id — the view session has its own id,
	 * which would hide the run being viewed.
	 */
	mainSessionId?: string;
}

let state: CrewViewSessionState = { active: false };

/**
 * True while a `/crew-view` or `/crew-back` switchSession is in flight.
 *
 * During a NAVIGATIONAL switch the session-lifecycle cleanup MUST NOT abort
 * session-bound subagents / child pi workers: the user is only looking at a
 * worker's session, and the run must keep running (regression: entering the
 * view killed the workers → "Child Pi exited with 143" → run cancelled).
 * set/clear sandwich the switchSession call; cleared again defensively on the
 * next session_start (the switch landed) and when the switch is cancelled.
 */
let viewSwitchInFlight = false;

export function markViewSwitchInFlight(): void {
	viewSwitchInFlight = true;
}

export function clearViewSwitchInFlight(): void {
	viewSwitchInFlight = false;
}

export function isViewSwitchInFlight(): boolean {
	return viewSwitchInFlight;
}

/**
 * True while a session switch (resume / new / fork — INCLUDING /crew-view)
 * is tearing the current session down.
 *
 * teardownCurrent() calls session.abort(), which fires the abort signal of
 * any tool call still in flight. A foreground team run created by that tool
 * is linked to the turn's abort (caller-abort propagation in the run
 * deadline) — so ANY switch seconds after a run starts killed the run's
 * workers ("Child Pi exited with 143" → run cancelled). The run must keep
 * running across switches (P0: foreground runs survive session switches);
 * suppress the caller-abort propagation while this flag is set.
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

export function getCrewViewSessionState(): CrewViewSessionState {
	return state;
}

// ── Captured command context ───────────────────────────────────────────
//
// Command contexts are the ONLY extension surface exposing `switchSession` /
// `waitForIdle`. Any crew command the user runs hands its handler a fresh
// one; capturing the latest lets the inline panel invoke view commands
// DIRECTLY (no text submission), which matters while a foreground team run
// is mid-tool-call: pi queues editor submits as pending inputs in that
// state, so a submitted "/crew-view …" only executed after the whole turn
// ended. A captured ctx dies with its session (assertActive throws), so it
// is only reused while the session id still matches.

export interface CapturedCommandCtx {
	/** The command context (ExtensionCommandContext-shaped; kept opaque here). */
	ctx: unknown;
	/** Session id the ctx belonged to, when available. */
	sessionId?: string;
}

let capturedCommandCtx: CapturedCommandCtx | undefined;

/** Remember the most recent command context handed to a crew command. */
export function captureCommandCtx(ctx: unknown): void {
	let sessionId: string | undefined;
	try {
		const id = (ctx as { sessionManager?: { getSessionId?: () => unknown } } | undefined)?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) sessionId = id;
	} catch {
		/* stale ctx already — nothing durable to pin */
	}
	capturedCommandCtx = { ctx, sessionId };
}

/**
 * The captured command context, but ONLY while it still belongs to the given
 * (current) session id. Unavailable/unknown ids make the check fail closed —
 * callers fall back to the editor dispatch, which is always safe.
 */
export function currentCommandCtx(currentSessionId: string | undefined): unknown {
	if (!capturedCommandCtx) return undefined;
	if (typeof currentSessionId !== "string" || !currentSessionId) return undefined;
	return capturedCommandCtx.sessionId === currentSessionId ? capturedCommandCtx.ctx : undefined;
}

/** Test isolation. */
export function resetCapturedCommandCtx(): void {
	capturedCommandCtx = undefined;
}

export function isCrewViewActive(): boolean {
	return state.active;
}

export function setCrewViewSessionState(next: CrewViewSessionState): void {
	state = next;
}

/** True when the given session file path is one of our agent-view sessions. */
export function isCrewViewSessionFile(file: string | undefined): file is string {
	if (!file) return false;
	const base = file.split(/[\\/]/).pop() ?? "";
	return base === CREW_VIEW_SESSION_BASENAME;
}

/**
 * Read the `parentSession` recorded in a view session file's header (written
 * by buildAgentViewSessionFile) — the main session to return to. Capped read:
 * only the first 4 KiB of the file are touched.
 */
export function readViewParentSessionFile(viewSessionFile: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(viewSessionFile, "r");
		const buf = Buffer.alloc(4096);
		const bytesRead = readSync(fd, buf, 0, buf.length, 0);
		if (bytesRead <= 0) return undefined;
		const firstLine = buf.toString("utf8", 0, bytesRead).split("\n", 1)[0];
		if (!firstLine) return undefined;
		const header = JSON.parse(firstLine) as { parentSession?: unknown };
		return typeof header.parentSession === "string" && header.parentSession ? header.parentSession : undefined;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				/* best-effort */
			}
		}
	}
}

/**
 * Resolve the session file `/crew-back` should return to.
 *
 * Prefers the parent session recorded in the CURRENT session file when it is
 * one of our views (self-healing: a stale reconcile can clear the store while
 * a view is active — the view file itself never forgets the way back), and
 * falls back to the store's recorded main file otherwise.
 */
export function resolveReturnSessionFile(currentSessionFile: string | undefined, prev: CrewViewSessionState): string | undefined {
	if (isCrewViewSessionFile(currentSessionFile)) {
		const fromHeader = readViewParentSessionFile(currentSessionFile);
		if (fromHeader) return fromHeader;
	}
	return prev.mainSessionFile;
}

/** Test isolation. */
export function resetCrewViewSessionState(): void {
	state = { active: false };
	viewSwitchInFlight = false;
	sessionSwitchInFlight = false;
	capturedCommandCtx = undefined;
}
