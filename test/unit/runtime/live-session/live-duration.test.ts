/**
 * Round 23 (BUG 1): computeLiveDurationMs must never return negative values
 * and must tolerate garbage/missing timestamps. This was the root cause of
 * every running live agent showing a giant negative duration in the dashboard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { computeLiveDurationMs, formatLiveDuration, type LiveActivity } from "../../../../src/ui/live-duration.ts";

const NOW = 1_780_000_000_000; // fixed "now" for determinism

test("running agent: now - startedAtMs (ms units)", () => {
	const act: LiveActivity = { startedAtMs: NOW - 12_000 };
	assert.equal(computeLiveDurationMs(act, NOW), 12_000);
	assert.equal(formatLiveDuration(act, NOW), "12.0s");
});

test("completed agent: uses completedAtMs", () => {
	const act: LiveActivity = {
		startedAtMs: NOW - 30_000,
		completedAtMs: NOW - 10_000,
	};
	assert.equal(computeLiveDurationMs(act, NOW), 20_000);
});

test("BUG 1 regression: missing startedAtMs → 0, NOT a giant negative", () => {
	// Old bug: (completedAtMs ?? now) - undefined = NaN; or now - 0 = ~1.78e12.
	// Both displayed as huge garbage. Must be 0 now.
	assert.equal(computeLiveDurationMs({ startedAtMs: undefined }, NOW), 0);
	assert.equal(computeLiveDurationMs({ startedAtMs: 0 }, NOW), 0);
	assert.equal(computeLiveDurationMs({}, NOW), 0);
});

test("BUG 1 regression: completedAtMs < startedAtMs (race) → clamped >= 0", () => {
	// A race where completion was recorded before start. Old math gave negative.
	const act: LiveActivity = {
		startedAtMs: NOW - 5_000,
		completedAtMs: NOW - 10_000,
	};
	const ms = computeLiveDurationMs(act, NOW);
	assert.ok(ms >= 0, `race must not yield negative duration, got ${ms}`);
});

test("BUG 1 regression: startedAtMs in seconds (not ms) is normalized", () => {
	// Some sources stamp in epoch seconds. 1.78e9 s == 1.78e12 ms.
	const act: LiveActivity = { startedAtMs: (NOW - 8_000) / 1000 };
	assert.equal(computeLiveDurationMs(act, NOW), 8_000);
});

test("BUG 1 regression: startedAtMs far in the future (clock skew) → 0", () => {
	// Clock skew / bad data. Must not produce a huge negative.
	const act: LiveActivity = { startedAtMs: NOW + 999_999_999_000 };
	assert.equal(computeLiveDurationMs(act, NOW), 0);
});

test("BUG 1 regression: startedAtMs is a stray tiny positive (pre-epoch-ish) → still never negative", () => {
	// An implausible tiny positive (e.g. an uninitialized field that defaults
	// away to a small number) can't occur from Date.now(), but the contract is
	// strict: computeLiveDurationMs must NEVER return negative regardless of
	// input. A huge-but-positive value is harmless (no negative sign displayed).
	const act: LiveActivity = { startedAtMs: 1 };
	const ms = computeLiveDurationMs(act, NOW);
	assert.ok(ms >= 0, `must never be negative, got ${ms}`);
});

test("formatLiveDuration never shows negative", () => {
	assert.equal(formatLiveDuration({ startedAtMs: 0 }, NOW), "0.0s");
	assert.equal(formatLiveDuration({ startedAtMs: NOW - 1_500 }, NOW), "1.5s");
	assert.ok(!formatLiveDuration({ startedAtMs: NOW + 10_000 }, NOW).startsWith("-"), "no negative sign");
});
