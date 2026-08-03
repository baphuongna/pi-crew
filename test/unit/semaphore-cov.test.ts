import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Semaphore } from "../../src/runtime/scheduling/semaphore.ts";

describe("Semaphore constructor", () => {
	it("clamps max to at least 1", () => {
		const s = new Semaphore(0);
		// Acquire should succeed immediately (max was clamped to 1)
		let resolved = false;
		s.acquire().then(() => {
			resolved = true;
		});
		// Synchronous check — acquire resolves immediately since current < max
		assert.strictEqual(s.current, 1);
	});

	it("accepts positive max values", () => {
		const s = new Semaphore(5);
		assert.strictEqual(s.current, 0);
		assert.strictEqual(s.waiting, 0);
	});
});

describe("Semaphore acquire/release", () => {
	it("allows up to max concurrent acquires", async () => {
		const s = new Semaphore(3);
		await s.acquire();
		await s.acquire();
		await s.acquire();
		assert.strictEqual(s.current, 3);
	});

	it("queues acquires beyond max", async () => {
		const s = new Semaphore(1);
		await s.acquire();
		assert.strictEqual(s.current, 1);

		let secondResolved = false;
		const p = s.acquire().then(() => {
			secondResolved = true;
		});
		// Give microtask queue a tick
		await new Promise((r) => setTimeout(r, 0));
		assert.strictEqual(secondResolved, false);
		assert.strictEqual(s.waiting, 1); // resolve fn is in the queue

		s.release();
		await p;
		assert.strictEqual(secondResolved, true);
	});

	it("releases slot and unblocks waiter", async () => {
		const s = new Semaphore(1);
		await s.acquire();

		const order: number[] = [];
		const p = s.acquire().then(() => order.push(2));
		order.push(1);
		s.release();
		await p;
		assert.deepStrictEqual(order, [1, 2]);
	});

	it("over-release is a no-op", () => {
		const s = new Semaphore(2);
		s.release(); // should not throw
		assert.strictEqual(s.current, 0);
	});
});

describe("Semaphore MAX_QUEUE", () => {
	it("has static MAX_QUEUE constant", () => {
		assert.strictEqual(Semaphore.MAX_QUEUE, 10_000);
	});

	it("rejects acquire when queue is full", async () => {
		const s = new Semaphore(1);
		await s.acquire();

		// Fill the queue to MAX_QUEUE
		const waiters: Promise<void>[] = [];
		for (let i = 0; i < Semaphore.MAX_QUEUE; i++) {
			waiters.push(s.acquire());
		}
		assert.strictEqual(s.waiting, Semaphore.MAX_QUEUE);

		// The next acquire should throw because the queue is full
		await assert.rejects(() => s.acquire(), /queue full/);
	});

	it("reports waiting count correctly", async () => {
		const s = new Semaphore(1);
		await s.acquire();

		// Queue 3 waiters
		for (let i = 0; i < 3; i++) {
			s.acquire(); // don't await — they'll be queued
		}
		// Queue is drained by release, but pending acquires are in #queue
		assert.strictEqual(s.waiting, 3);
	});
});

describe("Semaphore getters", () => {
	it("current starts at 0", () => {
		const s = new Semaphore(2);
		assert.strictEqual(s.current, 0);
	});

	it("waiting starts at 0", () => {
		const s = new Semaphore(2);
		assert.strictEqual(s.waiting, 0);
	});

	it("current increments on acquire", async () => {
		const s = new Semaphore(5);
		await s.acquire();
		await s.acquire();
		assert.strictEqual(s.current, 2);
	});

	it("current decrements on release when no waiters", async () => {
		const s = new Semaphore(5);
		await s.acquire();
		assert.strictEqual(s.current, 1);
		s.release();
		assert.strictEqual(s.current, 0);
	});
});
