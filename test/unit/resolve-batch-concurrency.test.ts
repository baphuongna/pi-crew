/**
 * P1-7 regression guard: the scheduler must consult the global worker cap.
 *
 * Before the fix, `resolveBatchConcurrency` used `Math.min(requested, hardCap)`
 * and never consulted the worker cap, so on a 4-core machine (global cap = 2)
 * the scheduler dispatched 4 while the semaphore held 2 — building worktrees +
 * reporting agents `running` for tasks that merely queued.
 *
 * resolveBatchConcurrency accepts an optional `workerCap` override (defaulting to
 * getWorkerCapCapacity()) so this test is deterministic without mutating the
 * global singleton.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBatchConcurrency } from "../../src/runtime/concurrency.ts";

test("resolveBatchConcurrency: clamps to the worker cap when it is the binding constraint", () => {
	// Workflow requests 4, hardCap 8, worker cap 2 → must be 2 (was 4 before).
	const decision = resolveBatchConcurrency({
		workflowName: "implementation",
		workflowMaxConcurrency: 4,
		hardCap: 8,
		workerCap: 2,
		readyCount: 4,
	});
	assert.equal(decision.maxConcurrent, 2, "worker cap must bind");
	assert.equal(decision.selectedCount, 2);
	assert.match(decision.reason ?? "", /worker=2/, "reason records the worker cap");
});

test("resolveBatchConcurrency: hardCap still binds when smaller than worker cap", () => {
	const decision = resolveBatchConcurrency({
		workflowName: "default",
		workflowMaxConcurrency: 6,
		hardCap: 3,
		workerCap: 8,
		readyCount: 6,
	});
	assert.equal(decision.maxConcurrent, 3, "hardCap binds when smaller");
	assert.match(decision.reason ?? "", /hard=3/);
});

test("resolveBatchConcurrency: allowUnboundedConcurrency bypasses both caps", () => {
	const decision = resolveBatchConcurrency({
		workflowName: "default",
		workflowMaxConcurrency: 4,
		hardCap: 8,
		workerCap: 2,
		readyCount: 4,
		allowUnboundedConcurrency: true,
	});
	assert.equal(decision.maxConcurrent, 4, "unbounded bypasses hardCap AND worker cap");
});
