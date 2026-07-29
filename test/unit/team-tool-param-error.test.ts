import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTeamToolParamError } from "../../src/extension/team-tool/param-error.ts";
import { TeamToolParams } from "../../src/schema/team-tool-schema.ts";

/**
 * Regression guard for the opaque "Invalid team tool parameters" error that
 * made calling agents (LLMs) loop on malformed calls (e.g. goal as an array,
 * action with wrong casing). The formatted error must (a) name the offending
 * field + the received type/value, and (b) show correct-call examples.
 */
test("formatTeamToolParamError: names the offending field for goal-as-number", () => {
	const msg = formatTeamToolParamError(TeamToolParams, {
		action: "run",
		goal: 123,
		team: "default",
	});
	assert.match(msg, /goal/i, "should mention the 'goal' field");
	assert.match(msg, /number/i, "should mention the received type (number)");
	assert.match(msg, /Correct call shapes/i, "should include usage examples");
	assert.match(msg, /"action": "run"/, "should include a run example");
});

test("formatTeamToolParamError: surfaces wrong-casing on action", () => {
	const msg = formatTeamToolParamError(TeamToolParams, {
		action: "Run",
		goal: "do something",
	});
	assert.match(msg, /action/i, "should mention the 'action' field");
	assert.match(msg, /Run/, "should echo the wrong value the caller passed");
	assert.match(msg, /lowercase/i, "should hint that action is case-sensitive");
});

test("formatTeamToolParamError: lists examples for common actions", () => {
	const msg = formatTeamToolParamError(TeamToolParams, { unrecognized: "x" });
	assert.match(msg, /"action": "run"/);
	assert.match(msg, /"action": "recommend"/);
	assert.match(msg, /"action": "list"/);
	assert.match(msg, /"action": "status"/);
});

test("formatTeamToolParamError: never throws — degrades gracefully", () => {
	// Should not throw on weird inputs (circular, null, etc.)
	const weird = { a: 1 } as Record<string, unknown>;
	weird.self = weird; // circular
	const msg1 = formatTeamToolParamError(TeamToolParams, weird);
	const msg2 = formatTeamToolParamError(TeamToolParams, null);
	const msg3 = formatTeamToolParamError(TeamToolParams, undefined);
	assert.ok(typeof msg1 === "string" && msg1.length > 0);
	assert.ok(typeof msg2 === "string" && msg2.length > 0);
	assert.ok(typeof msg3 === "string" && msg3.length > 0);
});
