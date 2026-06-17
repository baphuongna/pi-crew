import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	layoutSegments,
	joinResolvedSegments,
	segmentVisibleWidth,
	type LayoutSegment,
} from "../../src/ui/status-layout.ts";

/**
 * pi-bar tiered 3-state collapse (Part B). The behavior to pin: as the target
 * width shrinks, segments degrade Full → Collapsed → Hidden by collapseOrder
 * (highest collapses first), so the primary/most-important info survives the
 * longest. This is BETTER than truncation (which just chops the line end).
 */

const S = <T = string>(full: T, fullWidth: number, extra: Partial<LayoutSegment<T>> = {}): LayoutSegment<T> => ({
	full,
	fullWidth,
	...extra,
});

describe("layoutSegments — Full when there's room", () => {
	it("keeps all segments Full when total ≤ width", () => {
		const segs = [
			S("3/5", 3, { collapseOrder: 1 }),
			S("sonnet", 6, { collapseOrder: 3 }),
			S("42%", 3, { collapseOrder: 2 }),
		];
		const out = layoutSegments(segs, 100);
		assert.deepEqual(out.map((r) => r.state), ["full", "full", "full"]);
		for (const r of out) assert.ok(r.text !== undefined);
	});
});

describe("layoutSegments — Full → Collapsed (Pass 1)", () => {
	it("collapses the HIGHEST collapseOrder segment first when over width", () => {
		const segs = [
			S("3/5 tasks", 9, { collapsed: "3/5", collapsedWidth: 3, collapseOrder: 1 }),
			S("claude-sonnet", 13, { collapsed: "sonnet", collapsedWidth: 6, collapseOrder: 3 }),
			S("$0.04", 5, { collapseOrder: 2 }),
		];
		// Total full = 9+13+5 = 27 cells + 2 gaps = 29. Target 22 → must collapse.
		// Highest collapseOrder with a shorter collapsed form = "claude-sonnet" (3).
		const out = layoutSegments(segs, 22);
		assert.equal(out[1].state, "collapsed", "sonnet segment collapses first (highest order)");
		assert.equal(out[1].text, "sonnet");
		assert.equal(out[0].state, "full");
		assert.equal(out[2].state, "full");
	});

	it("collapses multiple segments in order until it fits", () => {
		const segs = [
			S("3/5 tasks", 9, { collapsed: "3/5", collapsedWidth: 3, collapseOrder: 1 }),
			S("claude-sonnet", 13, { collapsed: "sonnet", collapsedWidth: 6, collapseOrder: 3 }),
		];
		// Total full = 9+13 = 22 + 1 gap = 23. Target 11 → collapse both.
		const out = layoutSegments(segs, 11);
		assert.equal(out[0].state, "collapsed");
		assert.equal(out[1].state, "collapsed");
	});

	it("does NOT collapse a segment whose collapsed form isn't shorter (jumps straight to hidden)", () => {
		const segs = [
			S("abc", 3, { collapseOrder: 1 }),
			S("xyz", 3, { collapsed: "xyz", collapsedWidth: 3, collapseOrder: 2 }), // not shorter
		];
		const out = layoutSegments(segs, 5);
		// xyz's collapsed == full width, so it is NOT a Pass-1 candidate. But Pass 2
		// (hide) still applies → it goes straight full→hidden, never passing through
		// "collapsed". The point: non-shortening segments skip the collapse tier.
		assert.notEqual(out[1].state, "collapsed", "non-shortening segment never enters collapsed state");
	});
});

describe("layoutSegments — → Hidden (Pass 2)", () => {
	it("hides the HIGHEST collapseOrder segment when collapsing isn't enough", () => {
		const segs = [
			S("3/5 tasks", 9, { collapseOrder: 1 }),
			S("claude-sonnet", 13, { collapseOrder: 3 }),
			S("$0.04", 5, { collapseOrder: 2 }),
		];
		// No collapsed forms → Pass 1 does nothing. Target 18 → Pass 2 hides highest.
		const out = layoutSegments(segs, 18);
		// Total = 27+2 gaps. Need to hide until ≤18. Highest order (3) hides first.
		assert.equal(out[1].state, "hidden", "sonnet (order 3) hides first");
	});

	it("hides segments until it fits, preserving the lowest-order segment", () => {
		const segs = [
			S("3/5", 3, { collapseOrder: 1 }),
			S("sonnet", 6, { collapseOrder: 3 }),
			S("$0.04", 5, { collapseOrder: 2 }),
		];
		// Tiny width 8: total 14+2. Hide order 3 (sonnet) → 3+5+1=9. Still >8. Hide order 2 ($0.04) → 3.
		const out = layoutSegments(segs, 8);
		assert.equal(out[0].state, "full", "lowest-order (3/5) survives");
	});

	it("segment without collapseOrder is never auto-hidden", () => {
		const segs = [
			S("primary", 7), // no collapseOrder → always full
			S("drop me", 7, { collapseOrder: 1 }),
		];
		const out = layoutSegments(segs, 5);
		assert.equal(out[0].state, "full", "uncollapsable segment always full");
	});
});

