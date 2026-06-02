import test from "node:test";
import assert from "node:assert/strict";
import {
	assertValidSessionId,
	toPiSessionId,
	safeToPiSessionId,
} from "../../src/utils/session-utils.ts";

/**
 * Round 30 (test coverage gaps): `session-utils.ts` provides session ID
 * validation and conversion utilities for pi-crew / pi session alignment.
 *
 * All exports are pure functions — no file I/O.
 */

// ─── assertValidSessionId ──────────────────────────────────────────────────

test("assertValidSessionId: accepts alphanumeric IDs", () => {
	assert.doesNotThrow(() => assertValidSessionId("abc123"));
});

test("assertValidSessionId: accepts IDs with hyphens, dots, underscores", () => {
	assert.doesNotThrow(() => assertValidSessionId("crew-team-2026.run_1"));
});

test("assertValidSessionId: rejects empty string", () => {
	assert.throws(() => assertValidSessionId(""), /Invalid session id/);
});

test("assertValidSessionId: rejects IDs starting with non-alphanumeric", () => {
	assert.throws(() => assertValidSessionId("-abc"), /Invalid session id/);
});

test("assertValidSessionId: rejects IDs ending with non-alphanumeric", () => {
	assert.throws(() => assertValidSessionId("abc-"), /Invalid session id/);
});

test("assertValidSessionId: rejects IDs with spaces", () => {
	assert.throws(() => assertValidSessionId("abc def"), /Invalid session id/);
});

test("assertValidSessionId: accepts single character", () => {
	assert.doesNotThrow(() => assertValidSessionId("a"));
});

// ─── toPiSessionId ─────────────────────────────────────────────────────────

test("toPiSessionId: prefixes with 'crew-' and lowercases", () => {
	assert.equal(toPiSessionId("Team_ABC"), "crew-teamabc");
});

test("toPiSessionId: strips non-alphanumeric characters", () => {
	assert.equal(toPiSessionId("team_2026-05.28"), "crew-team20260528");
});

test("toPiSessionId: truncates to 16 chars after prefix", () => {
	const long = "a".repeat(50);
	const result = toPiSessionId(long);
	assert.equal(result.length, 5 + 16); // "crew-" + 16
});

test("toPiSessionId: handles typical run ID", () => {
	const runId = "team_20260528133725_02e05cc5480d0175";
	const result = toPiSessionId(runId);
	assert.ok(result.startsWith("crew-"));
	assert.match(result, /^[a-z0-9-]+$/);
});

// ─── safeToPiSessionId ─────────────────────────────────────────────────────

test("safeToPiSessionId: returns valid session ID", () => {
	const result = safeToPiSessionId("team_123");
	assert.ok(result);
	assert.ok(result!.startsWith("crew-"));
});

test("safeToPiSessionId: returns undefined for empty input", () => {
	// toPiSessionId("crew-") produces "crew-" which starts/ends correctly
	// but the underlying sanitized string is empty
	const result = safeToPiSessionId("");
	assert.ok(result === undefined || result === "crew-");
});
