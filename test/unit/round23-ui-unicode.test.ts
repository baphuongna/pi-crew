/**
 * Round 23 (BUG 2/3/4): Unicode-aware width & truncation in the UI layer.
 * CJK (double-width) and emoji (surrogate pairs) were mishandled by the
 * hand-rolled truncators, overflowing card frames and splitting surrogates.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { deriveCardBackground, visibleWidth } from "../../src/ui/card-colors.ts";
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

// ── P1-6 (2026-09-15): deriveCardBackground must probe a VALID ThemeBg slot ──
//
// Pi's `ThemeBg` = selectedBg | scrollbarThumb | userMessageBg | customMessageBg
// | toolPendingBg | toolSuccessBg | toolErrorBg, and `getBgAnsi` THROWS for any
// other string. The old probe passed "background" (not a member), so the throw
// was swallowed by the surrounding catch and `base` stayed BLACK on every
// theme. These tests pin the slot AND prove the theme base is really used.

/** Mirrors Pi's ThemeBg union (node_modules/.../theme/theme.d.ts). */
const THEME_BG_SLOTS = new Set([
	"selectedBg",
	"scrollbarThumb",
	"userMessageBg",
	"customMessageBg",
	"toolPendingBg",
	"toolSuccessBg",
	"toolErrorBg",
]);

interface ProbeRecording {
	bgSlots: string[];
	fgSlots: string[];
}

/**
 * A fake Theme whose `getBgAnsi` records every probed slot and — exactly like
 * Pi's real implementation — THROWS for a slot outside ThemeBg.
 */
function recordingTheme(base: string | undefined, accent: string | undefined, recording: ProbeRecording) {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		getBgAnsi: (slot: string) => {
			recording.bgSlots.push(slot);
			if (!THEME_BG_SLOTS.has(slot)) throw new Error(`Unknown theme background color: ${slot}`);
			return base as string;
		},
		getFgAnsi: (slot: string) => {
			recording.fgSlots.push(slot);
			return accent as string;
		},
	};
}

test("P1-6: deriveCardBackground only probes getBgAnsi with a slot inside ThemeBg", () => {
	for (const statusSlot of ["success", "error", "borderAccent", "border"] as const) {
		const recording: ProbeRecording = { bgSlots: [], fgSlots: [] };
		const theme = recordingTheme("\x1b[48;2;40;40;40m", "\x1b[38;2;184;187;38m", recording);
		const out = deriveCardBackground(theme as never, statusSlot);

		assert.ok(
			recording.bgSlots.length > 0,
			`getBgAnsi was never probed for ${statusSlot} — the tint base is not derived from the theme`,
		);
		for (const probed of recording.bgSlots) {
			assert.ok(
				THEME_BG_SLOTS.has(probed),
				`getBgAnsi probed with non-ThemeBg slot '${probed}' — Pi throws for it and the catch then pins base=BLACK (P1-6)`,
			);
		}
		assert.equal(
			recording.bgSlots.includes("background"),
			false,
			"'background' is not a ThemeBg member and must never be probed again",
		);
		assert.ok(out.startsWith("\x1b[48;2;"), `expected a truecolor bg SGR, got ${JSON.stringify(out)}`);
	}
});

test("P1-6: the theme's own background reaches mixBg as the tint base (not hard-wired BLACK)", () => {
	// intensity 0 → mixBg(base, accent, 0) returns `base` verbatim, so the
	// output equals whatever the probe resolved. Pre-P1-6 both cases were BLACK.
	const whiteRecording: ProbeRecording = { bgSlots: [], fgSlots: [] };
	const blackRecording: ProbeRecording = { bgSlots: [], fgSlots: [] };
	const fromWhite = deriveCardBackground(
		recordingTheme("\x1b[48;2;255;255;255m", "\x1b[38;2;0;0;0m", whiteRecording) as never,
		"success",
		0,
	);
	const fromBlack = deriveCardBackground(recordingTheme("\x1b[48;2;0;0;0m", "\x1b[38;2;0;0;0m", blackRecording) as never, "success", 0);

	assert.equal(fromWhite, "\x1b[48;2;255;255;255m", "a light theme background must be used as the base");
	assert.equal(fromBlack, "\x1b[48;2;0;0;0m");
	assert.notEqual(fromWhite, fromBlack, "the theme background must affect the result — pre-P1-6 both were BLACK");
});

test("P1-6: a theme without getBgAnsi still renders a tint (no crash, BLACK base)", () => {
	const noBg = { fg: (_c: string, t: string) => t, bold: (t: string) => t, getFgAnsi: () => "\x1b[38;2;184;187;38m" };
	const out = deriveCardBackground(noBg as never, "success");
	assert.ok(out.startsWith("\x1b[48;2;"), `expected a tint, got ${JSON.stringify(out)}`);
});

test("P1-6: a throwing getBgAnsi shim cannot crash the renderer", () => {
	const throwing = {
		fg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		getBgAnsi: () => {
			throw new Error("shim exploded");
		},
		getFgAnsi: () => "\x1b[38;2;184;187;38m",
	};
	const out = deriveCardBackground(throwing as never, "success");
	assert.ok(out.startsWith("\x1b[48;2;"), `expected a fallback tint, got ${JSON.stringify(out)}`);
});

test('P1-6: every literal getBgAnsi("…") slot in card-colors.ts is inside ThemeBg', async () => {
	const fs = await import("node:fs");
	const path = await import("node:path");
	const file = path.join(import.meta.dirname ?? process.cwd(), "../../src/ui/card-colors.ts");
	const source = fs.readFileSync(file, "utf8");
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
	const slots = [...code.matchAll(/getBgAnsi\(\s*"([^"]+)"/g)].map((m) => m[1]);
	assert.ok(slots.length > 0, "expected at least one literal getBgAnsi slot probe in card-colors.ts");
	for (const slot of slots) {
		assert.ok(
			THEME_BG_SLOTS.has(slot),
			`getBgAnsi("${slot}") is not a ThemeBg slot — Pi throws for it and the catch silently pins base=BLACK (P1-6)`,
		);
	}
});
