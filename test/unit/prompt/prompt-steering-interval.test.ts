/**
 * Tests for PERF R2 task 5: event-driven + adaptive steering poll under
 * live-session.
 *
 * The pure decision helper under test lives in src/prompt/prompt-runtime.ts:
 *   - `effectiveSteeringInterval({ realtimeActive, requestInFlight })`
 *     returns the short 50ms cadence while live-session realtime is active OR
 *     a request (ask/delegate/steer) is in flight, and relaxes back to the
 *     prior 500ms bounded-cost cadence when idle.
 *
 * The three poll sites (ask loop, delegate loop, mailbox steering poll) all
 * consult this helper; the broker-push path (Feature 2b) is unchanged and
 * still delivers immediately regardless of the interval.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { effectiveSteeringInterval } from "../../../src/prompt/prompt-runtime.ts";
import {
	clearLiveControlRealtimeForTest,
	subscribeLiveControlRealtime,
} from "../../../src/runtime/live-session/live-control-realtime.ts";

test("PERF-R2/T5: realtime-active → effective interval is 50ms", () => {
	assert.equal(effectiveSteeringInterval({ realtimeActive: true, requestInFlight: false }), 50);
	// Real-time dominates even when no specific request is tracked.
	assert.equal(effectiveSteeringInterval({ realtimeActive: true, requestInFlight: true }), 50);
});

test("PERF-R2/T5: realtime-inactive AND idle → effective interval relaxes to 500ms", () => {
	assert.equal(effectiveSteeringInterval({ realtimeActive: false, requestInFlight: false }), 500);
});

test("PERF-R2/T5: in-flight request → 50ms/immediate wake even without realtime", () => {
	// An outstanding ask/delegate poll owns the loop; it must not sit on the
	// full 500ms idle cadence while an answer is expected.
	assert.equal(effectiveSteeringInterval({ realtimeActive: false, requestInFlight: true }), 50);
});

test("PERF-R2/T5: interval transitions back to 500ms when idle again", () => {
	// Active while a request is in flight, then relax once it completes.
	assert.equal(effectiveSteeringInterval({ realtimeActive: false, requestInFlight: true }), 50);
	assert.equal(effectiveSteeringInterval({ realtimeActive: false, requestInFlight: false }), 500);
});

test("PERF-R2/T5: realtime listener signal drives the interval end-to-end", () => {
	clearLiveControlRealtimeForTest();
	try {
		// No realtime listeners + no in-flight → idle 500ms cadence.
		assert.equal(effectiveSteeringInterval({ realtimeActive: false, requestInFlight: false }), 500);
		// A live-session realtime subscription activates → short cadence.
		const unsub = subscribeLiveControlRealtime(() => undefined);
		const active = true; // hasLiveControlRealtimeListeners() is true while subscribed
		assert.equal(effectiveSteeringInterval({ realtimeActive: active, requestInFlight: false }), 50);
		assert.equal(
			effectiveSteeringInterval({ realtimeActive: active, requestInFlight: true }),
			50,
			"in-flight under realtime stays at the short cadence",
		);
		unsub();
		// Subscription drops → relaxes back to 500ms when no request is in flight.
		assert.equal(effectiveSteeringInterval({ realtimeActive: false, requestInFlight: false }), 500);
	} finally {
		clearLiveControlRealtimeForTest();
	}
});