import assert from "node:assert/strict";
import test from "node:test";
import {
	__test__clearVisibleWidthCache,
	__test__visibleWidthCacheSize,
	truncate,
	truncateToVisualLines,
	visibleWidth,
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
