import assert from "node:assert/strict";
import test from "node:test";
import { shouldRerunFailedTask } from "../../src/runtime/recovery/recovery-recipes.ts";

/**
 * #4 (assessment): make recovery-recipes actually EXECUTE rerun_task.
 * Before #4, buildRecoveryLedger recorded `rerun_task` entries with
 * state:"planned" but nothing acted on them (decorative). shouldRerunFailedTask
 * drives the real re-queue decision in the run loop. These tests pin the
 * decision logic so a refactor cannot silently re-disable the rerun.
 */
test("shouldRerunFailedTask: maxRetriesPerTask unset → NO rerun (default-off, preserves prior behavior)", () => {
	const d = shouldRerunFailedTask({}, undefined);
	assert.equal(d.rerun, false);
	assert.equal(d.newRetryCount, 0);
	assert.match(d.reason, /not set/);
});

test("shouldRerunFailedTask: maxRetriesPerTask=0 → NO rerun (explicit off)", () => {
	const d = shouldRerunFailedTask({}, { maxRetriesPerTask: 0 });
	assert.equal(d.rerun, false);
});

test("shouldRerunFailedTask: maxRetriesPerTask=2, retryCount=0 → RERUN (1/2)", () => {
	const d = shouldRerunFailedTask({ policy: { retryCount: 0 } }, { maxRetriesPerTask: 2 });
	assert.equal(d.rerun, true);
	assert.equal(d.newRetryCount, 1);
	assert.match(d.reason, /1\/2/);
});

test("shouldRerunFailedTask: maxRetriesPerTask=2, retryCount=1 → RERUN (2/2)", () => {
	const d = shouldRerunFailedTask({ policy: { retryCount: 1 } }, { maxRetriesPerTask: 2 });
	assert.equal(d.rerun, true);
	assert.equal(d.newRetryCount, 2);
});

test("shouldRerunFailedTask: retryCount >= maxRetriesPerTask → NO rerun (budget exhausted, no infinite loop)", () => {
	const d = shouldRerunFailedTask({ policy: { retryCount: 2 } }, { maxRetriesPerTask: 2 });
	assert.equal(d.rerun, false);
	assert.match(d.reason, /exhausted|>=/);
	assert.equal(d.newRetryCount, 2); // unchanged
});

test("shouldRerunFailedTask: missing policy.retryCount defaults to 0 → first rerun allowed when maxRetries>0", () => {
	const d = shouldRerunFailedTask({}, { maxRetriesPerTask: 1 });
	assert.equal(d.rerun, true);
	assert.equal(d.newRetryCount, 1);
});
