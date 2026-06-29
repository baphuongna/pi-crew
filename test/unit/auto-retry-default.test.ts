import test from "node:test";
import assert from "node:assert/strict";
import { shouldUseRetry } from "../../src/runtime/team-runner.ts";

/**
 * #1 (assessment): autoRetry now defaults ON (opt-out).
 * The v0.9.13 assessment found the entire retry+recovery stack was gated off
 * (`if (autoRetry !== true) return single-shot`), so every ChildTimeout
 * ("worker became unresponsive") failed the run with ZERO retries. This test
 * pins the new default so a future refactor cannot silently re-disable it.
 */
test("shouldUseRetry defaults to true (opt-out) — was opt-in before #1", () => {
	// undefined reliability → retry ON (the fix: was OFF before)
	assert.equal(shouldUseRetry(undefined), true);
	assert.equal(shouldUseRetry({}), true);
	// explicit opt-in still retry
	assert.equal(shouldUseRetry({ autoRetry: true }), true);
	// explicit opt-out disables retry (escape hatch)
	assert.equal(shouldUseRetry({ autoRetry: false }), false);
});
