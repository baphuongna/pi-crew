import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	preserveBoxBackground,
	fillToolBackground,
	fillLineToWidth,
	rule,
	lnum,
	gutterWidth,
	renderToolMetrics,
	renderToolPanel,
	RESET_WITHOUT_BG,
	RESET,
} from "../../src/ui/ansi-box.ts";

/**
 * pi-pretty rendering core (Part A). The cleverest piece is preserveBoxBackground:
 * it lets syntax-highlighted fg-only output sit inside a bg-filled tool box without
 * the inner full-resets punching holes through the box bg. These tests pin the exact
 * SGR rewrite semantics so the box-fill never breaks.
 */

const BG = "\x1b[48;2;30;30;40m";

// ── preserveBoxBackground ───────────────────────────────────────────────

describe("preserveBoxBackground — SGR rewrite for bg-filled boxes", () => {
	it("neutralizes full resets into RESET_WITHOUT_BG (bg survives)", () => {
		const out = preserveBoxBackground(`\x1b[31mred\x1b[0m more`);
		assert.ok(out.includes(RESET_WITHOUT_BG), "full reset → RESET_WITHOUT_BG");
		assert.ok(!out.includes("\x1b[0m"), "no raw full reset survives");
		// The fg color and text survive.
		assert.ok(out.includes("\x1b[31m"));
		assert.ok(out.includes("red"));
		assert.ok(out.includes("more"));
	});

	it("keeps foreground-extended sequences (38;2;r;g;b and 38;5;n) verbatim", () => {
		const fgTruecolor = "\x1b[38;2;255;100;50mhi";
		const fg256 = "\x1b[38;5;208mhi";
		assert.equal(preserveBoxBackground(fgTruecolor), fgTruecolor, "38;2;r;g;b kept");
		assert.equal(preserveBoxBackground(fg256), fg256, "38;5;n kept");
	});

	it("strips background-extended sequences (48;2;r;g;b and 48;5;n)", () => {
		const bgTruecolor = "\x1b[1m\x1b[48;2;10;20;30mbold-on-bg";
		const out = preserveBoxBackground(bgTruecolor);
		assert.ok(!out.includes("48;2"), "48;2;r;g;b stripped");
		assert.ok(out.includes("\x1b[1m"), "bold (1) kept");
		assert.ok(out.includes("bold-on-bg"), "text kept");
	});

	it("strips single-byte background codes (40-47, 49, 100-107)", () => {
		assert.ok(!preserveBoxBackground("\x1b[44m").includes("44"), "44 stripped");
		assert.ok(!preserveBoxBackground("\x1b[49m").includes("49"), "49 stripped");
		assert.ok(!preserveBoxBackground("\x1b[105m").includes("105"), "105 stripped");
	});

	it("keeps text-attribute codes (bold=1, dim=2, italic=3, underline=4, …)", () => {
		assert.ok(preserveBoxBackground("\x1b[1m").includes("\x1b[1m"), "bold kept");
		assert.ok(preserveBoxBackground("\x1b[3m").includes("\x1b[3m"), "italic kept");
		assert.ok(preserveBoxBackground("\x1b[4m").includes("\x1b[4m"), "underline kept");
	});

	it("returns the string unchanged when it has no SGR sequences", () => {
		assert.equal(preserveBoxBackground("plain text"), "plain text");
	});

	it("handles combined sequences (mixed fg + bg in one SGR)", () => {
		// \x1b[38;2;1;2;3;48;2;4;5;6m = fg AND bg truecolor in one escape.
		const combined = "\x1b[38;2;1;2;3;48;2;4;5;6mhi";
		const out = preserveBoxBackground(combined);
		assert.ok(out.includes("38;2;1;2;3"), "fg truecolor kept");
		assert.ok(!out.includes("48;2;4;5;6"), "bg truecolor stripped from combined");
	});

	it("is idempotent (running it twice == once)", () => {
		const input = "\x1b[1m\x1b[38;2;10;20;30m\x1b[48;2;99;99;99mhi\x1b[0m";
		assert.equal(preserveBoxBackground(preserveBoxBackground(input)), preserveBoxBackground(input));
	});
});

// ── fillToolBackground ──────────────────────────────────────────────────

describe("fillToolBackground — per-line bg fill", () => {
	it("prefixes every line with the bg sequence", () => {
		const out = fillToolBackground("a\nb\nc", BG);
		const lines = out.split("\n");
		assert.equal(lines.length, 3);
		for (const line of lines) assert.ok(line.startsWith(BG), `line must start with bg: ${line}`);
	});

	it("preserves inner fg colors while neutralizing resets", () => {
		const out = fillToolBackground("\x1b[32mgreen\x1b[0m", BG);
		assert.ok(out.startsWith(BG), "bg prefix");
		assert.ok(out.includes("\x1b[32m"), "fg green kept");
		assert.ok(out.includes(RESET_WITHOUT_BG), "inner reset neutralized");
		assert.ok(!out.includes("\x1b[0m"), "no raw reset survives");
	});

	it("truncates each line to width when given", () => {
		const long = "x".repeat(50);
		const out = fillToolBackground(long, BG, 10);
		// visible width of each line <= 10 (after stripping ANSI)
		for (const line of out.split("\n")) {
			const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
			assert.ok(stripped.length <= 10, `line truncated: ${stripped.length}`);
		}
	});

	it("no-op when bg is empty (graceful degradation)", () => {
		const text = "\x1b[31mred\x1b[0m";
		const out = fillToolBackground(text, "");
		// With no bg, preserveBoxBackground still neutralizes resets, but no bg prefix.
		assert.ok(!out.startsWith(BG), "no bg prefix when bg empty");
		assert.ok(out.includes(RESET_WITHOUT_BG), "reset still neutralized for safety");
	});
});

