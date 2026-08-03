import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatDuration } from "../../../../src/extension/team-onboard.ts";

/**
 * B2 regression: onboard used to render "NaNm" duration + "⚠️ undefined" status
 * for legacy test runs with missing/invalid timestamps or missing status fields.
 * These tests pin the defensive formatting so the onboard table stays readable.
 */
describe("formatDuration — defensive against invalid timestamps (B2)", () => {
	it("returns 'm'/'h'/'<1m' for valid timestamps", () => {
		const base = "2026-06-18T01:00:00Z";
		const secOrMinLater = (ms: number) => new Date(new Date(base).getTime() + ms).toISOString();
		assert.equal(formatDuration(base, secOrMinLater(20_000)), "<1m"); // 20s rounds to 0m → <1m
		assert.equal(formatDuration(base, secOrMinLater(5 * 60_000)), "5m");
		assert.equal(formatDuration(base, secOrMinLater(90 * 60_000)), "2h");
	});

	it("returns '?' (NOT 'NaNm') for invalid/missing createdAt", () => {
		assert.equal(formatDuration("not-a-date"), "?");
		assert.equal(formatDuration(""), "?");
	});

	it("returns '?' when completedAt is invalid", () => {
		assert.equal(formatDuration("2026-06-18T01:00:00Z", "garbage"), "?");
	});

	it("returns '?' when end < start (negative duration)", () => {
		// Defensive: a corrupted record where completedAt < createdAt.
		assert.equal(formatDuration("2026-06-18T02:00:00Z", "2026-06-18T01:00:00Z"), "?");
	});

	it("uses Date.now() as end when completedAt omitted (still finite for valid start)", () => {
		// A run created 10 min ago with no completedAt → ~10m.
		const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
		const out = formatDuration(tenMinAgo);
		assert.match(out, /^(\d+m|<1m)$/);
	});
});
