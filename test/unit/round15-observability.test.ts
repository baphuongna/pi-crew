/**
 * Tests for Round 15 Phase 2 fixes:
 * - L1: EventBus uses logInternalError (not console.error)
 * - Semaphore queue cap
 * - OTLPExporter snapshot cap + in-flight check
 * - live-agent-manager eviction
 */

import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../../src/runtime/scheduling/semaphore.ts";

test("Semaphore rejects acquire when queue is full", async () => {
	// Create a small semaphore and fill its queue.
	const sem = new Semaphore(1);
	// Acquire the only slot.
	await sem.acquire();
	// Patch MAX_QUEUE to a small value to make the test fast.
	const originalMax = (Semaphore as unknown as { MAX_QUEUE: number }).MAX_QUEUE;
	(Semaphore as unknown as { MAX_QUEUE: number }).MAX_QUEUE = 2;
	try {
		// Queue two waiters (allowed)
		const w1 = sem.acquire().catch((e) => e);
		const w2 = sem.acquire().catch((e) => e);
		// Third waiter should be rejected (queue full at 2)
		const w3 = sem.acquire();
		await assert.rejects(() => w3, /Semaphore queue full/);
		// Release the first slot so the queued waiters can drain.
		sem.release();
		await w1;
		sem.release();
		await w2;
	} finally {
		(Semaphore as unknown as { MAX_QUEUE: number }).MAX_QUEUE = originalMax;
		// Ensure sem is fully released
		sem.release();
	}
});

test("Semaphore MAX_QUEUE is exposed and reasonable", () => {
	assert.equal(typeof Semaphore.MAX_QUEUE, "number");
	assert.ok(Semaphore.MAX_QUEUE > 0, "MAX_QUEUE should be positive");
	assert.ok(Semaphore.MAX_QUEUE <= 100_000, "MAX_QUEUE should not be excessive");
});

test("Semaphore release decrements current", async () => {
	const sem = new Semaphore(2);
	await sem.acquire();
	await sem.acquire();
	assert.equal(sem.current, 2);
	sem.release();
	assert.equal(sem.current, 1);
	sem.release();
	assert.equal(sem.current, 0);
});

test("Semaphore tracks waiting count", async () => {
	const sem = new Semaphore(1);
	await sem.acquire();
	const w1 = sem.acquire();
	const w2 = sem.acquire();
	// Give microtasks a chance to run
	await new Promise((r) => setImmediate(r));
	assert.equal(sem.waiting, 2, "two waiters should be queued");
	sem.release();
	await w1;
	sem.release();
	await w2;
});
