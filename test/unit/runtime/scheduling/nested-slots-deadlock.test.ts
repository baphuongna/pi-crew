/**
 * Nested-slot budget anti-deadlock tests (ADR-5 §2, WP-5 step 3).
 *
 * The scenario the design pins: a 4-core box runs a 4-worker team — all four
 * global semaphore slots are held by WAITING parent workers. Two of them
 * delegate. If grandchildren rode the global semaphore (design rev-1), those
 * spawns would starve forever = permanent deadlock (the exact shape recorded
 * at scheduling/global-worker-cap.ts:14-19 MAJ#3). With the SEPARATE nested
 * budget (max(1, floor(globalSem/2)) = 2 on a sem-4 box), both delegates run
 * concurrently and complete. A third delegate is rejected IMMEDIATELY —
 * fail-fast, never queue.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { NestedSlotBudget, defaultNestedSlotBudget } from "../../../../src/runtime/scheduling/nested-slots.ts";

test("default budget: max(1, floor(globalSem/2)) across semaphore sizes", () => {
	assert.equal(defaultNestedSlotBudget(4), 2, "sem-4 → 2 nested slots (4-core box)");
	assert.equal(defaultNestedSlotBudget(8), 4);
	assert.equal(defaultNestedSlotBudget(2), 1);
	assert.equal(defaultNestedSlotBudget(1), 1, "sem-1 clamps up to 1 (never 0)");
	assert.equal(defaultNestedSlotBudget(3), 1, "floor(3/2)=1");
	assert.equal(defaultNestedSlotBudget(0), 1, "degenerate sem-0 still clamps to 1");
});

test("anti-deadlock: 4 parents hold ALL global slots; 2 delegates still run and complete", () => {
	const globalSem = 4;
	const budget = new NestedSlotBudget(globalSem);
	assert.equal(budget.max, 2);

	// All global slots held by waiting parents — irrelevant to the nested budget.
	const d1 = budget.tryAcquire("nested-01");
	const d2 = budget.tryAcquire("nested-02");
	assert.equal(d1, true, "first delegate acquires a nested slot");
	assert.equal(d2, true, "second delegate acquires a nested slot (would DEADLOCK on the global sem)");

	// Both grandchildren complete; slots are released (no queueing ever happened).
	budget.release("nested-01");
	budget.release("nested-02");
	assert.equal(budget.used, 0);
});

test("exhaustion: third delegate on a full budget is rejected IMMEDIATELY, never queued", () => {
	const budget = new NestedSlotBudget(4);
	assert.equal(budget.tryAcquire("n1"), true);
	assert.equal(budget.tryAcquire("n2"), true);
	assert.equal(budget.tryAcquire("n3"), false, "must fail-fast — no waiting, no queue");
	assert.equal(budget.used, 2);
	assert.equal(budget.statusLine, "2/2 in flight");

	// Slot freed → next delegate admitted (the fail-fast message stays honest).
	budget.release("n1");
	assert.equal(budget.tryAcquire("n3"), true);
	assert.equal(budget.statusLine, "2/2 in flight");
});

test("config override: nesting.maxSlots replaces the derived default; invalid throws at construction", () => {
	assert.equal(new NestedSlotBudget(16, 4).max, 4);
	assert.equal(new NestedSlotBudget(2, 8).max, 8, "override may exceed the derived default");
	assert.throws(() => new NestedSlotBudget(4, 0), /nesting\.maxSlots must be a positive integer/);
	assert.throws(() => new NestedSlotBudget(4, Number.NaN), /nesting\.maxSlots must be a positive integer/);
});

test("release is idempotent; re-acquire of a held id is idempotent", () => {
	const budget = new NestedSlotBudget(2);
	assert.equal(budget.tryAcquire("n1"), true);
	assert.equal(budget.tryAcquire("n1"), true, "same id re-acquire does not consume a second slot");
	assert.equal(budget.used, 1);
	budget.release("n1");
	budget.release("n1");
	assert.equal(budget.used, 0);
});
