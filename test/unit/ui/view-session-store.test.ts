/**
 * Unit tests for the process-wide agent-view session state (return path,
 * view-file detection, teardown survival).
 */

import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";

import {
	CREW_VIEW_SESSION_BASENAME,
	getCrewViewSessionState,
	isCrewViewSessionFile,
	resetCrewViewSessionState,
	setCrewViewSessionState,
} from "../../../src/ui/inline-panel/view-session-store.ts";

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
