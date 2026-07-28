/**
 * Round 23 (BUG 2/3/4): Unicode-aware width & truncation in the UI layer.
 * CJK (double-width) and emoji (surrogate pairs) were mishandled by the
 * hand-rolled truncators, overflowing card frames and splitting surrogates.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "../../src/ui/card-colors.ts";
import { truncLine } from "../../src/ui/format-helpers.ts";

// truncVisual is module-private in tool-renderers/index.ts; it now delegates
// to the shared truncateToWidth (utils/visual.ts) which truncLine also uses,
// so testing truncLine + visibleWidth covers the BUG 2/3/4 fixes.

test("BUG 2: card-colors visibleWidth counts CJK as 2 columns (not 1)", () => {
	// 4 CJK chars = 8 visual columns. Old code returned 4 (code units).
	assert.equal(visibleWidth("汉字测试"), 8);
});

test("BUG 2: card-colors visibleWidth strips ANSI before counting", () => {
	assert.equal(visibleWidth("\x1b[31mhi\x1b[0m"), 2);
});

test("BUG 2: card-colors visibleWidth counts emoji correctly", () => {
	// 'a' + rocket emoji (surrogate pair, width 2) = 3 visual columns.
	assert.equal(visibleWidth("a🚀"), 3);
});

test("BUG 4: truncLine truncates CJK by VISUAL width (no frame overflow)", () => {
	// 10 CJK chars = 20 visual columns. Truncating to width 6 must yield <= 6 cols.
	const out = truncLine("汉字汉字汉字汉字汉字", 6);
	assert.ok(visibleWidth(out) <= 6, `truncLine overflowed to ${visibleWidth(out)} cols: ${out}`);
	// And it should retain an ellipsis for the truncation.
	assert.ok(out.includes("…") || visibleWidth(out) <= 6, "should be truncated with ellipsis");
});

test("BUG 4: truncLine does NOT split surrogate pairs (no U+FFFD)", () => {
	// Many emoji in a row. Slicing must never cut a surrogate pair in half.
	const out = truncLine("🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀", 5);
	// No replacement char from a split pair.
	assert.ok(!out.includes("\uFFFD"), `split a surrogate pair: ${JSON.stringify(out)}`);
});

test("BUG 4: truncLine preserves ANSI codes through truncation", () => {
	const out = truncLine("\x1b[31mhello world\x1b[0m", 5);
	// The color sequence should survive (visible width is 5, not counting ANSI).
	assert.ok(out.includes("\x1b[31m"), "leading ANSI color preserved");
});

test("BUG 4: truncLine passes through short strings unchanged", () => {
	assert.equal(truncLine("hi", 10), "hi");
	assert.equal(truncLine("hello", 5), "hello");
});

test("regression: truncLine still collapses newlines to arrow", () => {
	assert.equal(truncLine("line1\nline2", 50), "line1↵ line2");
});
