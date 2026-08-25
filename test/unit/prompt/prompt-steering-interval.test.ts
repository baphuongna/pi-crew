/**
 * Tests for PERF R2 task 5 fix round 1: the steering/ask/delegate file-poll
 * cadence is adaptive and gated SOLELY on live-session realtime.
 *
 * The pure decision helper under test lives in src/prompt/prompt-runtime.ts:
 *   - `effectiveSteeringInterval(realtimeActive)` returns the short 50ms
 *     cadence while live-session realtime listeners are registered, and
 *     relaxes back to the prior 500ms bounded-cost cadence otherwise.
 *
 * There is deliberately NO in-flight branch: the ask/delegate loops are
 * in-flight for their whole duration, so keying the short cadence off it would
 * force 50ms polling on NON-realtime workers where the file-poll is the SOLE
 * durability path (10x amplification). The realtime flag alone is the gate.
 *
 * The three poll sites (ask loop, delegate loop, mailbox steering poll) all
 * consult this helper; the broker-push path (Feature 2b) is unchanged.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { effectiveSteeringInterval } from "../../../src/prompt/prompt-runtime.ts";
import {
	clearLiveControlRealtimeForTest,
	hasLiveControlRealtimeListeners,
	subscribeLiveControlRealtime,
} from "../../../src/runtime/live-session/live-control-realtime.ts";

test("PERF-R2/T5: realtime-active → effective interval is 50ms", () => {
	assert.equal(effectiveSteeringInterval(true), 50);
});

test("PERF-R2/T5: realtime-inactive (idle non-live worker) → interval relaxes to 500ms", () => {
	assert.equal(effectiveSteeringInterval(false), 500);
});

test("PERF-R2/T5: realtime flag drives an end-to-end adaptive poll cadence (50ms → relax to 500ms)", async () => {
	// Drive a real recursive setTimeout poll harness re-armed through the SAME
	// decision the steering poll uses: hasLiveControlRealtimeListeners() →
	// effectiveSteeringInterval(). While a realtime subscription is live the
	// poll ticks at ~50ms; after the subscription drops the next re-arm uses
	// the 500ms cadence — the "relax to 500ms" transition is REAL poll
	// behavior, not pure helper arithmetic.
	clearLiveControlRealtimeForTest();
	const tickTimes: number[] = [];
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let finished = false;

	// Mirror of prompt-runtime's armSteeringPoll: re-arm through the live
	// realtime signal. `immediate` clears any pending short-cadence arm —
	// prompt-runtime does the analogous immediate wake on realtime activation.
	const arm = (immediate?: boolean): void => {
		if (finished) return;
		if (immediate && pollTimer !== undefined) clearTimeout(pollTimer);
		pollTimer = setTimeout(() => {
			tickTimes.push(Date.now());
			arm();
		}, effectiveSteeringInterval(hasLiveControlRealtimeListeners()));
		pollTimer.unref?.();
	};

	try {
		// Phase 1: no realtime listener → idle 500ms cadence. Over 300ms there
		// is NO tick.
		arm();
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(tickTimes.length, 0, "idle cadence must NOT tick within 300ms");

		// Phase 2: a live-session realtime subscription activates → cadence
		// shortens to ~50ms. Re-arm so the first short-cadence tick is not
		// masked by the leftover 500ms idle arm (prompt-runtime does the same
		// immediate wake on activation).
		const unsub = subscribeLiveControlRealtime(() => undefined);
		arm(true);
		await new Promise((r) => setTimeout(r, 300));
		assert.ok(tickTimes.length >= 4, `realtime-active should tick several times in 300ms (got ${tickTimes.length})`);

		// Phase 3: the realtime subscription drops → cadence relaxes back to
		// 500ms. Any tick armed at the old 50ms fires within ≤50ms; after a
		// settle window the next re-arm is at 500ms, so over the following
		// 300ms window there must be NO new tick.
		unsub();
		const beforeSettle = tickTimes.length;
		await new Promise((r) => setTimeout(r, 120)); // allow the in-flight short tick to fire + re-arm at 500ms
		const settleCount = tickTimes.length - beforeSettle;
		assert.ok(settleCount <= 1, `at most one in-flight short tick may fire during settle (got ${settleCount})`);
		const relaxedBefore = tickTimes.length;
		await new Promise((r) => setTimeout(r, 300));
		assert.equal(
			tickTimes.length - relaxedBefore,
			0,
			"after realtime drops the poll must relax back to the 500ms idle cadence (no tick within 300ms)",
		);
	} finally {
		finished = true;
		if (pollTimer !== undefined) clearTimeout(pollTimer);
		tickTimes.length = 0;
		clearLiveControlRealtimeForTest();
	}
});