describe("layoutSegments — ordering preserved", () => {
	it("returned order matches input order (hidden included as placeholders)", () => {
		const segs = [
			S("a", 1, { collapseOrder: 1 }),
			S("b", 1, { collapseOrder: 2 }),
			S("c", 1, { collapseOrder: 3 }),
		];
		const out = layoutSegments(segs, 2);
		assert.equal(out.length, 3);
		assert.equal(out[0].text, "a");
	});
});

describe("layoutSegments — edge cases", () => {
	it("width 0 degrades multi-segment input but keeps ≥1 visible (floor)", () => {
		// Two segments at width 0: pass 2 hides the higher-order one, but the
		// floor-of-1 keeps the other visible (truncated to nothing by the join
		// backstop, but layout never yields a fully-empty set).
		const out = layoutSegments(
			[
				S("a", 1, { collapseOrder: 1 }),
				S("b", 1, { collapseOrder: 2 }),
			],
			0,
		);
		assert.equal(out[1].state, "hidden", "higher-order segment hidden");
		assert.notEqual(out[0].state, "hidden", "floor keeps one segment visible");
	});
	it("single segment with no collapseOrder stays full regardless of width", () => {
		const out = layoutSegments([S("long line here", 14)], 3);
		assert.equal(out[0].state, "full");
	});
});

describe("segmentVisibleWidth — ANSI-aware measurement", () => {
	it("strips ANSI sequences when counting cells", () => {
		assert.equal(segmentVisibleWidth("\x1b[31mred\x1b[0m"), 3);
		assert.equal(segmentVisibleWidth("\x1b[38;2;1;2;3mhi\x1b[0m there"), 8);
	});
	it("plain string returns its length", () => {
		assert.equal(segmentVisibleWidth("hello"), 5);
	});
});

describe("joinResolvedSegments — join + hard backstop", () => {
	it("joins visible segments with separator, skips hidden", () => {
		const out = layoutSegments(
			[
				S("3/5", 3, { collapseOrder: 1 }),
				S("sonnet", 6, { collapseOrder: 3 }),
				S("$0.04", 5, { collapseOrder: 2 }),
			],
			100,
		);
		const joined = joinResolvedSegments(out, 100);
		assert.equal(joined, "3/5 sonnet $0.04");
	});
	it("skips hidden segments in the join", () => {
		const out = layoutSegments(
			[
				S("3/5", 3, { collapseOrder: 1 }),
				S("sonnet", 6, { collapseOrder: 3 }), // will hide
			],
			3,
		);
		const joined = joinResolvedSegments(out, 100);
		assert.ok(joined.includes("3/5"));
		assert.ok(!joined.includes("sonnet"));
	});
	it("hard-truncates to width as a backstop", () => {
		const out = layoutSegments([S("xxxxxxxxxx", 10)], 4);
		const joined = joinResolvedSegments(out, 4);
		assert.ok(segmentVisibleWidth(joined) <= 4, `joined ≤ 4 cells: "${joined}"`);
	});
	it("respects a custom separator", () => {
		const out = layoutSegments([S("a", 1), S("b", 1)], 100);
		assert.equal(joinResolvedSegments(out, 100, " | "), "a | b");
	});
});

describe("layoutSegments — real pi-crew status scenario", () => {
	it("degrades a 5-segment run-status line gracefully as width shrinks", () => {
		const segs = [
			S("run-abc123", 10, { collapseOrder: 1 }), // run id — low priority
			S("3/5 tasks", 9, { collapsed: "3/5", collapsedWidth: 3, collapseOrder: 2 }),
			S("$0.04", 5, { collapseOrder: 3 }),
			S("claude-sonnet", 13, { collapsed: "sonnet", collapsedWidth: 6, collapseOrder: 4 }),
			S("42%", 3, { collapseOrder: 5 }),
		];
		// Wide: everything full.
		const wide = layoutSegments(segs, 120);
		assert.ok(wide.every((r) => r.state === "full"));

		// Medium (~30): collapses kick in (highest order first).
		const med = layoutSegments(segs, 30);
		const medHidden = med.filter((r) => r.state === "hidden").length;
		const medCollapsed = med.filter((r) => r.state === "collapsed").length;
		assert.ok(medCollapsed + medHidden > 0, "medium width triggers degradation");

		// Tiny (~6): everything degrades, but the floor keeps the lowest-order
		// segment visible (truncated by the join backstop) — never an empty line.
		const tiny = layoutSegments(segs, 6);
		assert.equal(tiny[0].state, "full", "run id (lowest order) survives at tiny width (floor of 1)");
		assert.ok(tiny.some((r) => r.state !== "hidden"), "at least one segment remains visible");
	});
});
