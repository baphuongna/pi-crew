import assert from "node:assert/strict";
import test from "node:test";
import { goalTokenCount, resolveRoutingHint, SMALL_GOAL_TOKEN_THRESHOLD } from "../../../src/extension/team-tool/routing-hint.ts";

/**
 * DP-04 (2026-09-22): small-goal routing hint. A trivial goal pays ~8k tokens
 * of 3-phase context setup in the default team; the engine already supports
 * singleAgent. The hint must be EXPLAINABLE and never override an explicit
 * choice (silent routing changes are a known hazard in this project).
 *
 * Mutation: drop the explicitOverride guard → the override case goes RED.
 */

test("DP-04: mode 'off' never suggests", () => {
	const hint = resolveRoutingHint({ goal: "fix the typo", explicitOverride: false, mode: "off" });
	assert.equal(hint.suggested, false);
});

test("DP-04: small goal (default mode) is suggested with a visible reason", () => {
	const hint = resolveRoutingHint({ goal: "rename the variable x to y", explicitOverride: false });
	assert.equal(hint.suggested, true);
	assert.match(hint.reason ?? "", /small/);
	assert.match(hint.message ?? "", /singleAgent/);
	assert.ok(hint.estimatedSavings, "must state an estimated saving");
});

test("DP-04: a large goal is NOT suggested", () => {
	const big = Array.from({ length: SMALL_GOAL_TOKEN_THRESHOLD + 20 }, (_, i) => `word${i}`).join(" ");
	const hint = resolveRoutingHint({ goal: big, explicitOverride: false });
	assert.equal(hint.suggested, false);
});

test("DP-04: boundary — exactly the threshold suggests, one over does not", () => {
	const at = Array.from({ length: SMALL_GOAL_TOKEN_THRESHOLD }, (_, i) => `w${i}`).join(" ");
	const over = Array.from({ length: SMALL_GOAL_TOKEN_THRESHOLD + 1 }, (_, i) => `w${i}`).join(" ");
	assert.equal(goalTokenCount(at), SMALL_GOAL_TOKEN_THRESHOLD);
	assert.equal(resolveRoutingHint({ goal: at, explicitOverride: false }).suggested, true);
	assert.equal(resolveRoutingHint({ goal: over, explicitOverride: false }).suggested, false);
});

test("DP-04: an explicit team/workflow override suppresses the hint", () => {
	const hint = resolveRoutingHint({ goal: "tiny goal", explicitOverride: true });
	assert.equal(hint.suggested, false, "must never second-guess an explicit override");
});

test("DP-04: empty goal is not suggested", () => {
	assert.equal(resolveRoutingHint({ goal: "   ", explicitOverride: false }).suggested, false);
	assert.equal(goalTokenCount("   "), 0);
});
