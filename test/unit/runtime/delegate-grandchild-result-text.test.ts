/**
 * delegate-grandchild-result-text.test.ts — RR-023 F3 unit pin on the
 * extracted capture helper (2026-09-29 battery finding #3).
 *
 * The incident shape (run team_20260929041427_5c40c4fd7e950443, 3× gc-*):
 * the grandchild pi exited 0 but its model returned EMPTY completions, so
 * child-pi-streams produced rawFinalText = undefined, stdout = "" (display
 * lines only, none in JSON mode) and stderr = "" — delegate-spawn.ts:141
 * then relayed an empty mailbox body as ok:true, indistinguishable from a
 * relay bug. The helper now surfaces an explicit diagnostic marker for that
 * shape while leaving every non-empty path byte-identical.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ChildPiRunResult } from "../../../src/runtime/child-pi/child-pi.ts";
import { grandchildResultText } from "../../../src/runtime/delegate-spawn.ts";

/** Minimal fake (ChildPiRunResult only needs the fields the helper reads). */
function fake(result: Partial<ChildPiRunResult>): ChildPiRunResult {
	return { exitCode: 0, stdout: "", stderr: "", ...result };
}

test("incident shape: exitCode 0, rawFinalText undefined, stdout empty ⇒ explicit diagnostic marker (was: empty relay)", () => {
	const out = grandchildResultText(fake({ exitCode: 0, rawFinalText: undefined, stdout: "", stderr: "" }));
	assert.equal(out, "[grandchild exited 0 with no assistant output]");
});

test("non-empty rawFinalText passes through trimmed (DELEGATED_OK_TEAM marker survives)", () => {
	assert.equal(grandchildResultText(fake({ rawFinalText: "  DELEGATED_OK_TEAM  " })), "DELEGATED_OK_TEAM");
});

test("rawFinalText absent ⇒ stdout fallback still works", () => {
	assert.equal(grandchildResultText(fake({ stdout: " fallback text\n" })), "fallback text");
});

test("failure path unchanged: non-zero exit relays stderr", () => {
	assert.equal(grandchildResultText(fake({ exitCode: 1, stderr: "boom" })), "boom");
});

test("failure with nothing to say stays empty (marker is ok-exit-0-only)", () => {
	assert.equal(grandchildResultText(fake({ exitCode: 1 })), "");
});
