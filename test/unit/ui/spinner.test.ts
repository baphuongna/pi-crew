import assert from "node:assert/strict";
import test from "node:test";
import { SUBAGENT_SPINNER_FRAME_MS, SUBAGENT_SPINNER_FRAMES, spinnerBucket, spinnerFrame } from "../../../src/ui/spinner.ts";

test("spinnerBucket advances at the configured frame interval", () => {
	assert.equal(spinnerBucket(0), 0);
	assert.equal(spinnerBucket(SUBAGENT_SPINNER_FRAME_MS - 1), 0);
	assert.equal(spinnerBucket(SUBAGENT_SPINNER_FRAME_MS), 1);
});

test("spinnerFrame advances and phase-shifts per subagent key", () => {
	const first = spinnerFrame("agent-a", 0);
	const next = spinnerFrame("agent-a", SUBAGENT_SPINNER_FRAME_MS);
	assert.notEqual(first, next);
	assert.ok(SUBAGENT_SPINNER_FRAMES.includes(first as (typeof SUBAGENT_SPINNER_FRAMES)[number]));
	assert.ok(SUBAGENT_SPINNER_FRAMES.includes(spinnerFrame("agent-b", 0) as (typeof SUBAGENT_SPINNER_FRAMES)[number]));
});
