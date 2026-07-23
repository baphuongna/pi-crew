/**
 * crew-broker-close-during-reconnect.test.ts — S4 (MEDIUM-LOW) gate test.
 *
 * Verifies that `close()` is terminal during an in-flight reconnect attempt:
 *  - Test 1: a client whose first connect attempt times out is sitting in
 *    its backoff window when close() is called. close() must:
 *      (a) cancel the in-flight backoff timer via the clearTimeoutFn seam,
 *      (b) NOT cause any further createConnection() calls even after the
 *          would-be backoff wall-clock has elapsed,
 *      (c) resolve its own promise cleanly,
 *      (d) leave the client in a state where a subsequent request() returns
 *          {ok:false, fallback:true} (either with errorCode "closed" when
 *          the backoff in-flight resolve propagates, or "fallback-sticky"
 *          for a brand-new request after _mode was set to fallback by close()).
 *
 *  - Test 2: close() called BEFORE any request() is a clean no-op teardown
 *    and sets the internal flag (verified via behavior: subsequent request()
 *    returns fallback).
 *
 * Test seam strategy: a fully-controllable FakeClock that records every
 * timer the client schedules (so the test can fire specific ones and
 * assert specific ones are cleared) plus a FakeNet that returns a
 * never-connecting socket (so attemptHello sits in its deadline timer).
 *
 * The fake clock does NOT call any real setTimeout under the hood — every
 * timer is recorded in a Map and fired manually by the test. This makes
 * the test fully deterministic and immune to the test runner's
 * --test-force-exit preemption.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { CrewBrokerClient, type CrewBrokerClientOptions } from "../../src/runtime/crew-broker-client.ts";

// ----------------------------------------------------------------------------
// FakeClock — fully controllable setTimeout/clearTimeout replacement.
// Every timer the client schedules lands in a Map keyed by an integer id.
// Tests choose which timers to fire and can assert which timers were cleared.
// ----------------------------------------------------------------------------

interface FakeTimerEntry {
	cb: () => void;
	delay: number;
	cleared: boolean;
}

interface FakeTimerHandle {
	id: number;
	cleared: boolean;
}

class FakeClock {
	private readonly timers = new Map<number, FakeTimerEntry>();
	private nextId = 0;
	/** Track every timer that was scheduled (id is its key). */
	private readonly scheduledOrder: number[] = [];
	/** Track every cancellation so the test can assert on it. */
	private readonly cancellations: number[] = [];

	get setTimeoutFn(): (cb: () => void, ms: number) => NodeJS.Timeout {
		return ((cb: () => void, ms: number) => {
			const id = this.nextId++;
			this.timers.set(id, { cb, delay: ms, cleared: false });
			this.scheduledOrder.push(id);
			return { id, cleared: false } as unknown as NodeJS.Timeout;
		}) as unknown as (cb: () => void, ms: number) => NodeJS.Timeout;
	}

	get clearTimeoutFn(): (timer: NodeJS.Timeout) => void {
		return (timer: NodeJS.Timeout) => {
			const t = timer as unknown as FakeTimerHandle;
			const entry = this.timers.get(t.id);
			if (entry && !entry.cleared) {
				entry.cleared = true;
				this.cancellations.push(t.id);
			}
		};
	}

	/** How many distinct timers have been scheduled since the clock was
	 *  constructed (cleared or not). */
	get scheduledCount(): number {
		return this.scheduledOrder.length;
	}

	/** Return the ids of every timer currently in the clock (not cleared,
	 *  not yet fired). */
	pendingIds(): number[] {
		const result: number[] = [];
		for (const [id, entry] of this.timers) {
			if (!entry.cleared) result.push(id);
		}
		return result;
	}

	/** Was timer id N explicitly cleared via clearTimeoutFn? */
	wasCleared(id: number): boolean {
		const entry = this.timers.get(id);
		if (!entry) return false;
		return entry.cleared;
	}

	/** Number of times clearTimeoutFn was invoked. */
	get cancelCount(): number {
		return this.cancellations.length;
	}

	/** Fire the timer with the given id (synchronous; tests drive the loop). */
	fire(id: number): void {
		const entry = this.timers.get(id);
		if (!entry || entry.cleared) return;
		entry.cleared = true;
		this.timers.delete(id);
		entry.cb();
	}

	/** Fire every pending timer (in scheduled order). */
	fireAll(): void {
		// Snapshot ids first because firing may schedule more timers (the
		// backoff loop schedules a new timer after each attempt fails).
		const ids = [...this.scheduledOrder].filter((id) => {
			const entry = this.timers.get(id);
			return entry !== undefined && !entry.cleared;
		});
		for (const id of ids) this.fire(id);
	}

	/** Reset for a new test (timers + counters). */
	reset(): void {
		this.timers.clear();
		this.scheduledOrder.length = 0;
		this.cancellations.length = 0;
		this.nextId = 0;
	}
}

