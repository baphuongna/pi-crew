/**
 * R3-6 (2026-10-04): pi-tui CURSOR_MARKER on hand-written text inputs.
 *
 * The settings overlay owns TWO hand-rolled text buffers that never went
 * through pi-tui's editor: the TextinputSubmenu (number/string settings) and
 * the AgentOverridesSubmenu model/thinking editor. Both render a fake `█`
 * block cursor at the buffer end. R3-6 prepends pi-tui's zero-width
 * CURSOR_MARKER (APC `ESC _ pi:c BEL`) so the host TUI parks the HARDWARE
 * cursor there — anchoring the IME candidate window for CJK input — exactly
 * like pi-tui's own Input component (marker + fake cursor char).
 *
 * Driven end-to-end through the public SettingsOverlay surface (keyOf-based
 * handleInput), not the private submenu classes.
 *
 * L8 (2026-10-07 real-test review, policy W4/G22): both consumers
 * (settings-overlay.ts, overlays/mailbox-compose-overlay.ts) now resolve the
 * marker DEFENSIVELY from a pi-tui namespace import (typeof-guard, fallback ""),
 * modeled on hyperlink() at widget/widget-renderer.ts:118-128 — a host whose
 * pi-tui build lacks the export must render instead of failing the named
 * import at link time. The tests below pin BOTH branches: real-export emission
 * (end-to-end render) and the missing-export fallback (resolver units).
 */

import assert from "node:assert/strict";
import test from "node:test";
import * as piTui from "@earendil-works/pi-tui";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { MailboxComposeOverlay, resolveCursorMarker } from "../../../src/ui/overlays/mailbox-compose-overlay.ts";
import { createSettingsOverlay, resolveCursorMarker as resolveSettingsCursorMarker } from "../../../src/ui/settings-overlay.ts";
import { asCrewTheme } from "../../../src/ui/theme-adapter.ts";
import { visibleWidth } from "../../../src/utils/visual.ts";

const theme = asCrewTheme({});

function makeOverlay(): ReturnType<typeof createSettingsOverlay> {
	return createSettingsOverlay(
		{},
		theme,
		() => undefined,
		() => undefined,
	);
}

test("R3-6: settings text input emits CURSOR_MARKER before the fake █ cursor", () => {
	const { overlay } = makeOverlay();
	// Runtime tab (0), index 1 = runtime.maxTurns (type number) → TextinputSubmenu.
	overlay.handleInput("j");
	overlay.handleInput("\r");
	const lines = overlay.render(100);
	const bufferRow = lines.find((line) => line.includes("█"));
	assert.ok(bufferRow, "text input buffer row rendered");
	assert.ok(bufferRow.includes(`${CURSOR_MARKER}█`), `marker must precede the fake cursor, got ${JSON.stringify(bufferRow)}`);
	// Zero-width under pi-tui's width model (APC stripped by visibleWidth).
	assert.equal(visibleWidth(bufferRow), visibleWidth(bufferRow.replaceAll(CURSOR_MARKER, "")));
	// Exactly one anchor per frame.
	assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
	// Typing shifts the marker with the buffer end.
	overlay.handleInput("5");
	overlay.handleInput("0");
	const typed = overlay.render(100).find((line) => line.includes("█"));
	assert.ok(typed?.includes(`50${CURSOR_MARKER}█`), `marker follows the buffer end, got ${JSON.stringify(typed)}`);
});

test("R3-6: agent-override model editor emits CURSOR_MARKER before the fake █ cursor", () => {
	const { overlay } = makeOverlay();
	// runtime(0) → limits(1) → agents(2); agents tab index 0 = agents.overrides.
	overlay.handleInput("\t");
	overlay.handleInput("\t");
	overlay.handleInput("\r");
	// First enter opens the model edit buffer.
	overlay.handleInput("\r");
	const lines = overlay.render(100);
	const editRow = lines.find((line) => line.includes("█"));
	assert.ok(editRow, "edit buffer row rendered");
	assert.ok(editRow.includes(`${CURSOR_MARKER}█`), `marker must precede the fake cursor, got ${JSON.stringify(editRow)}`);
	assert.equal(visibleWidth(editRow), visibleWidth(editRow.replaceAll(CURSOR_MARKER, "")));
	assert.equal(lines.filter((line) => line.includes(CURSOR_MARKER)).length, 1);
});

test("R3-6: settings menu rows (list selection) emit NO marker — `›` is navigation, not a text cursor", () => {
	const { overlay } = makeOverlay();
	const lines = overlay.render(100);
	assert.ok(
		lines.some((line) => line.includes("›")),
		"selection glyph present on the focused row",
	);
	assert.ok(
		lines.every((line) => !line.includes(CURSOR_MARKER)),
		"no marker outside text inputs",
	);
});

test("R3-6+L8: mailbox compose overlay emits CURSOR_MARKER at the ACTIVE field's value end", () => {
	const overlay = new MailboxComposeOverlay({ done: () => undefined });
	const lines = overlay.render(80);
	// activeField defaults to 1 ("to") — exactly one row carries the marker.
	const marked = lines.filter((line) => line.includes(CURSOR_MARKER));
	assert.equal(marked.length, 1, `exactly one marked row, got ${JSON.stringify(lines)}`);
	assert.ok(marked[0]?.includes("to:"), "marker sits on the active field row");
	assert.ok(
		(marked[0]?.indexOf(CURSOR_MARKER) ?? -1) > (marked[0]?.indexOf("to:") ?? -1),
		"marker rides after the active field's value (IME anchor at the text-cursor end)",
	);
	assert.equal(visibleWidth(marked[0]), visibleWidth(marked[0].replaceAll(CURSOR_MARKER, "")), "marker is zero-width");
	// Tab cycles the active field — the marker must follow it.
	overlay.handleInput("\t");
	const cycled = overlay.render(80).filter((line) => line.includes(CURSOR_MARKER));
	assert.equal(cycled.length, 1, "still exactly one marker after cycling");
	assert.ok(!cycled[0]?.includes("to:"), "marker moved off the previous field");
});

test("L8: resolveCursorMarker returns pi-tui's marker when the export exists (emission branch)", () => {
	// The real namespace — proves the typeof-guard picks up the genuine export
	// in BOTH defensive consumers, so rendered output is byte-identical to the
	// old named-import behavior on healthy hosts.
	assert.equal(resolveSettingsCursorMarker(piTui), CURSOR_MARKER);
	assert.equal(resolveCursorMarker(piTui), CURSOR_MARKER);
});

test('L8: resolveCursorMarker falls back to "" when the host\'s pi-tui lacks the export (W4/G22)', () => {
	// Missing export entirely.
	assert.equal(resolveSettingsCursorMarker({}), "");
	assert.equal(resolveCursorMarker({}), "");
	// Wrong-shaped exports are contract drift, not a marker — never emit them.
	assert.equal(resolveSettingsCursorMarker({ CURSOR_MARKER: null }), "");
	assert.equal(resolveSettingsCursorMarker({ CURSOR_MARKER: 7 }), "");
	assert.equal(resolveCursorMarker({ CURSOR_MARKER: { not: "a string" } }), "");
	// A genuine string export passes through untouched (mutation guard for the
	// typeof check itself — not just the missing-key branch).
	assert.equal(resolveSettingsCursorMarker({ CURSOR_MARKER: "X" }), "X");
	assert.equal(resolveCursorMarker({ CURSOR_MARKER: "X" }), "X");
});
