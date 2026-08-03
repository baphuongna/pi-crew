/**
 * Complementary tests for src/extension/notification-router.ts
 * Focuses on parseHHMMRange, isInQuietHours, and edge cases not covered by
 * the primary notification-router.test.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isInQuietHours,
	type NotificationDescriptor,
	NotificationRouter,
	parseHHMMRange,
} from "../../../../src/extension/notification-router.ts";

// ─── parseHHMMRange ─────────────────────────────────────────────────────────

describe("parseHHMMRange", () => {
	it("parses a valid HH:MM-HH:MM range", () => {
		const result = parseHHMMRange("09:00-17:00");
		assert.equal(result.startMin, 9 * 60);
		assert.equal(result.endMin, 17 * 60);
	});

	it("parses midnight boundary range", () => {
		const result = parseHHMMRange("22:00-06:00");
		assert.equal(result.startMin, 22 * 60);
		assert.equal(result.endMin, 6 * 60);
	});

	it("throws for malformed range string", () => {
		assert.throws(() => parseHHMMRange("invalid"), /Invalid quiet-hours range/);
	});

	it("throws for out-of-range hours (>23)", () => {
		assert.throws(() => parseHHMMRange("24:00-01:00"), /Invalid quiet-hours range/);
	});

	it("throws for out-of-range minutes (>59)", () => {
		assert.throws(() => parseHHMMRange("00:60-01:00"), /Invalid quiet-hours range/);
	});

	it("parses 00:00-00:00 (same start and end)", () => {
		const result = parseHHMMRange("00:00-00:00");
		assert.equal(result.startMin, 0);
		assert.equal(result.endMin, 0);
	});
});

// ─── isInQuietHours ─────────────────────────────────────────────────────────

describe("isInQuietHours", () => {
	it("returns true when current time is inside the range", () => {
		const now = new Date();
		now.setHours(10, 30, 0, 0);
		assert.equal(isInQuietHours("09:00-12:00", now), true);
	});

	it("returns false when current time is outside the range", () => {
		const now = new Date();
		now.setHours(14, 0, 0, 0);
		assert.equal(isInQuietHours("09:00-12:00", now), false);
	});

	it("handles overnight ranges (wraps midnight)", () => {
		const nightTime = new Date();
		nightTime.setHours(23, 0, 0, 0);
		assert.equal(isInQuietHours("22:00-06:00", nightTime), true);

		const morningTime = new Date();
		morningTime.setHours(3, 0, 0, 0);
		assert.equal(isInQuietHours("22:00-06:00", morningTime), true);

		const dayTime = new Date();
		dayTime.setHours(12, 0, 0, 0);
		assert.equal(isInQuietHours("22:00-06:00", dayTime), false);
	});

	it("returns false when start equals end (zero-duration range)", () => {
		const now = new Date();
		now.setHours(0, 0, 0, 0);
		assert.equal(isInQuietHours("00:00-00:00", now), false);
	});

	it("returns false at the exact end boundary", () => {
		const now = new Date();
		now.setHours(12, 0, 0, 0);
		assert.equal(isInQuietHours("09:00-12:00", now), false);
	});

	it("returns true at the exact start boundary", () => {
		const now = new Date();
		now.setHours(9, 0, 0, 0);
		assert.equal(isInQuietHours("09:00-12:00", now), true);
	});
});

// ─── NotificationRouter edge cases ───────────────────────────────────────────

describe("NotificationRouter enqueue with id-based dedup", () => {
	it("deduplicates notifications with the same id", () => {
		const delivered: NotificationDescriptor[] = [];
		const router = new NotificationRouter(
			{
				severityFilter: ["info", "warning", "error", "critical"],
				dedupWindowMs: 60_000,
				now: () => 1000,
			},
			(n) => delivered.push(n),
		);
		const n: NotificationDescriptor = {
			id: "unique-1",
			severity: "warning",
			source: "test",
			title: "Test",
		};
		assert.equal(router.enqueue(n), true);
		assert.equal(router.enqueue({ ...n }), false, "same id should be deduped");
		assert.equal(delivered.length, 1);
	});

	it("treats different ids as separate notifications", () => {
		const delivered: NotificationDescriptor[] = [];
		const router = new NotificationRouter(
			{
				severityFilter: ["info", "warning", "error", "critical"],
				now: () => 1000,
			},
			(n) => delivered.push(n),
		);
		router.enqueue({
			id: "a",
			severity: "warning",
			source: "test",
			title: "A",
		});
		router.enqueue({
			id: "b",
			severity: "warning",
			source: "test",
			title: "B",
		});
		assert.equal(delivered.length, 2);
	});

	it("uses source:runId:title as fallback key when id is absent", () => {
		const delivered: NotificationDescriptor[] = [];
		const router = new NotificationRouter(
			{
				severityFilter: ["info", "warning", "error", "critical"],
				dedupWindowMs: 60_000,
				now: () => 1000,
			},
			(n) => delivered.push(n),
		);
		router.enqueue({
			severity: "warning",
			source: "src",
			runId: "r1",
			title: "T",
		});
		router.enqueue({
			severity: "warning",
			source: "src",
			runId: "r1",
			title: "T",
		});
		assert.equal(delivered.length, 1, "fallback key should dedupe");
	});
});

describe("NotificationRouter batch flush with single item", () => {
	it("delivers single item directly on flush (no batch wrapping)", () => {
		const delivered: NotificationDescriptor[] = [];
		const router = new NotificationRouter(
			{
				severityFilter: ["info", "warning", "error", "critical"],
				batchWindowMs: 1000,
			},
			(n) => delivered.push(n),
		);
		router.enqueue({ severity: "error", source: "test", title: "Solo" });
		router.flush();
		assert.equal(delivered.length, 1);
		assert.equal(delivered[0].title, "Solo");
		assert.equal(delivered[0].source, "test", "single item should not be wrapped in batch");
	});
});

describe("NotificationRouter evictSeenIfNeeded", () => {
	it("does not crash when seen map exceeds max size", () => {
		const delivered: NotificationDescriptor[] = [];
		const router = new NotificationRouter(
			{
				severityFilter: ["info", "warning", "error", "critical"],
				dedupWindowMs: 0,
				now: () => 1000,
			},
			(n) => delivered.push(n),
		);
		// Enqueue many unique notifications to trigger eviction
		for (let i = 0; i < 10050; i++) {
			router.enqueue({
				id: `msg-${i}`,
				severity: "warning",
				source: "test",
				title: `T${i}`,
			});
		}
		// Should have delivered all (no crash) and seen map should have been pruned
		assert.equal(delivered.length, 10050);
	});
});

describe("NotificationRouter dispose and re-enqueue", () => {
	it("allows re-enqueue after dispose clears dedup state", () => {
		const delivered: NotificationDescriptor[] = [];
		const router = new NotificationRouter(
			{
				severityFilter: ["info", "warning", "error", "critical"],
				dedupWindowMs: 60_000,
				now: () => 1000,
			},
			(n) => delivered.push(n),
		);
		router.enqueue({
			id: "x",
			severity: "warning",
			source: "test",
			title: "T",
		});
		assert.equal(delivered.length, 1);
		router.dispose();
		router.enqueue({
			id: "x",
			severity: "warning",
			source: "test",
			title: "T",
		});
		assert.equal(delivered.length, 2, "after dispose, same notification should be allowed");
	});
});
