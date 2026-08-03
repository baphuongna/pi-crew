/**
 * P2-25 regression guard: supervisor_contact events must reach recordSupervisorContact.
 *
 * Before the fix the feature was fully dead:
 *   - `onStdoutLine` received `compact.displayLine` (prose), never the JSON, and
 *   - `displayTextFromCompactEvent` returned undefined for supervisor_contact so
 *     onStdoutLine never fired for it, AND
 *   - the compact pipeline's generic fallthrough stripped everything but `type`,
 *     so even onJsonEvent only saw `{type:"supervisor_contact"}` with no payload.
 *
 * The fix: compact passes the full payload through, and onJsonEvent routes it to
 * recordSupervisorContact via supervisorContactFromEvent.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChildPiRunInput } from "../../../../src/runtime/child-pi/child-pi.ts";
import { ChildPiLineObserver } from "../../../../src/runtime/child-pi/child-pi-streams.ts";
import { parseSupervisorContactFromLine, supervisorContactFromEvent } from "../../../../src/runtime/supervisor-contact.ts";

function makeObserver(onJsonEvent?: (e: unknown) => void): ChildPiLineObserver {
	// Minimal input shape; only the callbacks matter for this test.
	return new ChildPiLineObserver({ onJsonEvent } as unknown as ChildPiRunInput);
}

test("supervisorContactFromEvent: valid event yields normalized payload", () => {
	const payload = supervisorContactFromEvent({
		type: "supervisor_contact",
		taskId: "t1",
		reason: "approval",
		message: "need approval",
		data: { x: 1 },
	});
	assert.deepEqual(payload, { taskId: "t1", reason: "approval", message: "need approval", data: { x: 1 } });
});

test("supervisorContactFromEvent: accepts crew_supervisor_contact alias + defaults missing fields", () => {
	const payload = supervisorContactFromEvent({ type: "crew_supervisor_contact" });
	assert.equal(payload?.taskId, "");
	assert.equal(payload?.reason, "custom"); // unknown reason → custom
	assert.equal(payload?.message, "");
	assert.equal(payload?.data, undefined);
});

test("supervisorContactFromEvent: non-supervisor types → undefined", () => {
	assert.equal(supervisorContactFromEvent({ type: "message" }), undefined);
	assert.equal(supervisorContactFromEvent({ type: "tool_execution_start" }), undefined);
	assert.equal(supervisorContactFromEvent("not an object"), undefined);
	assert.equal(supervisorContactFromEvent(null), undefined);
});

test("parseSupervisorContactFromLine (deprecated) still works via shared validator", () => {
	const line = JSON.stringify({ type: "supervisor_contact", taskId: "t2", reason: "clarification", message: "huh?" });
	const payload = parseSupervisorContactFromLine(line);
	assert.equal(payload?.taskId, "t2");
	assert.equal(payload?.reason, "clarification");
	// Non-JSON line → undefined (no throw).
	assert.equal(parseSupervisorContactFromLine("plain prose, not json"), undefined);
});

test("COMPACT PASS-THROUGH: observer delivers full supervisor_contact payload to onJsonEvent", () => {
	const seen: unknown[] = [];
	const observer = makeObserver((e) => seen.push(e));
	const ndjson = JSON.stringify({
		type: "supervisor_contact",
		taskId: "t9",
		reason: "decision_needed",
		message: "which path?",
		data: { options: 2 },
	});
	observer.observe(`${ndjson}\n`);
	assert.equal(seen.length, 1, "exactly one onJsonEvent fired");
	const ev = seen[0] as Record<string, unknown>;
	assert.equal(ev.type, "supervisor_contact");
	assert.equal(ev.taskId, "t9", "taskId preserved through compact");
	assert.equal(ev.reason, "decision_needed", "reason preserved");
	assert.equal(ev.message, "which path?", "message preserved");
	assert.deepEqual(ev.data, { options: 2 }, "data preserved");
	// And it validates via the shared validator.
	const payload = supervisorContactFromEvent(ev);
	assert.equal(payload?.taskId, "t9");
});

test("COMPACT PASS-THROUGH: a non-supervisor event is NOT mistaken for one", () => {
	const seen: unknown[] = [];
	const observer = makeObserver((e) => seen.push(e));
	observer.observe(`${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`);
	assert.equal(seen.length, 1);
	assert.equal(supervisorContactFromEvent(seen[0]), undefined, "message event is not a supervisor contact");
});
