import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import {
	__test__clearVisibleWidthCache,
	__test__visibleWidthCacheSize,
	truncate,
	truncateToVisualLines,
	visibleWidth,
	wrapHard,
} from "../../../src/utils/visual.ts";

test("truncateToVisualLines keeps the tail after merging wrapped source lines", () => {
	const result = truncateToVisualLines("abcdefghij", 2, 2);
	assert.deepEqual(result, { visualLines: ["gh", "ij"], skippedCount: 3 });
});

test("truncateToVisualLines counts skipped lines across multiple source lines", () => {
	const result = truncateToVisualLines("abcd\nefgh\nijkl", 4, 2);
	assert.deepEqual(result, {
		visualLines: ["ef", "gh", "ij", "kl"],
		skippedCount: 2,
	});
});

test("truncateToVisualLines returns no visual lines for empty input", () => {
	assert.deepEqual(truncateToVisualLines("", 3, 10), {
		visualLines: [],
		skippedCount: 0,
	});
});

test("visibleWidth memoizes repeated strings without changing output", () => {
	__test__clearVisibleWidthCache();
	for (let i = 0; i < 1000; i++) assert.equal(visibleWidth("\u001b[31mfoo\u001b[0m"), 3);
	assert.equal(__test__visibleWidthCacheSize(), 1);
});

test("visibleWidth evicts old cache entries at the cache limit", () => {
	__test__clearVisibleWidthCache();
	for (let i = 0; i < 1000; i++) visibleWidth(`value-${i}`);
	assert.equal(__test__visibleWidthCacheSize(), 256);
	assert.equal(visibleWidth("value-999"), 9);
});

// ─── Regression: U+2B1C (⬜) width mismatch vs upstream pi-tui ─────────────
// Root cause of the recurring "Rendered line N exceeds terminal width
// (160 > 159)" TUI crash: pi-crew's WIDE_RANGES did not include U+2B1B-U+2B1C
// (large squares), so visibleWidth counted them as 1 while upstream pi-tui
// counts them as 2 (RGI emoji). After Box.render padded a widget line to 159
// chars, pi-tui re-measured it at 160 and crashed the host Pi process.
// This test pins the corrected width and exercises the truncate path that
// must now agree with pi-tui's measurement.
test("visibleWidth counts large squares (⬜ ⬛) as 2 columns", () => {
	assert.equal(visibleWidth("⬜"), 2, "U+2B1C WHITE LARGE SQUARE should be width 2");
	assert.equal(visibleWidth("⬛"), 2, "U+2B1B BLACK LARGE SQUARE should be width 2");
	// Sanity: surrounding codepoints NOT in the added range stay width 1.
	assert.equal(visibleWidth("⬀"), 1, "U+2B00 stays width 1 (not an emoji)");
	assert.equal(visibleWidth("⯿"), 1, "U+2BFF stays width 1 (not an emoji)");
});

test("truncate yields a line whose visibleWidth fits the cap when the line contains ⬜", () => {
	// Compose a line that, when padded to 159 chars, has visibleWidth 160
	// (because of the single ⬜). truncate(line, 159) must now bring
	// visibleWidth back down to ≤ 159 — matching upstream pi-tui's measure.
	const base = "│     ⊶ | S7: pi-audit security test | ⬜ pending | | · 39 tools · *** tok · 49s";
	const padded = base + " ".repeat(159 - base.length);
	assert.ok(visibleWidth(padded) === 160, "precondition: padded line overflows by exactly 1");
	const t = truncate(padded, 159);
	assert.ok(visibleWidth(t) <= 159, `truncate must fit the cap, got visibleWidth=${visibleWidth(t)}`);
});

test("short segments use a dedicated cache and do not evict long-string entries", () => {
	__test__clearVisibleWidthCache();
	visibleWidth("a"); // short cache
	visibleWidth("some long string used for the long entry cache");
	assert.equal(__test__visibleWidthCacheSize(), 1); // only the long entry
	assert.equal(visibleWidth("⏳"), 2); // matches pi-tui width model
	assert.equal(visibleWidth("a"), 1); // still correct on repeat
});

// ─── Regression: DR4/U6 — APC sequences (ESC _ … BEL/ST) are zero-width ─────
// pi-tui's CURSOR_MARKER ("\u001b_pi:c\u0007") is an APC string that focused
// components emit at the cursor position. consumeAnsi had no APC branch, so
// truncateToWidth/wrapHard walked the marker's payload as ordinary text:
// ~6 phantom columns plus a mid-escape slice (pre-fix, verified against the
// old code: truncate(`AB${CURSOR_MARKER}CDE`, 3) returned "AB\u001b…" — a
// dangling ESC; wrapHard(`A${CURSOR_MARKER}B`, 1) fragmented into 7 lines).
// The APC branch must mirror the OSC one: BEL or ST terminator, and a stray
// control char means the ESC is ordinary data again.
test("visibleWidth counts pi-tui CURSOR_MARKER (APC) as zero columns", () => {
	assert.equal(visibleWidth(CURSOR_MARKER), 0);
	assert.equal(visibleWidth(`A${CURSOR_MARKER}B`), 2);
});

test("truncateToWidth keeps the APC marker intact and zero-width when truncating", () => {
	// visibleWidth("AB"+marker+"CDE") = 5 > 3, so the truncation loop actually
	// runs (the early return only fires when the line already fits).
	const out = truncate(`AB${CURSOR_MARKER}CDE`, 3);
	assert.equal(out, `AB${CURSOR_MARKER}…`);
	assert.ok(out.includes(CURSOR_MARKER), "marker must survive truncation intact");
	assert.ok(visibleWidth(out) <= 3);
});

test("wrapHard does not count the APC marker as columns and keeps it attached", () => {
	assert.deepEqual(wrapHard(`A${CURSOR_MARKER}B`, 1), [`A${CURSOR_MARKER}`, "B"]);
	// 4 text columns + marker must still fit on one width-4 line: the wrap
	// falls after the trailing text, never inside the marker.
	assert.deepEqual(wrapHard(`aaaa${CURSOR_MARKER}bbbb`, 4), [`aaaa${CURSOR_MARKER}`, "bbbb"]);
});

test("APC sequences terminated by ST (ESC \\) are consumed like BEL ones", () => {
	const apcSt = "\u001b_pi:s\u001b\\";
	assert.equal(visibleWidth(`A${apcSt}B`), 2);
	assert.equal(truncate(`AB${apcSt}CD`, 3), `AB${apcSt}…`);
	assert.deepEqual(wrapHard(`aaaa${apcSt}bbbb`, 4), [`aaaa${apcSt}`, "bbbb"]);
});

test("malformed APC (control char before terminator) is not consumed as a sequence", () => {
	// SOH (0x01) cannot belong to an APC payload → consumeAnsi returns 0 and
	// the ESC is walked as ordinary data, so the wrap split lands INSIDE what
	// a greedy scanner would have swallowed (mirrors the OSC fallback).
	assert.deepEqual(wrapHard("\u001b_a\u0001B\u0007Z", 2), ["\u001b_a\u0001", "B\u0007Z"]);
});
