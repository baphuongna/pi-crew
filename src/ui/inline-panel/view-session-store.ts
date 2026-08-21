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
 */

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

export function getCrewViewSessionState(): CrewViewSessionState {
	return state;
}

export function isCrewViewActive(): boolean {
	return state.active;
}

export function setCrewViewSessionState(next: CrewViewSessionState): void {
	state = next;
}

/** True when the given session file path is one of our agent-view sessions. */
export function isCrewViewSessionFile(file: string | undefined): boolean {
	if (!file) return false;
	const base = file.split(/[\\/]/).pop() ?? "";
	return base === CREW_VIEW_SESSION_BASENAME;
}

/** Test isolation. */
export function resetCrewViewSessionState(): void {
	state = { active: false };
}
