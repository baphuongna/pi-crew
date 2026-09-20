/**
 * RR-014 (F15) — Semaphore.acquire(signal) abort semantics.
 *
 * Defect (verified, docs/archive/2026-09-17-pi-crew-review-verification.md
 * §F15): acquire() took NO AbortSignal — a queued waiter could only settle
 * when a slot was RELEASED. Probe: cap=1, A holds the slot, B aborts at
 * +20ms → at +300ms B had NOT settled; it settled only when A released at
 * +300ms, and acquire() returned with signal.aborted === true (a slot
 * granted to an already-cancelled task).
 *
 * These tests are written RED-first against the FIXED contract
 * (docs/stories/RR-014/overview.md AC-1..AC-7 + AC-11):
 *   AC-1  aborted waiter settles promptly (deadline-bounded, no release needed)
 *   AC-2  aborted acquire REJECTS with a distinguishable error (no bare resolve)
 *   AC-3  aborted waiter is removed from the queue (waiting decreases)
 *   AC-4  current never increments for an aborted acquire; current <= max
 *   AC-5  release() hands the slot to the next ALIVE waiter (aborted waiter
 *         must not burn the slot)
 *   AC-6  no abort-listener leak (every waiter detaches on settle)
 *   AC-7  abort↔handoff race: both interleavings end in exactly one
 *         consistent state (no double-count, no lost slot)
 *   AC-11 acquire() with no signal keeps its exact previous semantics
 *
 * Plus the capacity-leak regression from the task packet: N aborted waiters
 * must not change capacity accounting (N+1 sequential acquires succeed).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Semaphore } from "../../../../src/runtime/scheduling/semaphore.ts";

/** Fail fast with a clear message instead of hanging when capacity leaks. */
async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Explicitly observe-and-drop a rejection (avoids empty catch blocks). */
const swallow = (): undefined => undefined;

