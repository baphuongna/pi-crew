import assert from "node:assert/strict";
import test from "node:test";
import { sleep, sleepSync } from "../../../src/utils/sleep.ts";

/**
 * US-010 (2026-09-22) verify-close: the async retry paths must NOT block the
 * event loop. The audit found every async lock path already uses `await sleep`
 * (locks.ts:517/547, event-log.ts:385) and the remaining `sleepSync` sites are
 * deliberately sync-only (documented at sequence-cache.ts:270 and
 * active-run-registry.ts with the v0.9.26 starvation rationale).
 *
 * This test pins the CONTRACT that made that decision necessary: `sleep`
 * yields (timers and other I/O run during the wait) while `sleepSync` does not.
 * If a future change routes an async path through sleepSync, the difference
 * shows up here.
 */

test("US-010: sleep() yields the event loop (a pending timer fires during the wait)", async () => {
	let fired = false;
	const timer = setTimeout(() => {
		fired = true;
	}, 10);
	await sleep(60);
	clearTimeout(timer);
	assert.equal(fired, true, "a timer scheduled before sleep() must fire during it — sleep must yield");
});

test("US-010: sleep() rejects immediately when the signal is already aborted", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(() => sleep(1000, controller.signal), /aborted/);
});

test("US-010: sleepSync blocks the loop (documented contrast — why sync sites keep it)", () => {
	let fired = false;
	const timer = setTimeout(() => {
		fired = true;
	}, 5);
	// 60ms synchronous block — the timer cannot fire until the stack unwinds.
	sleepSync(60);
	const firedDuringBlock = fired;
	clearTimeout(timer);
	assert.equal(firedDuringBlock, false, "sleepSync must NOT yield (this is exactly why async paths use sleep)");
});
