/**
 * NEW-2 (SDD-4 follow-up, P3 review MAJOR 1) — stale-reconcile notify DEDUPE
 * (unit pins for `decideStaleReconcileNotification`).
 *
 * NOT red-first — structurally impossible, by design:
 *   - `mock.module` is banned by repo convention (experimental, needs
 *     --experimental-test-module-mocks; see stringenum-fallback-composition.test.ts).
 *   - The REAL feed cannot deterministically repeat a repaired verdict: a real
 *     repair persists a terminal run status, so the run drops out of the
 *     reconcile input and never re-notifies. The repeat window only opens when
 *     persistence FAILS (disk error / lock steal) while the notify already
 *     fired, or when session reload/fork re-fires session_start in-process.
 * The dishonest-notify BUG itself is red-first pinned in
 * stale-reconcile-notify-honesty.test.ts (verdicts with repaired:false used to
 * claim "Found and repaired ghost runs"). End-to-end no-repeat evidence comes
 * from the live battery probe: cold sessions 2..3 after a repaired orphan stay
 * silent.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	__test__resetNotifiedRepairedRunIds,
	decideStaleReconcileNotification,
	type StaleReconcileNotifyPlan,
} from "../../../../src/extension/registration/lifecycle-handlers.ts";
import type { ReconcileResult } from "../../../../src/runtime/stale-reconciler.ts";

function result(runId: string, repaired: boolean, verdict: ReconcileResult["verdict"] = "pid_dead"): ReconcileResult {
	return { runId, verdict, repaired, detail: "fixture" };
}

test.beforeEach(() => {
	__test__resetNotifiedRepairedRunIds();
});

test("NEW-2 (c): the same repaired runId is notified exactly once (dedupe across repeated session starts)", () => {
	const first = decideStaleReconcileNotification([result("run-dedupe-probe", true)]);
	assert.ok(first, "first repaired verdict must notify");
	assert.match(first.title, /^Repaired 1 stale run\(s\)$/);
	assert.ok(first.body.includes("run-dedupe-probe"), `body must name the repaired run: ${first.body}`);

	// Session reload/fork re-fires session_start; the (un-persisted) same
	// repaired verdict must NOT re-notify.
	const second: StaleReconcileNotifyPlan | null = decideStaleReconcileNotification([result("run-dedupe-probe", true)]);
	assert.equal(second, null, "the same repaired runId must not re-notify within the process");
	const third = decideStaleReconcileNotification([result("run-dedupe-probe", true)]);
	assert.equal(third, null, "…nor on a third session start (observed live: 3x/runId spam on 2026-09-29)");
});

test("NEW-2 (c): a different repaired runId still notifies after a dedupe hit", () => {
	assert.ok(decideStaleReconcileNotification([result("run-a", true)]));
	assert.equal(decideStaleReconcileNotification([result("run-a", true)]), null, "run-a deduped");
	const next = decideStaleReconcileNotification([result("run-b", true)]);
	assert.ok(next, "a distinct repaired runId is NOT deduped");
	assert.match(next.title, /^Repaired 1 stale run\(s\)$/);
	assert.ok(next.body.includes("run-b") && !next.body.includes("run-a"), `body names only the new repair: ${next.body}`);
});

test("NEW-2 (c): mixed batch reports only the not-yet-notified repaired runs", () => {
	assert.ok(decideStaleReconcileNotification([result("run-a", true)]));
	const mixed = decideStaleReconcileNotification([
		result("run-a", true), // deduped
		result("run-blocked", false, "blocked_awaiting_approval"), // never eligible
		result("run-b", true), // new repair
	]);
	assert.ok(mixed, "mixed batch with a fresh repair must notify");
	assert.match(mixed.title, /^Repaired 1 stale run\(s\)$/, "count only the newly-repaired run");
	assert.ok(mixed.body.includes("run-b"), `body names the repaired run: ${mixed.body}`);
	assert.ok(!mixed.body.includes("run-blocked"), `non-repaired verdict must never appear: ${mixed.body}`);
	assert.ok(!mixed.body.includes("run-a"), `already-notified run must not repeat: ${mixed.body}`);
});

test("NEW-2 (b) unit: non-repaired-only batches never notify", () => {
	assert.equal(decideStaleReconcileNotification([]), null, "empty batch: silent");
	assert.equal(
		decideStaleReconcileNotification([result("run-blocked", false, "blocked_awaiting_approval")]),
		null,
		"blocked_awaiting_approval (repaired:false): silent",
	);
	assert.equal(
		decideStaleReconcileNotification([result("run-exists", false, "result_exists")]),
		null,
		"result_exists (repaired:false): silent",
	);
	assert.equal(decideStaleReconcileNotification([result("run-wait", false, "waiting_answer")]), null, "waiting_answer: silent");
});