describe("Semaphore.acquire(signal) — waiter abort (RR-014 F15)", () => {
	it("AC-1/AC-2/AC-3/AC-4: queued waiter settles PROMPTLY on abort — rejects, leaves the queue, takes no slot", async () => {
		const s = new Semaphore(1);
		await s.acquire(); // A holds the only slot

		const controller = new AbortController();
		let settledWith: "resolved" | "rejected" | undefined;
		const b = s.acquire(controller.signal).then(
			() => {
				settledWith = "resolved";
			},
			() => {
				settledWith = "rejected";
			},
		);
		assert.equal(s.waiting, 1, "B must be queued while A holds the only slot");

		// Abort at ~20ms (the verification probe's timing). B must settle
		// WITHOUT A releasing — deadline 100ms per AC-1.
		setTimeout(() => controller.abort(), 20);
		await withDeadline(b, 100, "aborted waiter must settle within 100ms (A never released)");

		assert.equal(settledWith, "rejected", "AC-2: aborted acquire must REJECT, not bare-resolve");
		assert.equal(s.waiting, 0, "AC-3: aborted waiter must be removed from the queue");
		assert.equal(s.current, 1, "AC-4: aborted acquire must not increment current (A still holds the slot)");

		// A's release restores capacity to a clean 1-slot semaphore.
		s.release();
		assert.equal(s.current, 0);
		assert.equal(s.waiting, 0);
	});

	it("AC-2: acquire with an already-aborted signal rejects immediately without taking a slot", async () => {
		const s = new Semaphore(2);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			() => s.acquire(controller.signal),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(`${error.name} ${error.message}`, /abort/i);
				return true;
			},
			"already-aborted acquire must reject with a distinguishable abort error",
		);
		assert.equal(s.current, 0, "fail-closed entry must not consume a slot");
		assert.equal(s.waiting, 0, "fail-closed entry must not enqueue");
	});

	it("AC-3: abort eagerly removes the waiter from the queue (synchronous queue update)", async () => {
		const s = new Semaphore(1);
		await s.acquire();
		const c1 = new AbortController();
		const c2 = new AbortController();
		s.acquire(c1.signal).catch(swallow);
		s.acquire(c2.signal).catch(swallow);
		assert.equal(s.waiting, 2);

		c1.abort();
		assert.equal(s.waiting, 1, "first abort must synchronously dequeue its waiter");
		c2.abort();
		assert.equal(s.waiting, 0, "second abort must synchronously dequeue its waiter");
		assert.equal(s.current, 1, "holders are unaffected by waiter aborts");
		s.release();
		assert.equal(s.current, 0);
	});

	it("AC-5: release hands the slot to the next ALIVE waiter — an aborted waiter must not burn the slot", async () => {
		const s = new Semaphore(1);
		await s.acquire(); // A
		const cB = new AbortController();
		const b = s.acquire(cB.signal).catch(swallow);
		const c = s.acquire(); // C: no signal, stays alive behind B
		assert.equal(s.waiting, 2);

		cB.abort(); // B dies while queued in front of C
		await b;
		assert.equal(s.waiting, 1, "only C must remain queued");

		s.release(); // A releases → the slot must reach C, not burn on dead B
		await withDeadline(c, 100, "alive waiter C must acquire after A releases");
		assert.equal(s.waiting, 0);
		assert.equal(s.current, 1, "handoff transfers the slot (current stays at the holder count)");
		s.release();
		assert.equal(s.current, 0);
	});

	it("AC-6: no abort-listener leak — N waiters on ONE signal all detach after settle", async () => {
		const s = new Semaphore(1);
		await s.acquire();
		const controller = new AbortController();
		const addCalls: string[] = [];
		const removeCalls: string[] = [];
		const origAdd = controller.signal.addEventListener.bind(controller.signal) as unknown as EventTarget["addEventListener"];
		const origRemove = controller.signal.removeEventListener.bind(controller.signal) as unknown as EventTarget["removeEventListener"];
		const target = controller.signal as unknown as {
			addEventListener: EventTarget["addEventListener"];
			removeEventListener: EventTarget["removeEventListener"];
		};
		target.addEventListener = (type, listener, options) => {
			addCalls.push(type);
			return origAdd(type, listener, options);
		};
		target.removeEventListener = (type, listener, options) => {
			removeCalls.push(type);
			return origRemove(type, listener, options);
		};

		const N = 50;
		const waiters: Promise<void>[] = [];
		for (let i = 0; i < N; i++) {
			waiters.push(s.acquire(controller.signal).catch(swallow));
		}
		assert.equal(s.waiting, N);

		controller.abort();
		await Promise.all(waiters.map((p) => p.catch(swallow)));

		assert.equal(addCalls.length, N, "every signalled waiter attaches exactly one abort listener");
		assert.equal(removeCalls.length, N, "every waiter detaches its listener on settle (granted OR aborted)");
		assert.equal(s.waiting, 0);
		assert.equal(s.current, 1);
		s.release();
	});

	it("AC-7: abort↔handoff race — both interleavings end in exactly one consistent state", async () => {
		const ROUNDS = 200;
		for (let i = 0; i < ROUNDS; i++) {
			const s = new Semaphore(1);
			await s.acquire(); // holder A

			const controller = new AbortController();
			let outcome: "resolved" | "rejected" | undefined;
			const b = s.acquire(controller.signal).then(
				() => {
					outcome = "resolved";
				},
				() => {
					outcome = "rejected";
				},
			);

			if (i % 2 === 0) {
				// Interleaving (a): abort fires while B is still queued.
				controller.abort();
				s.release();
			} else {
				// Interleaving (b): release hands B the slot in the same
				// instant-window as the abort.
				s.release();
				controller.abort();
			}
			await withDeadline(b, 500, `round ${i}: waiter must settle regardless of race outcome`);

			assert.ok(s.current <= 1, `round ${i}: current must never exceed max`);
			assert.equal(s.waiting, 0, `round ${i}: queue must drain`);
			if (outcome === "rejected") {
				// State (a): abort won — B consumed nothing; A's release
				// decremented the counter back to a free semaphore.
				assert.equal(s.current, 0, `round ${i}: rejected waiter must leave capacity free`);
			} else {
				// State (b): grant won — B owns the slot; the caller sees
				// signal.aborted and releases (in production, runChildPi's
				// pre-spawn guard returns kind "aborted" and withWorkerSlot's
				// finally releases within a microtask — modeled here).
				assert.ok(controller.signal.aborted, `round ${i}: resolved race winner must be the granted-then-aborted case`);
				s.release();
				assert.equal(s.current, 0, `round ${i}: post-release capacity must be restored`);
			}
		}
	});

	it("AC-11: acquire() with no signal keeps its exact previous semantics", async () => {
		const s = new Semaphore(1);
		await s.acquire();
		assert.equal(s.current, 1);

		let second = false;
		const p = s.acquire().then(() => {
			second = true;
		});
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(second, false, "no-signal acquire must still block while the slot is held");
		s.release();
		await p;
		assert.equal(second, true, "no-signal acquire must still resolve on release");
		assert.equal(s.current, 1, "handoff keeps current at the holder count");
		s.release();
		assert.equal(s.current, 0);
	});

	it("capacity accounting: N aborted waiters do not change capacity (N+1 sequential acquires all succeed)", async () => {
		const N = 8;
		const s = new Semaphore(2);
		await s.acquire();
		await s.acquire(); // both slots held; current === 2

		const controllers = Array.from({ length: N }, () => new AbortController());
		const waiters = controllers.map((c) => s.acquire(c.signal).catch(swallow));
		assert.equal(s.waiting, N);

		for (const c of controllers) c.abort();
		await Promise.all(waiters.map((p) => p.catch(swallow)));
		assert.equal(s.waiting, 0, "all aborted waiters must be gone");
		assert.equal(s.current, 2, "holders are unaffected by waiter aborts");

		s.release();
		s.release();
		assert.equal(s.current, 0);

		// N+1 sequential acquire/release cycles: every acquire must get a
		// slot IMMEDIATELY (no leak → no queueing; no phantom slot → no skip).
		for (let i = 0; i < N + 1; i++) {
			await withDeadline(s.acquire(), 250, `sequential acquire #${i} after N aborts`);
			assert.equal(s.current, 1, `acquire #${i} must take a slot`);
			assert.equal(s.waiting, 0, `acquire #${i} must not have queued`);
			s.release();
			assert.equal(s.current, 0);
		}

		// The cap still ENFORCES after all the abort churn: 3rd acquire queues.
		await s.acquire();
		await s.acquire();
		let third = false;
		const p = s.acquire().then(() => {
			third = true;
		});
		await new Promise((r) => setTimeout(r, 5));
		assert.equal(third, false);
		assert.equal(s.waiting, 1);
		s.release();
		await p;
		assert.equal(third, true);
		s.release();
		s.release();
		assert.equal(s.current, 0);
		assert.equal(s.waiting, 0);
	});
});