// ----------------------------------------------------------------------------
// FakeSocket — extends EventEmitter, NEVER fires 'connect' on its own.
// Mirrors the shape used by crew-broker-client-fallback.test.ts but is
// deliberately dumber: no fireConnect helper, no fireError. The test
// drives every event explicitly via the FakeClock + FakeNet.
// ----------------------------------------------------------------------------

class FakeSocket extends EventEmitter {
	writable = true;
	destroyed = false;
	written: Buffer[] = [];

	write(chunk: Buffer | string, _enc?: unknown, cb?: (err?: Error) => void): boolean {
		const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
		this.written.push(buf);
		if (typeof cb === "function") queueMicrotask(() => cb());
		return true;
	}

	destroy(err?: Error): this {
		if (this.destroyed) return this;
		this.destroyed = true;
		this.writable = false;
		if (err) queueMicrotask(() => this.emit("error", err));
		queueMicrotask(() => this.emit("close"));
		return this;
	}

	get text(): string {
		return Buffer.concat(this.written).toString("utf8");
	}
}

// ----------------------------------------------------------------------------
// FakeNet — counts createConnection calls. createConnection always returns
// a never-connecting FakeSocket so the client's per-attempt deadline timer
// is what eventually drives attemptHello to its timeout branch.
// ----------------------------------------------------------------------------

interface FakeNet {
	netModule: { createConnection: (path: string) => FakeSocket };
	connectCount: number;
	lastSocket: FakeSocket | null;
	allSockets: FakeSocket[];
}

