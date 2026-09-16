/**
 * UI-10: comprehensive no-color mode for src/ui/widget/widget-formatters.ts.
 *
 * When NO_COLOR is set (any non-empty value, per https://bixense.com/clicolors/)
 * OR stdout is non-TTY, the formatters must emit NO ANSI escape codes — only
 * plain strings. This file exercises both suppression paths and also proves the
 * color gate actually changes output in color mode (otherwise the suppression
 * is vacuous).
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { __resetColorMode, __setColorModeForTest, notificationBadge } from "../../../src/ui/widget/widget-formatters.ts";

// Any SGR escape: "\x1b[ ... m"
const ANSI_RE = /\u001b\[[0-9;]*m/;

// Restore the realistic non-TTY default after every case so a forced color
// state can never leak into a sibling test.
afterEach(() => {
	__setColorModeForTest(false);
});

test("no-color: NO_COLOR env at module-init disables all ANSI output", () => {
	const prev = process.env.NO_COLOR;
	process.env.NO_COLOR = "1";
	__resetColorMode(); // replay module-init detection with NO_COLOR set
	try {
		const badge = notificationBadge(5);
		assert.ok(!ANSI_RE.test(badge), `NO_COLOR set but found ANSI escapes: ${JSON.stringify(badge)}`);
		assert.match(badge, /\[5 alerts\]/, "NO_COLOR forces the plain bracketed label");
	} finally {
		if (prev === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = prev;
		__setColorModeForTest(false);
	}
});

test("no-color: non-TTY stdout (the test runner) disables all ANSI output", () => {
	// tsx --test pipes stdout, so process.stdout.isTTY is falsy (false or
	// undefined) → the module already computed colorEnabled=false. __resetColorMode()
	// re-affirms it.
	assert.ok(process.stdout.isTTY !== true, "precondition: test runner stdout is non-TTY");
	delete process.env.NO_COLOR;
	__resetColorMode();

	const badge = notificationBadge(7);
	assert.ok(!ANSI_RE.test(badge), `non-TTY but found ANSI escapes: ${JSON.stringify(badge)}`);
	assert.match(badge, /\[7 alerts\]/, "non-TTY forces the plain bracketed label");
});

test("color mode (forced on): the gate switches notificationBadge to the emoji label", () => {
	__setColorModeForTest(true);

	const badge = notificationBadge(5, { TERM: "xterm-256color" });
	assert.ok(!badge.includes("["), `color mode should use the dot label, got: ${JSON.stringify(badge)}`);
	assert.match(badge, /· 5 alerts/, "color mode renders the ` · N alerts` segment");

	const plain = notificationBadge(5, { TERM: "xterm-256color", NO_COLOR: "1" });
	assert.match(plain, /\[5 alerts\]/, "per-call NO_COLOR still forces the bracketed form");
});

test("no-color mode is consistent across formatters (notificationBadge stays plain)", () => {
	__setColorModeForTest(false);
	const badge = notificationBadge(42, { TERM: "xterm-256color" });
	assert.ok(!ANSI_RE.test(badge), `notificationBadge leaked ANSI in no-color: ${JSON.stringify(badge)}`);
	assert.match(badge, /42 alerts/);
});