// ── rule / lnum / gutterWidth ───────────────────────────────────────────

describe("rule — separator", () => {
	it("draws a width-cell rule of ─ chars", () => {
		const r = rule(5);
		assert.equal(r, "─".repeat(5));
	});
	it("wraps the rule in a color sequence when given", () => {
		const r = rule(3, "\x1b[38;5;240m");
		assert.ok(r.startsWith("\x1b[38;5;240m"));
		assert.ok(r.endsWith(RESET));
		assert.ok(r.includes("─".repeat(3)));
	});
	it("width 0 → empty", () => {
		assert.equal(rule(0), "");
	});
});

describe("lnum — line-number gutter cell", () => {
	it("right-pads the number to the gutter width", () => {
		assert.equal(lnum(3, 4), "   3");
		assert.equal(lnum(42, 4), "  42");
	});
	it("wraps in a color when given", () => {
		const v = lnum(1, 3, "\x1b[36m");
		assert.ok(v.startsWith("\x1b[36m"));
		assert.ok(v.endsWith(RESET));
	});
});

describe("gutterWidth — min 3, grows with end line number", () => {
	it("minimum 3", () => {
		assert.equal(gutterWidth(1), 3);
		assert.equal(gutterWidth(9), 3);
		assert.equal(gutterWidth(99), 3);
	});
	it("grows for 3+ digit line counts", () => {
		assert.equal(gutterWidth(100), 3);
		assert.equal(gutterWidth(999), 3);
		assert.equal(gutterWidth(1000), 4);
		assert.equal(gutterWidth(9999), 4);
		assert.equal(gutterWidth(10000), 5);
	});
});

// ── renderToolMetrics ───────────────────────────────────────────────────

describe("renderToolMetrics — '· elapsed · chars'", () => {
	it("formats ms / seconds / minutes", () => {
		assert.ok(renderToolMetrics({ elapsedMs: 500 }).includes("500ms"));
		assert.ok(renderToolMetrics({ elapsedMs: 1500 }).includes("1.5s"));
		assert.ok(renderToolMetrics({ elapsedMs: 65_000 }).includes("1m5s"));
	});
	it("formats char counts with k/M suffixes", () => {
		assert.ok(renderToolMetrics({ charCount: 500 }).includes("500"));
		assert.ok(renderToolMetrics({ charCount: 4200 }).includes("4.2k"));
		assert.ok(renderToolMetrics({ charCount: 1_500_000 }).includes("1.5M"));
	});
	it("joins both metrics with ·", () => {
		const m = renderToolMetrics({ elapsedMs: 1200, charCount: 3000 });
		assert.match(m, /· 1\.2s · 3\.0k/);
	});
	it("returns empty string when no metrics", () => {
		assert.equal(renderToolMetrics({}), "");
		assert.equal(renderToolMetrics({ elapsedMs: 0, charCount: 0 }), "");
	});
	it("wraps in dim color when given", () => {
		const m = renderToolMetrics({ elapsedMs: 100 }, "\x1b[2m");
		assert.ok(m.startsWith("\x1b[2m"));
		assert.ok(m.endsWith(RESET));
	});
});

// ── renderToolPanel — high-level composition ────────────────────────────

describe("renderToolPanel — header + rule + body + footer/metrics", () => {
	it("composes a panel with bg fill on every line", () => {
		const panel = renderToolPanel({
			header: "read foo.ts",
			bodyLines: ["line1", "line2"],
			bg: BG,
			width: 40,
		});
		const lines = panel.split("\n");
		// header, rule, 2 body lines
		assert.equal(lines.length, 4);
		for (const line of lines) assert.ok(line.startsWith(BG), `bg-filled: ${line.slice(0, 20)}`);
		// rule is line index 1
		assert.ok(lines[1].includes("─"), "rule present after header");
	});

	it("includes footer and metrics lines when provided", () => {
		const panel = renderToolPanel({
			header: "bash",
			bodyLines: ["ok"],
			footer: "… 5 more lines",
			metrics: "· 1.2s",
			bg: BG,
			width: 20,
		});
		assert.ok(panel.includes("… 5 more lines"));
		assert.ok(panel.includes("· 1.2s"));
	});

	it("degrades gracefully with empty bg (no fill, still structured)", () => {
		const panel = renderToolPanel({
			header: "read",
			bodyLines: ["x"],
			bg: "",
			width: 20,
		});
		for (const line of panel.split("\n")) {
			assert.ok(!line.startsWith(BG), "no bg fill on bg-less path");
		}
		assert.ok(panel.includes("─"), "rule still present");
	});
});

// ── fillLineToWidth ─────────────────────────────────────────────────────

describe("fillLineToWidth — clean right edge", () => {
	const vw = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
	it("pads a short line out to width with bg fill", () => {
		const out = fillLineToWidth("hi", BG, 5, vw);
		assert.ok(out.includes(BG), "has bg");
		// visible width of the padded portion is 5
		const stripped = out.replace(/\x1b\[[0-9;]*m/g, "");
		assert.equal(stripped.length, 5, "padded to width");
	});
	it("no-op when bg empty or width <= 0", () => {
		assert.equal(fillLineToWidth("hi", "", 5, vw), "hi");
		assert.equal(fillLineToWidth("hi", BG, 0, vw), "hi");
	});
	it("no-op when line already >= width", () => {
		assert.equal(fillLineToWidth("hello world", BG, 5, vw), "hello world");
	});
});
