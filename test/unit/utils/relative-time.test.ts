/**
 * Unit tests for the pure relative-time formatter (D6-T4 injected clock).
 * @see src/utils/relative-time.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { formatRelativeTime } from "../../../src/utils/relative-time.ts";

const T0 = new Date("2026-09-13T05:00:00.000Z");

function at(msFromT0: number): Date {
	return new Date(T0.getTime() + msFromT0);
}

test("future minutes render as 'in Nm' — approved example 84m", () => {
	assert.equal(formatRelativeTime(T0, at(84 * 60_000)), "in 84m");
});

test("future 2d14h renders as 'in 2d14h' — approved example", () => {
	assert.equal(formatRelativeTime(T0, at((2 * 24 + 14) * 3_600_000)), "in 2d14h");
});

test("sub-minute deltas render seconds", () => {
	assert.equal(formatRelativeTime(T0, at(45_000)), "in 45s");
	assert.equal(formatRelativeTime(T0, at(1_000)), "in 1s");
});

test("minutes bucket covers up to (but not including) 2h", () => {
	assert.equal(formatRelativeTime(T0, at(59 * 60_000)), "in 59m");
	assert.equal(formatRelativeTime(T0, at(119 * 60_000)), "in 119m");
	assert.equal(formatRelativeTime(T0, at(120 * 60_000)), "in 2h");
});

test("hours bucket covers up to (but not including) 48h; exact 48h collapses to '2d'", () => {
	assert.equal(formatRelativeTime(T0, at(5 * 3_600_000)), "in 5h");
	assert.equal(formatRelativeTime(T0, at(47 * 3_600_000)), "in 47h");
	assert.equal(formatRelativeTime(T0, at(48 * 3_600_000)), "in 2d");
});

test("day bucket collapses zero-hour remainder to 'Nd'", () => {
	assert.equal(formatRelativeTime(T0, at(72 * 3_600_000)), "in 3d");
	assert.equal(formatRelativeTime(T0, at(100 * 3_600_000)), "in 4d4h");
});

test("past deltas render 'X ago' with the same magnitude ladder", () => {
	assert.equal(formatRelativeTime(T0, at(-10 * 60_000)), "10m ago");
	assert.equal(formatRelativeTime(T0, at(-90_000)), "1m ago");
	assert.equal(formatRelativeTime(T0, at(-(2 * 24 + 14) * 3_600_000)), "2d14h ago");
});

test("equal timestamps render 'now'", () => {
	assert.equal(formatRelativeTime(T0, new Date(T0.getTime())), "now");
});

test("rounding is floor on each bucket", () => {
	// 59.9s → 59s (not 1m)
	assert.equal(formatRelativeTime(T0, at(59_900)), "in 59s");
	// 1h59m59s → 119m (still minutes bucket)
	assert.equal(formatRelativeTime(T0, at(119 * 60_000 + 59_000)), "in 119m");
});

test("pure clock injection — same target, different now yields shifted output", () => {
	const target = at(84 * 60_000);
	assert.equal(formatRelativeTime(T0, target), "in 84m");
	assert.equal(formatRelativeTime(at(60 * 60_000), target), "in 24m");
});
