/**
 * Table-driven pin for the unpinned pure helpers of
 * src/runtime/delegate-spawn.ts (W-G/G8, V2b).
 *
 * Already pinned elsewhere:
 *  - grandchildResultText: test/unit/runtime/delegate-grandchild-result-text.test.ts
 *    (RR-023 F3, 5 tests incl. the empty-output diagnostic marker);
 *  - spawnDelegateGrandchild wiring (cwd/artifacts/depth/credentials):
 *    test/unit/runtime/broker/delegate-execution-cwd.test.ts — note its
 *    AC-2 computes the expected root VIA grandchildArtifactsRoot itself, so
 *    the path FORMULA (segment order + `nested` namespace) was never pinned.
 *
 * This suite pins:
 *  - usageTokensFromEvent (S2#3 usage roll-up — previously 0 test references):
 *    shape rejection, message.usage fallback + precedence, the four summed
 *    keys, and the skip rules for zero/negative/NaN/Infinity/non-number values;
 *  - grandchildArtifactsRoot formula: namespaced segment order
 *    .crew/artifacts/<runId>/<parentTaskId>/nested/<subId>.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { grandchildArtifactsRoot, usageTokensFromEvent } from "../../../src/runtime/delegate-spawn.ts";

// ─── usageTokensFromEvent — input-shape table ──────────────────────

test("usageTokensFromEvent: non-object / wrong-type inputs return undefined", () => {
	const rows: unknown[] = [null, undefined, "message_end", 42, true, [], [{ type: "message_end" }]];
	for (const row of rows) {
		assert.equal(usageTokensFromEvent(row), undefined, `${JSON.stringify(row)} must be unattributed`);
	}
});

test("usageTokensFromEvent: only type='message_end' records are read", () => {
	const rows: unknown[] = [{}, { type: "message_start" }, { type: "turn_end", usage: { input: 5 } }];
	for (const row of rows) {
		assert.equal(usageTokensFromEvent(row), undefined);
	}
});

test("usageTokensFromEvent: missing or non-object usage returns undefined", () => {
	const rows: unknown[] = [
		{ type: "message_end" },
		{ type: "message_end", usage: "12" },
		{ type: "message_end", usage: 12 },
		{ type: "message_end", usage: [] },
	];
	for (const row of rows) {
		assert.equal(usageTokensFromEvent(row), undefined);
	}
});

// ─── usageTokensFromEvent — fallback + precedence table ────────────

test("usageTokensFromEvent: nested message.usage is used as fallback", () => {
	const event = { type: "message_end", message: { usage: { output: 7 } } };
	assert.equal(usageTokensFromEvent(event), 7);
});

test("usageTokensFromEvent: top-level usage wins when both are present", () => {
	const event = { type: "message_end", usage: { input: 1 }, message: { usage: { input: 9, output: 9 } } };
	assert.equal(usageTokensFromEvent(event), 1);
});

test("usageTokensFromEvent: nullish top-level usage falls back to message.usage", () => {
	const event = { type: "message_end", usage: null, message: { usage: { output: 4 } } };
	assert.equal(usageTokensFromEvent(event), 4);
});

// ─── usageTokensFromEvent — sum + skip-rule table ──────────────────

test("usageTokensFromEvent: sums the four accounted keys", () => {
	const event = { type: "message_end", usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 } };
	assert.equal(usageTokensFromEvent(event), 100);
});

test("usageTokensFromEvent: subset of keys still attributes partial usage", () => {
	assert.equal(usageTokensFromEvent({ type: "message_end", usage: { input: 5 } }), 5);
	assert.equal(usageTokensFromEvent({ type: "message_end", usage: { cacheRead: 3, cacheWrite: 4 } }), 7);
});

test("usageTokensFromEvent: zero / negative / NaN / Infinity / non-number values are skipped, not summed", () => {
	// Every value invalid → no attribution at all.
	assert.equal(
		usageTokensFromEvent({
			type: "message_end",
			usage: { input: 0, output: -5, cacheRead: Number.NaN, cacheWrite: Number.POSITIVE_INFINITY },
		}),
		undefined,
	);
	// Mixed: only the valid positive finite values count.
	assert.equal(usageTokensFromEvent({ type: "message_end", usage: { input: 5, output: -3, cacheRead: 0, cacheWrite: "8" } }), 5);
});

// ─── grandchildArtifactsRoot — formula pin ─────────────────────────

test("grandchildArtifactsRoot: namespaced segment order .crew/artifacts/<runId>/<parentTaskId>/nested/<subId>", () => {
	const root = grandchildArtifactsRoot("/ws", "run_1", "task_9", "gc_2");
	// Platform-agnostic segment check: split on BOTH separators and drop roots.
	// (The previous `"/ws".split(path.sep)` expected-side broke on win32, where
	// path.sep is "\\" and the POSIX-style input never splits — CI 2026-10-03.)
	const segments = (p: string) => p.split(/[\\/]/).filter(Boolean);
	assert.deepEqual(segments(root), ["ws", ".crew", "artifacts", "run_1", "task_9", "nested", "gc_2"]);
});

test("grandchildArtifactsRoot: is task-scoped (parentTaskId), not broker- or run-flat-scoped", () => {
	const a = grandchildArtifactsRoot("/ws", "run_1", "task_a", "gc");
	const b = grandchildArtifactsRoot("/ws", "run_1", "task_b", "gc");
	assert.notEqual(a, b, "sibling parent tasks must never share an artifacts root");
	// Same parent, different subId → distinct sub-namespaces under `nested`.
	const sub1 = grandchildArtifactsRoot("/ws", "run_1", "task_a", "gc_1");
	const sub2 = grandchildArtifactsRoot("/ws", "run_1", "task_a", "gc_2");
	assert.notEqual(sub1, sub2);
	assert.ok(sub1.includes("nested"), "sub-nodes live under the 'nested' segment");
});
