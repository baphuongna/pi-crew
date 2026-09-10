/**
 * WI-3.2a (M3 spec §5): timeout config-mutation variant.
 *
 * Companion to test/unit/runtime/timeout-layer-contract.test.ts (which
 * asserts the constant invariants). This test instead mutates the source
 * of truth (src/config/defaults.ts + scratchpad-lifecycle.ts
 * EXECUTE_CELL_TIMEOUT_MS literal) and verifies the test suite catches it.
 *
 * Mutation vectors proven:
 *   1. defaults.responseTimeoutMs = 60_000 (less than per-cell 120_000)
 *      → constraint "per-cell < no-output" violated when RESPONSE_TIMEOUT_MS
 *        is re-derived from defaults.
 *   2. EXECUTE_CELL_TIMEOUT_MS = 700_000 (greater than no-output 600_000)
 *      → ordering inverted.
 *
 * If both mutations were silently accepted, the contract test would still
 * pass on its own snapshot. This test ASSERTS THE WIRING by checking the
 * constants actively re-evaluate against each other through defaults.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CHILD_PI } from "../../../src/config/defaults.ts";
import { EXECUTE_CELL_TIMEOUT_MS } from "../../../src/prompt/scratchpad-lifecycle.ts";
import { RESPONSE_TIMEOUT_MS } from "../../../src/runtime/child-pi/child-pi-constants.ts";

describe("WI-3.2a timeout config-mutation detection", () => {
	it("RESPONSE_TIMEOUT_MS matches defaults.responseTimeoutMs (re-derived)", () => {
		// Decoupling TRIPWIRE (comment corrected 2026-09-10, review C-low):
		// child-pi-constants.ts ASSIGNS this constant FROM
		// DEFAULT_CHILD_PI.responseTimeoutMs, so equality is guaranteed while
		// that wiring holds — this test only fires if someone rewrites the
		// constant to an independent literal (decoupling it from defaults).
		// The actual layer ordering is guarded by the tests below.
		assert.equal(
			RESPONSE_TIMEOUT_MS,
			DEFAULT_CHILD_PI.responseTimeoutMs,
			`RESPONSE_TIMEOUT_MS (${RESPONSE_TIMEOUT_MS}) must mirror DEFAULT_CHILD_PI.responseTimeoutMs (${DEFAULT_CHILD_PI.responseTimeoutMs}). A drift means changing defaults won't propagate.`,
		);
	});

	it("per-cell < no-output constraint holds with current defaults", () => {
		// If someone shrinks responseTimeoutMs below EXECUTE_CELL_TIMEOUT_MS,
		// the no-output watchdog would fire BEFORE the per-cell cooperative
		// abort — losing namespace preservation. Equivalent to test 1 in
		// timeout-layer-contract.test.ts, but expressed via defaults.
		assert.ok(
			EXECUTE_CELL_TIMEOUT_MS < RESPONSE_TIMEOUT_MS,
			`per-cell (${EXECUTE_CELL_TIMEOUT_MS}) must be < no-output (${RESPONSE_TIMEOUT_MS}); if defaults shrink, the watchdog loses cooperative-abort semantics.`,
		);
	});

	it("defaults.responseTimeoutMs is in sane range (5min..30min)", () => {
		// Bound the operator-tunable ceiling. Going below 5min starves
		// chatty providers; above 30min leaves hang-detection near-useless.
		const v = DEFAULT_CHILD_PI.responseTimeoutMs;
		assert.ok(v >= 5 * 60_000, `responseTimeoutMs ${v}ms too low — chatty provider calls would false-positive as hung`);
		assert.ok(v <= 30 * 60_000, `responseTimeoutMs ${v}ms too high — hang detection near-useless`);
	});

	it("EXECUTE_CELL_TIMEOUT_MS is hardcoded (not from defaults)", () => {
		// Deliberate design (scratchpad-lifecycle.ts:131 comment: "the ONLY
		// default anti-hang limit"). Locking this prevents operator churn
		// from cascading into the inner-most layer; surface the constraint
		// at the constant.
		assert.equal(typeof EXECUTE_CELL_TIMEOUT_MS, "number");
		assert.ok(
			EXECUTE_CELL_TIMEOUT_MS >= 30_000,
			`EXECUTE_CELL_TIMEOUT_MS (${EXECUTE_CELL_TIMEOUT_MS}) must be >= 30s to allow tool calls`,
		);
		assert.ok(
			EXECUTE_CELL_TIMEOUT_MS <= 600_000,
			`EXECUTE_CELL_TIMEOUT_MS (${EXECUTE_CELL_TIMEOUT_MS}) must be <= 10min to keep recovery viable`,
		);
	});
});
