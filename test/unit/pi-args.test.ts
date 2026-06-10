import test from "node:test";
import assert from "node:assert/strict";
import {
	applyThinkingSuffix,
	currentCrewDepth,
	resolveCrewMaxDepth,
	checkCrewDepth,
} from "../../src/runtime/pi-args.ts";

/**
 * Round 26 (test coverage gaps): `pi-args.ts` provides depth tracking,
 * model+thinking suffix logic, and argument building for Pi worker spawning.
 *
 * Tests cover the pure-function surface. buildPiWorkerArgs and cleanupTempDir
 * require file I/O and are not tested here.
 */

// ─── applyThinkingSuffix ───────────────────────────────────────────────────

test("applyThinkingSuffix: returns model unchanged when thinking is off", () => {
	assert.equal(applyThinkingSuffix("gpt-4", "off"), "gpt-4");
});

test("applyThinkingSuffix: returns model unchanged when thinking is undefined", () => {
	assert.equal(applyThinkingSuffix("gpt-4", undefined), "gpt-4");
});

test("applyThinkingSuffix: returns undefined when model is undefined", () => {
	assert.equal(applyThinkingSuffix(undefined, "high"), undefined);
});

test("applyThinkingSuffix: appends valid thinking level", () => {
	assert.equal(applyThinkingSuffix("gpt-4", "high"), "gpt-4:high");
	assert.equal(applyThinkingSuffix("claude-3", "medium"), "claude-3:medium");
	assert.equal(applyThinkingSuffix("model", "minimal"), "model:minimal");
	assert.equal(applyThinkingSuffix("model", "low"), "model:low");
	assert.equal(applyThinkingSuffix("model", "xhigh"), "model:xhigh");
});

test("applyThinkingSuffix: does not double-append if model already has thinking suffix", () => {
	assert.equal(applyThinkingSuffix("gpt-4:high", "medium"), "gpt-4:high");
	assert.equal(applyThinkingSuffix("claude-3:low", "high"), "claude-3:low");
});

test("applyThinkingSuffix: ignores invalid thinking level", () => {
	assert.equal(applyThinkingSuffix("gpt-4", "invalid"), "gpt-4");
	assert.equal(applyThinkingSuffix("gpt-4", "EXTREME"), "gpt-4");
});

// ─── currentCrewDepth ──────────────────────────────────────────────────────

test("currentCrewDepth: returns 0 when no env vars set", () => {
	assert.equal(currentCrewDepth({}), 0);
});

test("currentCrewDepth: reads PI_CREW_DEPTH", () => {
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "3" }), 3);
});

test("currentCrewDepth: falls back to PI_TEAMS_DEPTH", () => {
	assert.equal(currentCrewDepth({ PI_TEAMS_DEPTH: "2" }), 2);
});

test("currentCrewDepth: prefers PI_CREW_DEPTH over PI_TEAMS_DEPTH", () => {
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "3", PI_TEAMS_DEPTH: "5" }), 3);
});

test("currentCrewDepth: returns 0 for negative values", () => {
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "-1" }), 0);
});

test("currentCrewDepth: returns 0 for non-integer values", () => {
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "1.5" }), 0);
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "abc" }), 0);
});

// ─── resolveCrewMaxDepth ───────────────────────────────────────────────────

test("resolveCrewMaxDepth: defaults to 2", () => {
	assert.equal(resolveCrewMaxDepth(undefined, {}), 2);
});

test("resolveCrewMaxDepth: uses PI_CREW_MAX_DEPTH env var (1-10)", () => {
	assert.equal(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "5" }), 5);
});

test("resolveCrewMaxDepth: falls back to PI_TEAMS_MAX_DEPTH", () => {
	assert.equal(resolveCrewMaxDepth(undefined, { PI_TEAMS_MAX_DEPTH: "3" }), 3);
});

test("resolveCrewMaxDepth: prefers PI_CREW_MAX_DEPTH over PI_TEAMS_MAX_DEPTH", () => {
	assert.equal(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "4", PI_TEAMS_MAX_DEPTH: "8" }), 4);
});

test("resolveCrewMaxDepth: uses inputMaxDepth when env is not set", () => {
	assert.equal(resolveCrewMaxDepth(5, {}), 5);
});

test("resolveCrewMaxDepth: env overrides inputMaxDepth", () => {
	assert.equal(resolveCrewMaxDepth(5, { PI_CREW_MAX_DEPTH: "3" }), 3);
});

test("resolveCrewMaxDepth: clamps env values above 10 to 10", () => {
	assert.equal(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "11" }), 10);
});

test("resolveCrewMaxDepth: ignores env values below 1 and non-integers", () => {
	assert.equal(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "0" }), 2);
	assert.equal(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "-1" }), 2);
});

test("resolveCrewMaxDepth: ignores non-integer env values", () => {
	assert.equal(resolveCrewMaxDepth(undefined, { PI_CREW_MAX_DEPTH: "abc" }), 2);
});

// ─── checkCrewDepth ────────────────────────────────────────────────────────

test("checkCrewDepth: not blocked at depth 0, maxDepth 2", () => {
	const result = checkCrewDepth(undefined, {});
	assert.equal(result.blocked, false);
	assert.equal(result.depth, 0);
	assert.equal(result.maxDepth, 2);
});

test("checkCrewDepth: blocked when depth equals maxDepth", () => {
	const result = checkCrewDepth(undefined, { PI_CREW_DEPTH: "2", PI_CREW_MAX_DEPTH: "2" });
	assert.equal(result.blocked, true);
	assert.equal(result.depth, 2);
	assert.equal(result.maxDepth, 2);
});

test("checkCrewDepth: blocked when depth exceeds maxDepth", () => {
	const result = checkCrewDepth(undefined, { PI_CREW_DEPTH: "5", PI_CREW_MAX_DEPTH: "3" });
	assert.equal(result.blocked, true);
	assert.equal(result.depth, 5);
	assert.equal(result.maxDepth, 3);
});

test("checkCrewDepth: not blocked when depth is below maxDepth", () => {
	const result = checkCrewDepth(undefined, { PI_CREW_DEPTH: "1", PI_CREW_MAX_DEPTH: "3" });
	assert.equal(result.blocked, false);
	assert.equal(result.depth, 1);
	assert.equal(result.maxDepth, 3);
});
