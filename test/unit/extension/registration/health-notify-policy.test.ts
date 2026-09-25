import assert from "node:assert/strict";
import test from "node:test";
import {
	type HealthNotifyState,
	healthNotifyFingerprint,
	MAX_HEALTH_NOTIFY_FIRES,
	recordHealthNotifyDecision,
	resetHealthNotifyEntry,
} from "../../../../src/extension/registration/health-notify-policy.ts";

/**
 * FINDING 6 regression (2026-09-23 battery): the health notifier re-fired the
 * same notification every 5-min cooldown window FOREVER for persistently-dead
 * runs; each fire queued a host follow-up that drained one-per-turn-boundary —
 * hours of stale ambient replays after the incident was cleared. The policy
 * bounds re-fires per unchanged fingerprint and resets on clear.
 */

const COOLDOWN = 5 * 60_000;

function makeState(maxEntries = 1000): HealthNotifyState {
	return { entries: new Map(), maxEntries };
}

test("F6: fires up to MAX_HEALTH_NOTIFY_FIRES for an unchanged fingerprint, then blocks", () => {
	const state = makeState();
	const fp = "1/0/3";
	const t0 = 1_000_000;
	assert.equal(recordHealthNotifyDecision(state, "k", fp, t0, COOLDOWN), true, "1st fire");
	assert.equal(recordHealthNotifyDecision(state, "k", fp, t0 + COOLDOWN, COOLDOWN), true, "2nd fire after cooldown");
	assert.equal(recordHealthNotifyDecision(state, "k", fp, t0 + 2 * COOLDOWN, COOLDOWN), true, "3rd fire after cooldown");
	assert.equal(
		recordHealthNotifyDecision(state, "k", fp, t0 + 3 * COOLDOWN, COOLDOWN),
		false,
		`4th fire blocked (cap ${MAX_HEALTH_NOTIFY_FIRES})`,
	);
	assert.equal(
		recordHealthNotifyDecision(state, "k", fp, t0 + 100 * COOLDOWN, COOLDOWN),
		false,
		"still blocked hours later — the old forever-re-arming behavior is gone",
	);
});

test("F6: cooldown still applies between fires", () => {
	const state = makeState();
	const fp = "2/0/5";
	assert.equal(recordHealthNotifyDecision(state, "k", fp, 0, COOLDOWN), true);
	assert.equal(recordHealthNotifyDecision(state, "k", fp, 1000, COOLDOWN), false, "inside cooldown window");
	assert.equal(recordHealthNotifyDecision(state, "k", fp, COOLDOWN + 1, COOLDOWN), true);
});

test("F6: changed fingerprint = new situation → fresh budget", () => {
	const state = makeState();
	const t0 = 1_000_000;
	for (let i = 0; i < MAX_HEALTH_NOTIFY_FIRES; i += 1) {
		assert.equal(recordHealthNotifyDecision(state, "k", "1/0/3", t0 + i * COOLDOWN, COOLDOWN), true);
	}
	assert.equal(recordHealthNotifyDecision(state, "k", "1/0/3", t0 + 99 * COOLDOWN, COOLDOWN), false, "capped");
	// The run now has MORE dead workers — genuinely different situation.
	assert.equal(recordHealthNotifyDecision(state, "k", "2/0/3", t0 + 100 * COOLDOWN, COOLDOWN), true, "re-arms on fingerprint change");
	assert.equal(state.entries.get("k")?.fires, 1, "fire count restarted for the new fingerprint");
});

test("F6: reset-on-clear gives a genuine recurrence a fresh budget", () => {
	const state = makeState();
	const fp = "1/1/2";
	const t0 = 1_000_000;
	recordHealthNotifyDecision(state, "k", fp, t0, COOLDOWN);
	recordHealthNotifyDecision(state, "k", fp, t0 + COOLDOWN, COOLDOWN);
	resetHealthNotifyEntry(state, "k");
	assert.equal(state.entries.has("k"), false, "entry gone");
	assert.equal(recordHealthNotifyDecision(state, "k", fp, t0 + 2 * COOLDOWN, COOLDOWN), true, "recurrence after clear re-notifies");
});

test("F6: fingerprint shape", () => {
	assert.equal(healthNotifyFingerprint({ dead: 2, missing: 1 }, 7), "2/1/7");
	assert.notEqual(healthNotifyFingerprint({ dead: 2, missing: 1 }, 7), healthNotifyFingerprint({ dead: 3, missing: 1 }, 7));
});

test("F6: LRU eviction at the map cap", () => {
	const state = makeState(2);
	recordHealthNotifyDecision(state, "a", "0/0/1", 0, COOLDOWN);
	recordHealthNotifyDecision(state, "b", "0/0/1", 100, COOLDOWN);
	recordHealthNotifyDecision(state, "c", "0/0/1", 200, COOLDOWN); // evicts "a" (oldest access)
	assert.equal(state.entries.has("a"), false);
	assert.equal(state.entries.has("b"), true);
	assert.equal(state.entries.has("c"), true);
});

test("F6: blocked-at-cap still refreshes lastAccessAt (LRU stays accurate)", () => {
	const state = makeState(2);
	recordHealthNotifyDecision(state, "a", "0/0/1", 0, COOLDOWN);
	recordHealthNotifyDecision(state, "b", "0/0/1", 100, COOLDOWN);
	// "a" is capped (fire 1 of 1 via maxFires=1) at a LATER time than b's access.
	recordHealthNotifyDecision(state, "a", "0/0/1", 5000, 1, 1);
	assert.equal(recordHealthNotifyDecision(state, "c", "0/0/1", 6000, COOLDOWN), true);
	assert.equal(state.entries.has("b"), false, "b evicted — a's access was refreshed by the blocked attempt");
});
