/**
 * Unit tests for the session-switch guard (view-session-store.ts).
 *
 * Agent views are in-document panes and never switch sessions; the store's
 * one remaining job is the run-protection guard: while a USER-driven switch
 * (resume/new/fork) tears the current session down, the turn-abort it fires
 * must not cancel a foreground team run (run-deadline.ts reads this flag).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	clearSessionSwitchInFlight,
	isSessionSwitchInFlight,
	markSessionSwitchInFlight,
	resetCrewViewSessionState,
} from "../../../src/ui/inline-panel/view-session-store.ts";

test("session-switch-in-flight flag lifecycle (turn-abort run suppression)", () => {
	resetCrewViewSessionState();
	assert.equal(isSessionSwitchInFlight(), false, "defaults off");
	markSessionSwitchInFlight();
	assert.equal(isSessionSwitchInFlight(), true, "set before teardown's abort");
	clearSessionSwitchInFlight();
	assert.equal(isSessionSwitchInFlight(), false, "cleared when the switch lands");
	markSessionSwitchInFlight();
	resetCrewViewSessionState();
	assert.equal(isSessionSwitchInFlight(), false, "test reset also clears the flag");
});
