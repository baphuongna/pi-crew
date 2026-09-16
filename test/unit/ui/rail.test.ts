/**
 * RAIL design-system contract (src/ui/rail.ts).
 *
 * These tests are the grammar lock: every pi-crew surface imports its rail
 * glyphs, leaders, gauge, hint format and overflow dialect from this module, so
 * a regression here would silently restyle the whole product.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ACTIVE,
	CURSOR,
	canopyLine,
	dedupeAgentLabel,
	formatHint,
	gaugeBar,
	keyToken,
	overflowHint,
	RAIL,
	railLeaders,
	railLine,
	sectionLine,
	statusBadge,
	statusIcon,
	statusSlot,
} from "../../../src/ui/rail.ts";
import { asCrewTheme } from "../../../src/ui/theme-adapter.ts";

const theme = asCrewTheme({});
const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const bare = (s: string) => strip(s).trimEnd();
const vw = (s: string) => [...strip(s)].length;

test("RAIL: one glyph vocabulary — open, section, body, close", () => {
	assert.deepEqual(RAIL, { open: "┏", section: "┣", body: "┃", close: "┗" });
	assert.equal(CURSOR, "›");
	assert.equal(ACTIVE, "▸");
});

test("canopyLine: `┏ WORD ▸ subject`, with and without a subject", () => {
	assert.equal(bare(canopyLine({ word: "CREW", subject: "fast-fix", theme, budget: 60 })), "┏ CREW ▸ fast-fix");
	const noSubject = bare(canopyLine({ word: "HELP", theme, budget: 60 }));
	assert.equal(noSubject, "┏ HELP");
	assert.ok(!noSubject.includes("▸"), "a complete identity never leaves a dangling chevron");
});

test("canopyLine: right segment is dot-led and width-safe", () => {
	const wide = strip(canopyLine({ word: "DASHBOARD", subject: "3 runs", theme, budget: 60, right: "? help" }));
	assert.ok(wide.includes("? help"));
	assert.ok(wide.includes("···"));
	assert.ok(vw(wide) <= 62, `overflowed: ${vw(wide)}`); // budget + `┏ `

	const narrow = strip(canopyLine({ word: "DASHBOARD", subject: "3 runs", theme, budget: 18, right: "? help" }));
	assert.ok(narrow.includes("? help"), `right segment must survive: ${narrow}`);
	assert.ok(vw(narrow) <= 20, `overflowed: ${vw(narrow)}`);
});

test("sectionLine: replaces the legacy `── label ──` rule with `┣`", () => {
	assert.equal(bare(sectionLine({ name: "active", subject: "2", theme, budget: 60 })), "┣ ACTIVE ▸ 2");
	assert.equal(bare(sectionLine({ name: "schedules", theme, budget: 60 })), "┣ SCHEDULES");
});

test("railLine: never exceeds the content budget, whatever the input", () => {
	for (const budget of [4, 10, 40]) {
		const line = railLine(RAIL.body, "border", "x".repeat(200), theme, budget);
		assert.ok(vw(line) <= budget + 2, `budget=${budget} produced ${vw(line)}`);
		assert.ok(strip(line).startsWith("┃ "));
	}
});

test("railLeaders: absorb slack, collapse to a gap, keep the right segment", () => {
	const wide = bare(railLeaders("left", "1m59s", 40, theme));
	assert.match(wide, /^left ·+ 1m59s$/);

	const tight = bare(railLeaders("left", "ctrl+o", 14, theme));
	assert.ok(tight.includes("ctrl+o"), tight);
	assert.ok(vw(tight) <= 14, `${vw(tight)}`);

	const hopeless = bare(railLeaders("very long left side", "ctrl+o", 16, theme));
	assert.ok(vw(hopeless) <= 16, `${vw(hopeless)}`);

	// A hard cut reads as a bug — the elided left segment is marked with `…`
	// and the right segment still survives.
	const elided = bare(railLeaders("↑/↓/PgUp/PgDn/G scroll · A pause · Esc/Q close", "auto-scroll", 26, theme));
	assert.ok(elided.startsWith("↑/↓/PgUp"), elided);
	assert.ok(elided.includes("…"), `elision must be marked: ${elided}`);
	assert.ok(elided.endsWith("auto-scroll"), elided);
	assert.ok(vw(elided) <= 26, `${vw(elided)}`);
});

test("gaugeBar: eighth-block precision and fixed width", () => {
	assert.equal(strip(gaugeBar(1, 10, theme)), "▕██████████▏");
	assert.equal(strip(gaugeBar(0, 10, theme)), "▕░░░░░░░░░░▏");
	const half = strip(gaugeBar(0.5, 10, theme));
	assert.equal(half, "▕█████░░░░░▏");
	assert.equal(vw(half), 12);
	// sub-cell truthfulness: 1/16 of 8 cells = half a cell
	assert.ok(strip(gaugeBar(1 / 16, 8, theme)).includes("▌"), "half-cell must render as an eighth block");
});

test("statusSlot / statusBadge / statusIcon: one status mapping for every surface", () => {
	assert.equal(statusSlot("completed"), "success");
	assert.equal(statusSlot("done"), "success");
	assert.equal(statusSlot("succeeded"), "success");
	assert.equal(statusSlot("failed"), "error");
	assert.equal(statusSlot("cancelled"), "error");
	assert.equal(statusSlot("running"), "borderAccent");
	assert.equal(statusSlot("waiting"), "warning");
	assert.equal(statusSlot("queued"), "border");
	assert.equal(strip(statusBadge("completed", theme)), "●");
	assert.equal(strip(statusBadge("failed", theme)), "✖");
	assert.equal(strip(statusBadge("running", theme)), "◉");
	assert.equal(strip(statusIcon("completed", theme)), "✓");
	assert.equal(strip(statusIcon("failed", theme)), "✗");
});

test("overflowHint: exactly one dialect (▲ above / ▼ below)", () => {
	assert.equal(strip(overflowHint(3, 0, theme)), "▲ 3 above");
	assert.equal(strip(overflowHint(0, 2, theme)), "▼ 2 below");
	assert.equal(strip(overflowHint(1, 1, theme)), "▲ 1 above · ▼ 1 below");
	assert.equal(overflowHint(0, 0, theme), "");
});

test("keyToken: one spelling per key (Esc/Enter/Tab), bare uppercase letters", () => {
	assert.equal(keyToken("escape"), "Esc");
	assert.equal(keyToken("\u001b"), "Esc");
	assert.equal(keyToken("esc"), "Esc");
	assert.equal(keyToken("return"), "Enter");
	assert.equal(keyToken("\r"), "Enter");
	assert.equal(keyToken("\n"), "Enter");
	assert.equal(keyToken("\t"), "Tab");
	assert.equal(keyToken("up"), "↑/↓");
	assert.equal(keyToken("a"), "A");
	assert.equal(keyToken("q"), "Q");
});

test("formatHint: `keys label` pairs, ` · ` joined, close action last", () => {
	const hint = formatHint([
		[["up", "down"], "move"],
		["enter", "select"],
		["escape", "cancel"],
	]);
	assert.equal(hint, "↑/↓ move · Enter select · Esc cancel");
	assert.equal(formatHint([["escape", "close"]]), "Esc close");
});

test("dedupeAgentLabel: producer's `role/agent` duplication collapses", () => {
	assert.equal(dedupeAgentLabel("verifier/verifier"), "verifier");
	assert.equal(dedupeAgentLabel("explorer/explorer · read"), "explorer · read");
	assert.equal(dedupeAgentLabel("explorer/executor"), "explorer/executor");
	assert.equal(dedupeAgentLabel("plain"), "plain");
});
