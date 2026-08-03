/**
 * Unit tests for global-worker-cap.ts (P1g).
 *
 * RFC: research-findings/goal-workflow/13-VISION-RFC.md v0.5 §P1g + MAJ#3.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
	__test_resetCap,
	acquireWorkerSlot,
	getWorkerCapCapacity,
	releaseWorkerSlot,
	withWorkerSlot,
} from "../../../../src/runtime/scheduling/global-worker-cap.ts";

describe("global-worker-cap capacity resolution", () => {
	it("getWorkerCapCapacity returns the resolved capacity", () => {
		const cap = getWorkerCapCapacity();
		// Default is max(2, os.cpus()-2); both forms are ≥ 2.
		assert.ok(cap >= 2, `capacity should be ≥ 2, got ${cap}`);
	});

	it("__test_resetCap reinitializes the cap to a specific capacity", () => {
		__test_resetCap(2);
		assert.equal(getWorkerCapCapacity(), 2);
	});
});

describe("global-worker-cap acquire/release (capacity 2)", () => {
	beforeEach(() => {
		// Deterministic capacity for every test (capacity 2 → 3rd acquire must await).
		__test_resetCap(2);
	});

	it("allows up to 2 concurrent acquires without blocking", async () => {
		await acquireWorkerSlot();
		await acquireWorkerSlot();
		// Both acquired synchronously (no throw). A 3rd would block — tested next.
		releaseWorkerSlot();
		releaseWorkerSlot();
	});

	it("blocks the 3rd acquire until a slot is released (cap=2)", async () => {
		await acquireWorkerSlot();
		await acquireWorkerSlot();

		let thirdResolved = false;
		const third = acquireWorkerSlot().then(() => {
			thirdResolved = true;
		});
		// Give microtasks/timers a tick — the 3rd must still be pending.
		await new Promise((r) => setTimeout(r, 10));
		assert.equal(thirdResolved, false, "3rd acquire must block while 2 slots are held");

		releaseWorkerSlot(); // free one slot
		await third;
		assert.equal(thirdResolved, true, "3rd acquire resolves after a release");
		releaseWorkerSlot();
		releaseWorkerSlot();
	});

	it("acquires are released in FIFO order (fairness)", async () => {
		// Fill both slots.
		await acquireWorkerSlot();
		await acquireWorkerSlot();

		const order: string[] = [];
		const a = acquireWorkerSlot().then(() => order.push("a"));
		const b = acquireWorkerSlot().then(() => order.push("b"));
		await new Promise((r) => setTimeout(r, 5));
		releaseWorkerSlot(); // hands slot to a
		await a;
		releaseWorkerSlot(); // hands slot to b
		await b;
		assert.deepEqual(order, ["a", "b"], "waiters resolve in arrival order");
		releaseWorkerSlot();
		releaseWorkerSlot();
	});
});

describe("withWorkerSlot", () => {
	beforeEach(() => {
		__test_resetCap(1);
	});

	it("returns the fn result and releases the slot", async () => {
		const result = await withWorkerSlot(async () => 42);
		assert.equal(result, 42);
		// Slot was released → a fresh acquire must not block.
		let resolved = false;
		await acquireWorkerSlot().then(() => {
			resolved = true;
		});
		assert.equal(resolved, true);
		releaseWorkerSlot();
	});

	it("releases the slot when fn throws (no leak → no deadlock)", async () => {
		await assert.rejects(
			() =>
				withWorkerSlot(async () => {
					throw new Error("boom");
				}),
			/boom/,
		);
		// If the slot leaked, this acquire would hang forever. Wrap in a timeout
		// to turn a deadlock into a definite failure rather than a hung process.
		let resolved = false;
		const probe = acquireWorkerSlot().then(() => {
			resolved = true;
		});
		const raced = await Promise.race([probe.then(() => "acquired"), new Promise<string>((r) => setTimeout(() => r("timeout"), 500))]);
		assert.equal(raced, "acquired", "slot must be released after withWorkerSlot throws");
		assert.equal(resolved, true);
		releaseWorkerSlot();
	});
});
