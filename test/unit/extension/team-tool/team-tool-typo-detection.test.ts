import assert from "node:assert/strict";
import test from "node:test";
import { detectUnrecognizedParams } from "../../../../src/extension/registration/team-tool.ts";
import { TeamToolParams } from "../../../../src/schema/team-tool-schema.ts";

// ---------------------------------------------------------------------------
// EXT-1: additionalProperties:true on TeamToolParams means Value.Check does NOT
// reject unknown keys. detectUnrecognizedParams scans for typo'd field names and
// suggests the closest known field, so a mistyped call gets an actionable hint
// instead of a generic handler error (which makes calling agents loop).
// ---------------------------------------------------------------------------

test("EXT-1: typo 'goals' is detected and suggests 'goal'", () => {
	const err = detectUnrecognizedParams(TeamToolParams, { action: "run", goals: "fix bug" });
	assert.ok(err, "should flag the unrecognized 'goals' field");
	assert.match(err, /goals/, "message should name the unrecognized field");
	assert.match(err, /did you mean 'goal'/, "should suggest the closest known field 'goal'");
});

test("EXT-1: typo 'runiD' is detected and suggests 'runId' (case-insensitive near-miss)", () => {
	const err = detectUnrecognizedParams(TeamToolParams, { action: "status", runiD: "abc" });
	assert.ok(err, "should flag the unrecognized 'runiD' field");
	assert.match(err, /runiD/, "message should name the unrecognized field");
	assert.match(err, /did you mean 'runId'/, "should suggest the closest known field 'runId'");
});

test("EXT-1: near-miss 'goa' still maps to 'goal'", () => {
	const err = detectUnrecognizedParams(TeamToolParams, { action: "run", goa: "x" });
	assert.ok(err);
	assert.match(err, /did you mean 'goal'/);
});

test("EXT-1: valid fields produce no false positive (returns null)", () => {
	assert.equal(detectUnrecognizedParams(TeamToolParams, { action: "run", goal: "fix the bug", team: "implementation" }), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, { action: "status", runId: "abc", details: false }), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, { action: "list" }), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, {}), null);
});

test("EXT-1: every known schema field is accepted (no false positive across the surface)", () => {
	const knownKeys = Object.keys((TeamToolParams as { properties?: Record<string, unknown> }).properties ?? {});
	const sample: Record<string, unknown> = {};
	for (const k of knownKeys) sample[k] = k === "action" ? "list" : "x";
	// all known keys together → no unrecognized field
	assert.equal(detectUnrecognizedParams(TeamToolParams, sample), null);
});

test("EXT-1: 'action' is never flagged as unrecognized", () => {
	// action is validated separately (schema enum) and excluded from the scan
	assert.equal(detectUnrecognizedParams(TeamToolParams, { action: "run", goal: "x" }), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, { action: "status", runId: "y" }), null);
});

test("EXT-1: multiple typos are all listed with their suggestions", () => {
	const err = detectUnrecognizedParams(TeamToolParams, { action: "run", goals: "x", runiD: "y", teem: "z" });
	assert.ok(err);
	assert.match(err, /goals/);
	assert.match(err, /runiD/);
	assert.match(err, /teem/);
	assert.match(err, /did you mean 'goal'/);
	assert.match(err, /did you mean 'runId'/);
	assert.match(err, /did you mean 'team'/);
	// message signals there is more than one issue
	assert.match(err, /fields:/);
});

test("EXT-1: unrecognizable key with no close match is still reported", () => {
	const err = detectUnrecognizedParams(TeamToolParams, { action: "run", totally_made_up_xyz123: "x" });
	assert.ok(err);
	assert.match(err, /totally_made_up_xyz123/);
	// no fabricated "did you mean" when nothing is close enough
	assert.doesNotMatch(err, /did you mean 'totally_made_up_xyz123'/);
});

test("EXT-1: non-object params return null (defensive — no false positive)", () => {
	assert.equal(detectUnrecognizedParams(TeamToolParams, null), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, undefined), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, "run"), null);
	assert.equal(detectUnrecognizedParams(TeamToolParams, ["run"]), null);
});
