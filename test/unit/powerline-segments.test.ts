import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { renderSegment, renderSegmentChain, DEFAULT_POWERLINE_SEPARATORS } from "../../src/ui/powerline-segments.ts";
import type { CrewTheme } from "../../src/ui/theme-adapter.ts";

/**
 * T3 (pi-bar powerline renderSegment): verify the 10-step bg/fg chaining
 * sequence produces correct ANSI with no SGR leaks between segments, and
 * that the fallback theme (no bg support) degrades gracefully.
 */

// --- test themes ---

/** A fake theme that records calls and emits deterministic ANSI markers. */
function recordingTheme(): CrewTheme & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		fg: (color: string, text: string) => {
			calls.push(`fg:${color}`);
			return `\x1b[fg=${color}]${text}`;
		},
		bg: (color: string, text: string) => {
			calls.push(`bg:${color}`);
			return `\x1b[bg=${color}]${text}`;
		},
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	};
}

/** A theme WITHOUT bg support (degradation path). */
function fgOnlyTheme(): CrewTheme {
	return {
		fg: (color: string, text: string) => `\x1b[fg=${color}]${text}`,
		bold: (text: string) => text,
	};
}

describe("powerline-segments — T3 renderSegment (pi-bar port)", () => {
	it("emits the canonical 10-step sequence with RESET between phases (no SGR leak)", () => {
		const theme = recordingTheme();
		const out = renderSegment(theme, { bg: "success", fg: "text", text: "OK" }, {});
		// Every SGR phase must be RESET-terminated so adjacent segments don't
		// bleed state. The leading sep + filled text + trailing sep pattern.
		assert.ok(out.includes("\x1b[0m"), "must contain RESET (\\x1b[0m)");
		const resetCount = (out.match(/\x1b\[0m/g) ?? []).length;
		assert.ok(resetCount >= 3, `expected ≥3 RESETs (one per phase), got ${resetCount}`);
		// The text must survive intact inside the fill.
		assert.ok(out.includes("OK"), "segment text must be present");
	});

	it("uses the segment bg as the leading separator's fg (chains from prev)", () => {
		const theme = recordingTheme();
		renderSegment(theme, { bg: "success", fg: "text", text: "X" }, {});
		// First fg call is the leading separator painted in THIS segment's bg.
		assert.equal(theme.calls[0], "fg:success");
	});

	it("uses the segment's OWN bg as the trailing separator fg (pi-bar variant)", () => {
		const theme = recordingTheme();
		const out = renderSegment(
			theme,
			{ bg: "success", fg: "text", text: "X" },
			{ nextBg: "error" },
		);
		// pi-bar variant (verified ansi.ts:31-46): trailing sep fg = THIS segment's
		// bg (success), NOT nextBg. Both transitions are RESET-terminated so the
		// next segment's leading sep overlays cleanly. nextBg is ignored.
		assert.ok(theme.calls.includes("fg:success"), "trailing sep fg = this.bg (success)");
		assert.ok(out.includes(DEFAULT_POWERLINE_SEPARATORS.trailing), "trailing glyph present");
	});

	it("trailing separator always uses this segment's own bg (nextBg ignored)", () => {
		const theme = recordingTheme();
		renderSegment(theme, { bg: "success", fg: "text", text: "X" }, {});
		// Last fg call is the trailing separator; it = this.bg (success) always.
		const lastFg = [...theme.calls].reverse().find((c) => c.startsWith("fg:"));
		assert.equal(lastFg, "fg:success");
	});

	it("degrades gracefully when theme has no bg support (fg-only, plain separator)", () => {
		const theme = fgOnlyTheme();
		const out = renderSegment(theme, { bg: "success", fg: "text", text: "OK" }, {});
		// No bg-fill markers; text survives; separators still drawn.
		assert.ok(out.includes("OK"));
		assert.ok(out.includes(DEFAULT_POWERLINE_SEPARATORS.leading));
		assert.ok(out.includes(DEFAULT_POWERLINE_SEPARATORS.trailing));
		assert.ok(!out.includes("\x1b[bg="), "must not attempt bg fill on a bg-less theme");
	});

	it("renderSegmentChain: each segment's trailing sep uses its OWN bg (pi-bar)", () => {
		const theme = recordingTheme();
		theme.calls.length = 0;
		const out = renderSegmentChain(theme, [
			{ bg: "success", fg: "text", text: "A" },
			{ bg: "warning", fg: "text", text: "B" },
			{ bg: "error", fg: "text", text: "C" },
		]);
		// pi-bar variant: each segment's trailing sep is painted in its OWN bg.
		// A's trailing = success, B's trailing = warning, C's trailing = error.
		assert.ok(theme.calls.includes("fg:success"), "A trailing fg = success (A's own bg)");
		assert.ok(theme.calls.includes("fg:warning"), "B trailing fg = warning (B's own bg)");
		assert.ok(theme.calls.includes("fg:error"), "C trailing fg = error (C's own bg)");
		// All three texts survive.
		assert.ok(out.includes("A") && out.includes("B") && out.includes("C"));
	});

	it("renderSegmentChain returns empty string for zero segments", () => {
		assert.equal(renderSegmentChain(recordingTheme(), []), "");
	});

	it("each segment's bg is applied exactly once (no double-fill)", () => {
		const theme = recordingTheme();
		theme.calls.length = 0;
		renderSegmentChain(theme, [
			{ bg: "success", fg: "text", text: "A" },
			{ bg: "warning", fg: "text", text: "B" },
		]);
		const bgSuccess = theme.calls.filter((c) => c === "bg:success").length;
		const bgWarning = theme.calls.filter((c) => c === "bg:warning").length;
		assert.equal(bgSuccess, 1, "success bg applied exactly once");
		assert.equal(bgWarning, 1, "warning bg applied exactly once");
	});
});

// --- T3 consumer wiring: renderRunStatusSegments (powerbar-publisher) ---

import { renderRunStatusSegments } from "../../src/ui/powerbar-publisher.ts";

describe("renderRunStatusSegments — T3 consumer wiring", () => {
	it("renders multiple status segments as a chained powerline string", () => {
		const theme = recordingTheme();
		const out = renderRunStatusSegments(theme, [
			{ text: "1 running", color: "accent" },
			{ text: "3/5", color: "success" },
			{ text: "claude-sonnet", color: undefined },
		]);
		assert.ok(out.includes("1 running"), "first segment text present");
		assert.ok(out.includes("3/5"), "second segment text present");
		assert.ok(out.includes("claude-sonnet"), "third segment text present");
	});

	it("maps success color to toolSuccessBg fill", () => {
		const theme = recordingTheme();
		renderRunStatusSegments(theme, [{ text: "done", color: "success" }]);
		assert.ok(theme.calls.includes("bg:toolSuccessBg"), "success → toolSuccessBg");
	});

	it("maps error color to toolErrorBg fill", () => {
		const theme = recordingTheme();
		renderRunStatusSegments(theme, [{ text: "fail", color: "error" }]);
		assert.ok(theme.calls.includes("bg:toolErrorBg"), "error → toolErrorBg");
	});

	it("skips segments with empty/whitespace text", () => {
		const theme = recordingTheme();
		const out = renderRunStatusSegments(theme, [
			{ text: "   ", color: "accent" },
			{ text: "", color: "success" },
			{ text: "ok", color: "accent" },
		]);
		assert.ok(out.includes("ok"));
		assert.ok(!out.includes("   "), "whitespace-only segment skipped");
	});

	it("returns empty string when no segment has text", () => {
		const theme = recordingTheme();
		assert.equal(renderRunStatusSegments(theme, []), "");
		assert.equal(renderRunStatusSegments(theme, [{ text: "" }]), "");
	});

	it("degrades to fg-only on a bg-less theme (still readable)", () => {
		const out = renderRunStatusSegments(fgOnlyTheme(), [
			{ text: "running", color: "accent" },
		]);
		assert.ok(out.includes("running"));
		assert.ok(!out.includes("\x1b[bg="), "no bg fill on bg-less theme");
	});
});