function makeFakeNet(): FakeNet {
	const fake: FakeNet = {
		netModule: {
			createConnection: (_path: string) => {
				fake.connectCount += 1;
				const sock = new FakeSocket();
				fake.lastSocket = sock;
				fake.allSockets.push(sock);
				return sock as unknown as ReturnType<typeof fake.netModule.createConnection>;
			},
		},
		connectCount: 0,
		lastSocket: null,
		allSockets: [],
	};
	return fake;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function makeClient(fakeNet: FakeNet, clock: FakeClock): CrewBrokerClient {
	const opts: CrewBrokerClientOptions = {
		runId: "run-close-during-reconnect",
		taskId: "task-close-during-reconnect",
		socketPath: "/tmp/pi-crew-close-during-reconnect.sock",
		token: "token-close-during-reconnect",
		netModule: fakeNet.netModule as never,
		setTimeoutFn: clock.setTimeoutFn,
		clearTimeoutFn: clock.clearTimeoutFn,
		// No jitter randomness in tests.
		jitter: () => 1,
	};
	return new CrewBrokerClient(opts);
}

/** Drain microtasks so the socket's queued 'close' event (from destroy())
 *  reaches its handler. The deadline timer's callback fires sync; destroy()
 *  is sync but the 'close' event is queued via queueMicrotask. */
async function drainMicrotasks(): Promise<void> {
	for (let i = 0; i < 20; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

test("S4: close() during reconnect cancels backoff timer and prevents further createConnection", async () => {
	const clock = new FakeClock();
	const fakeNet = makeFakeNet();
	const client = makeClient(fakeNet, clock);

	// Start a request — this triggers connectAndHello (mode is "unstarted").
	// We do NOT await the promise: it will resolve later (with "closed") after
	// close() unblocks the in-flight backoff.
	const requestPromise = client.request("ping", null);

	// Yield so the synchronous part of request() can run and reach
	// attemptHello, which schedules the per-attempt deadline timer.
	await drainMicrotasks();

	// Sanity: exactly one socket has been created, exactly one timer
	// (the deadline) is currently pending.
	assert.equal(fakeNet.connectCount, 1, "first attempt should have created exactly one socket");
	assert.equal(clock.pendingIds().length, 1, "only the per-attempt deadline should be pending");
	const deadlineTimerId = clock.pendingIds()[0]!;

	// Fire the deadline timer. attemptHello resolves with {ok:false, errorCode:'timeout'}.
	// The backoff loop then schedules its first backoff timer.
	clock.fire(deadlineTimerId);
	// The deadline callback calls sock.destroy(), which queues a 'close' event.
	// Drain so attemptHello's 'close' listener fires and finish() resolves.
	await drainMicrotasks();

	// After the deadline fires and attemptHello resolves, connectAndHello
	// should have scheduled the first backoff timer (id 1, since the deadline
	// was id 0). The deadline timer is gone from the clock; the backoff is
	// pending.
	assert.equal(clock.pendingIds().length, 1, "exactly one backoff timer should be pending");
	const backoffTimerId = clock.pendingIds()[0]!;
	assert.equal(backoffTimerId, deadlineTimerId + 1, "backoff timer should have id 1 (deadline was id 0)");
	assert.equal(clock.wasCleared(backoffTimerId), false, "backoff timer must NOT be cleared yet");
	assert.equal(clock.cancelCount, 0, "no cancellations yet");

	// Now close the client while it is in the backoff window.
	const closePromise = client.close();
	await closePromise; // must resolve cleanly (synchronously, since close() is sync in the body).

	// Assert (a): clearTimeoutFn was called with the backoff timer handle.
	assert.ok(clock.cancelCount >= 1, `clearTimeoutFn must be called at least once, got ${clock.cancelCount}`);
	assert.equal(clock.wasCleared(backoffTimerId), true, "the backoff timer (id 1) must be cleared by close()");
	// And the cancellation recorded the right id.
	assert.ok(clock.wasCleared(backoffTimerId), `cancellations should include the backoff timer id ${backoffTimerId}`);

	// Assert (c): close() promise resolved cleanly.
	// (We awaited it above; reaching here means it did.)
	assert.equal(client.mode, "fallback", "client must be in fallback mode after close()");

	// Wait long enough that any uncleared timer would have fired (none should).
	// We use a wall-clock sleep equivalent to many backoff slots.
	await new Promise<void>((resolve) => setTimeout(resolve, 50));

	// Assert (b): NO further createConnection calls happened.
	assert.equal(fakeNet.connectCount, 1, `createConnection must not be called again after close(), got ${fakeNet.connectCount}`);

	// After the close() unblocked the backoff, connectAndHello resumes and
	// observes this.closed at the top of the next loop iteration, returning
	// the typed "closed" error. The original request() promise should
	// resolve with that error.
	const requestResult = await requestPromise;
	assert.equal(requestResult.ok, false);
	if (requestResult.ok === false) {
		assert.equal(
			requestResult.errorCode,
			"closed",
			`in-flight request should resolve with "closed" errorCode, got "${requestResult.errorCode}"`,
		);
	}

	// Assert (d): a SUBSEQUENT request() returns ok:false immediately
	// (because _mode is "fallback", the request() guard returns
	// errorCode "fallback-sticky" without even consulting the netModule).
	const subsequent = await client.request("ping", null);
	assert.equal(subsequent.ok, false);
	if (subsequent.ok === false) {
		assert.equal(subsequent.fallback, true);
		assert.equal(
			subsequent.errorCode,
			"fallback-sticky",
			`subsequent request should short-circuit with "fallback-sticky", got "${subsequent.errorCode}"`,
		);
	}

	// Sanity: still no further createConnection after the subsequent request.
	assert.equal(fakeNet.connectCount, 1, "subsequent request must NOT touch netModule");

	// Final safety: drain any stray timers the clock may still hold. None
	// should fire (the backoff was cleared and no new timers were scheduled
	// after close()).
	const beforeFireCount = clock.scheduledCount;
	clock.fireAll();
	assert.equal(clock.scheduledCount, beforeFireCount, "no new timers should be scheduled after fireAll() — clock is quiescent");
});

test("S4: close() called before any request() is a clean no-op teardown", async () => {
	const clock = new FakeClock();
	const fakeNet = makeFakeNet();
	const client = makeClient(fakeNet, clock);

	// No request has been made; close() must succeed without throwing,
	// must NOT touch the net, and must leave the client in fallback mode.
	await client.close();

	assert.equal(client.mode, "fallback", "client must be in fallback mode after close()");
	assert.equal(fakeNet.connectCount, 0, "close() before any request must NOT call netModule.createConnection");
	assert.equal(clock.cancelCount, 0, "close() before any request must NOT call clearTimeoutFn");

	// A subsequent request returns the fallback-sticky short-circuit.
	const result = await client.request("ping", null);
	assert.equal(result.ok, false);
	if (result.ok === false) {
		assert.equal(result.fallback, true);
		assert.equal(result.errorCode, "fallback-sticky");
	}
	assert.equal(fakeNet.connectCount, 0, "subsequent request must still NOT call netModule.createConnection");

	// close() is terminal even for the explicit reconnect path.
	const reconnected = await client.reconnect();
	assert.equal(reconnected, false, "reconnect() after close() must remain closed");
	assert.equal(fakeNet.connectCount, 0, "reconnect() after close() must NOT call netModule.createConnection");
});
