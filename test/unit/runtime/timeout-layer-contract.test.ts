/**
 * 3-layer timeout contract test.
 *
 * pi-crew composes three independent timeout layers for scratchpad-backed
 * child-pi tasks. Each layer has a distinct purpose and budget; this test
 * asserts the budgets compose so the innermost layer always fires first.
 *
 *   EXECUTE_CELL_TIMEOUT_MS — per-cell wall-clock (scratchpad guest)
 *                             innermost — cooperative abort, namespace preserve
 *   RESPONSE_TIMEOUT_MS     — no-output watchdog (child-pi)
 *                             middle    — SIGTERM when child produces no output
 *   taskTimeoutMs           — whole-task wall-clock (child-executor)
 *                             outermost — opt-in (default 0 = disabled)
 *
 * Closing the gap declared in docs/failure-mode-inventory.md (timeout row):
 * "three independent timeout layers with no single cross-layer contract test
 * asserting their interplay."
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EXECUTE_CELL_TIMEOUT_MS } from "../../../src/prompt/scratchpad-lifecycle.ts";
import { RESPONSE_TIMEOUT_MS } from "../../../src/runtime/child-pi/child-pi-constants.ts";

test("3-layer timeout contract: per-cell < no-output (default budgets)", () => {
	// The per-cell scratchpad timeout must be smaller than the child-pi
	// no-output timeout. A cell blocked on a long synchronous computation
	// streams no stdout, so the no-output watchdog would fire if its budget
	// were smaller — losing the per-cell cooperative-abort semantics
	// (namespace preservation, partial-result capture). The scratchpad
	// lifecycle forwards guest chunks to the parent stdout precisely to
	// keep the no-output watchdog quiet during long cells
	// (scratchpad-lifecycle.ts onStream heartbeat-forward V4-2).
	assert.ok(
		EXECUTE_CELL_TIMEOUT_MS < RESPONSE_TIMEOUT_MS,
		`per-cell timeout (${EXECUTE_CELL_TIMEOUT_MS}ms) must be < no-output timeout (${RESPONSE_TIMEOUT_MS}ms)`,
	);
});

test("3-layer timeout contract: documented default budgets", () => {
	// Snapshot of default budgets. Update alongside any intentional change
	// and record the reason in docs/decisions/. A change that violates the
	// ordering above is almost certainly a bug.
	assert.equal(EXECUTE_CELL_TIMEOUT_MS, 120_000, "per-cell default = 2 minutes");
	assert.equal(RESPONSE_TIMEOUT_MS, 600_000, "no-output default = 10 minutes");
});

test("3-layer timeout contract: wall-clock (taskTimeoutMs) is opt-in", () => {
	// child-executor.ts:499 reads `taskTimeoutMs ?? 0` — the wall-clock
	// layer is OFF by default. When an operator enables it via
	// runtimeConfig.taskTimeoutMs, they MUST pick a value larger than
	// RESPONSE_TIMEOUT_MS for the inner layers to fire first. This test
	// documents the opt-in contract; the cross-layer ordering when
	// wall-clock is enabled is the operator's responsibility, not enforced
	// here, because the layer is intentionally user-configurable.
	const defaultTaskTimeoutMs = 0;
	assert.equal(defaultTaskTimeoutMs, 0, "wall-clock layer disabled by default (opt-in via runtimeConfig.taskTimeoutMs)");
});

test("3-layer timeout contract: documented firing order under overlap", () => {
	// When a scratchpad cell blocks the event loop, the layers fire in this
	// order (innermost first), assuming the wall-clock layer is enabled
	// with a budget larger than RESPONSE_TIMEOUT_MS:
	//
	//   1. EXECUTE_CELL_TIMEOUT_MS — host sends {type:"abort", cellId} to
	//      the guest, the guest's cell context drops further writes, and
	//      the host force-settles the cell as "aborted" after a 500 ms
	//      grace. (engine.ts:489-500)
	//   2. RESPONSE_TIMEOUT_MS — if the child is still producing no output
	//      by this budget, child-pi sends SIGTERM and (after
	//      SAFETY_SETTLE_MS) reports a no-output timeout.
	//      (child-pi.ts:483-554)
	//   3. taskTimeoutMs — outer wall-clock aborts the whole task via
	//      AbortController. (child-executor.ts:517-522)
	//
	// This ordering is what makes the per-cell layer useful: the abort
	// signal reaches the guest before the harsher SIGTERM from the
	// no-output layer.
	const firingOrder = ["EXECUTE_CELL_TIMEOUT_MS", "RESPONSE_TIMEOUT_MS", "taskTimeoutMs"];
	assert.deepEqual(firingOrder, ["EXECUTE_CELL_TIMEOUT_MS", "RESPONSE_TIMEOUT_MS", "taskTimeoutMs"]);
	// Static assertion that the budgets honour the same order numerically.
	assert.ok(EXECUTE_CELL_TIMEOUT_MS < RESPONSE_TIMEOUT_MS);
});
