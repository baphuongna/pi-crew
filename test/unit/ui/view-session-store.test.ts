/**
 * Unit tests for the process-wide agent-view session state (return path,
 * view-file detection, teardown survival, navigational-switch flag).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";

import {
	CREW_VIEW_SESSION_BASENAME,
	captureCommandCtx,
	clearSessionSwitchInFlight,
	currentCommandCtx,
	clearViewSwitchInFlight,
	getCrewViewSessionState,
	isCrewViewSessionFile,
	isSessionSwitchInFlight,
	isViewSwitchInFlight,
	markSessionSwitchInFlight,
	markViewSwitchInFlight,
	readViewParentSessionFile,
	resetCrewViewSessionState,
	resolveReturnSessionFile,
	setCrewViewSessionState,
} from "../../../src/ui/inline-panel/view-session-store.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../fixtures/test-tempdir.ts";

test("defaults: not viewing, no main session recorded", () => {
	resetCrewViewSessionState();
	const state = getCrewViewSessionState();
	assert.equal(state.active, false);
	assert.equal(state.runId, undefined);
	assert.equal(state.taskId, undefined);
	assert.equal(state.mainSessionFile, undefined);
});

test("set/get round-trip keeps the view target and return path", () => {
	resetCrewViewSessionState();
	setCrewViewSessionState({
		active: true,
		runId: "run_1",
		taskId: "task_1",
		mainSessionFile: "/tmp/main-session.jsonl",
	});
	const state = getCrewViewSessionState();
	assert.equal(state.active, true);
	assert.equal(state.runId, "run_1");
	assert.equal(state.taskId, "task_1");
	assert.equal(state.mainSessionFile, "/tmp/main-session.jsonl");
	resetCrewViewSessionState();
});

test("isCrewViewSessionFile matches the view basename only", () => {
	const view = path.join("/some/state/agents/task_1", CREW_VIEW_SESSION_BASENAME);
	assert.equal(isCrewViewSessionFile(view), true, "agent view file detected");
	assert.equal(isCrewViewSessionFile("/some/state/agents/task_1/events.jsonl"), false);
	assert.equal(isCrewViewSessionFile("/tmp/main-session.jsonl"), false);
	assert.equal(isCrewViewSessionFile(undefined), false);
	assert.equal(isCrewViewSessionFile(""), false);
});

test("reset clears the store entirely", () => {
	resetCrewViewSessionState();
	setCrewViewSessionState({ active: true, runId: "r", taskId: "t", mainSessionFile: "/tmp/m.jsonl" });
	resetCrewViewSessionState();
	const state = getCrewViewSessionState();
	assert.equal(state.active, false);
	assert.equal(state.mainSessionFile, undefined);
});

test("view-switch-in-flight flag lifecycle (navigational cleanup suppression)", () => {
	resetCrewViewSessionState();
	assert.equal(isViewSwitchInFlight(), false, "defaults off");
	markViewSwitchInFlight();
	assert.equal(isViewSwitchInFlight(), true, "set before switchSession");
	clearViewSwitchInFlight();
	assert.equal(isViewSwitchInFlight(), false, "cleared when the switch lands");
	markViewSwitchInFlight();
	resetCrewViewSessionState();
	assert.equal(isViewSwitchInFlight(), false, "test reset also clears the flag");
});

test("session-switch-in-flight flag lifecycle (turn-abort run suppression)", () => {
	resetCrewViewSessionState();
	assert.equal(isSessionSwitchInFlight(), false, "defaults off");
	markSessionSwitchInFlight();
	assert.equal(isSessionSwitchInFlight(), true, "set by session_before_switch before teardown");
	clearSessionSwitchInFlight();
	assert.equal(isSessionSwitchInFlight(), false, "cleared on the next session_start");
	markSessionSwitchInFlight();
	resetCrewViewSessionState();
	assert.equal(isSessionSwitchInFlight(), false, "test reset also clears the flag");
});

test("resolveReturnSessionFile prefers the CURRENT view file's parentSession header", () => {
	const dir = createTrackedTempDir("view-store");
	try {
		const viewFile = path.join(dir, "agents", "01_explore", CREW_VIEW_SESSION_BASENAME);
		fs.mkdirSync(path.dirname(viewFile), { recursive: true });
		fs.writeFileSync(
			viewFile,
			[JSON.stringify({ type: "session", version: 3, id: "crew-view-01", parentSession: "/tmp/main-session.jsonl" }), "{}"].join(
				"\n",
			),
			"utf8",
		);
		// Store is stale/reset — back must still find the way home.
		resetCrewViewSessionState();
		const target = resolveReturnSessionFile(viewFile, getCrewViewSessionState());
		assert.equal(target, "/tmp/main-session.jsonl");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("resolveReturnSessionFile falls back to the store's main file outside views", () => {
	resetCrewViewSessionState();
	setCrewViewSessionState({ active: true, mainSessionFile: "/tmp/main-session.jsonl" });
	assert.equal(resolveReturnSessionFile("/tmp/regular-session.jsonl", getCrewViewSessionState()), "/tmp/main-session.jsonl");
	assert.equal(resolveReturnSessionFile(undefined, { active: false }), undefined);
	resetCrewViewSessionState();
});

test("readViewParentSessionFile tolerates a missing or headerless file", () => {
	const dir = createTrackedTempDir("view-store");
	try {
		assert.equal(readViewParentSessionFile(path.join(dir, "does-not-exist.jsonl")), undefined);
		const headerless = path.join(dir, "headerless.jsonl");
		fs.writeFileSync(headerless, "{}\n", "utf8");
		assert.equal(readViewParentSessionFile(headerless), undefined);
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ── captured command context (direct view invocation) ──────────────────

test("currentCommandCtx returns the captured ctx only while the session id matches", () => {
	resetCrewViewSessionState();
	const ctxA = { sessionManager: { getSessionId: () => "sess-a" } };
	const ctxB = { sessionManager: { getSessionId: () => "sess-b" } };
	// No capture yet → undefined even with a valid current id.
	assert.equal(currentCommandCtx("sess-a"), undefined);
	captureCommandCtx(ctxA);
	// Matching id → the ctx itself.
	assert.equal(currentCommandCtx("sess-a"), ctxA);
	// Different session (a switch happened) → refuse the stale ctx.
	assert.equal(currentCommandCtx("sess-b"), undefined);
	captureCommandCtx(ctxB);
	assert.equal(currentCommandCtx("sess-b"), ctxB);
	// Unknown current id → fail closed.
	assert.equal(currentCommandCtx(undefined), undefined);
	resetCrewViewSessionState();
});

test("captureCommandCtx tolerates a ctx without a readable session id", () => {
	resetCrewViewSessionState();
	const opaque = {};
	captureCommandCtx(opaque);
	// No id pinned → never handed out (callers fall back to editor dispatch).
	assert.equal(currentCommandCtx(undefined), undefined);
	resetCrewViewSessionState();
});
