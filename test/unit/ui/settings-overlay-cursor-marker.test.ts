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
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createSettingsOverlay } from "../../../src/ui/settings-overlay.ts";
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
