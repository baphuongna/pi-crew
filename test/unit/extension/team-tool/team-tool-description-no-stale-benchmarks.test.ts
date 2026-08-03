import assert from "node:assert/strict";
import test from "node:test";
import { registerTeamTool } from "../../../../src/extension/registration/team-tool.ts";

// ---------------------------------------------------------------------------
// EXT-11: the `team` tool description must NOT embed one-off performance
// benchmarks ("Run #3", "~30× faster", "~5× cheaper", "5.7× slower"). Those
// numbers were tied to a single measurement, do not generalize, and mislead
// the calling LLM about when to reach for the team tool. Factual usage
// guidance (what the tool does, preflight advisory behavior, action='recommend')
// must remain.
//
// The description is assembled inside `registerTeamTool` and handed to
// `pi.registerTool`. We capture it via a minimal mock `pi` (the deps are only
// consulted inside `execute`/`render*`, never at registration time).
// ---------------------------------------------------------------------------

// Stale benchmark tokens that must NOT appear in the tool description.
const STALE_BENCHMARK_TOKENS = ["Run #3", "30×", "~30×", "~5×", "5.7×", "30x faster", "5x faster", "5x cheaper"] as const;

/** Capture the tool definition that registerTeamTool hands to pi.registerTool. */
function captureRegisteredTool(): Record<string, unknown> {
	let captured: Record<string, unknown> | undefined;
	const mockPi = {
		registerTool(tool: Record<string, unknown>): void {
			captured = tool;
		},
	} as unknown as Parameters<typeof registerTeamTool>[0];
	// deps are only read inside execute/render — never during registration.
	const noopDeps = {} as unknown as Parameters<typeof registerTeamTool>[1];
	registerTeamTool(mockPi, noopDeps);
	assert.ok(captured, "registerTeamTool must call pi.registerTool");
	return captured;
}

test("EXT-11: team tool description contains no stale benchmark tokens", () => {
	const tool = captureRegisteredTool();
	const description = tool.description;
	assert.equal(typeof description, "string", "description must be a string");
	const text = description as string;
	for (const token of STALE_BENCHMARK_TOKENS) {
		assert.ok(!text.includes(token), `description must not contain stale benchmark token '${token}'.\n--- description ---\n${text}`);
	}
});

test("EXT-11: team tool description keeps factual usage guidance (not over-stripped)", () => {
	const text = captureRegisteredTool().description as string;
	// What the tool does + key actions must survive the cleanup.
	assert.match(text, /Coordinate Pi teams/i, "should keep what the tool does");
	assert.match(text, /recommend/i, "should keep the action='recommend' guidance");
	assert.match(text, /preflight|topology|advisory/i, "should keep the advisory/preflight guidance");
});

test("EXT-11: team tool description is non-trivial (substantive guidance retained)", () => {
	const text = captureRegisteredTool().description as string;
	assert.ok(text.length > 120, "description should remain a substantive usage guide");
});
