/**
 * UI-12: Basic coverage for src/ui/settings-overlay.ts.
 *
 * The overlay is built via the `createSettingsOverlay` factory which returns
 * `{ overlay, component }` (component === overlay). The overlay implements the
 * Pi focusable contract (`focused`), `invalidate()`, `render(width)`, and
 * `handleInput(data)`. These tests exercise construct/render, the tab bar,
 * item navigation, boolean toggling, the enum/number/agent submenus, and the
 * action (Pi theme) dispatch path.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSettingsOverlay } from "../../src/ui/settings-overlay.ts";
import type { CrewTheme } from "../../src/ui/theme-adapter.ts";

// No-op theme: fg/bold/inverse return text unchanged so render output is plain
// and assertions are deterministic (we assert on content, not styling).
const theme: CrewTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	inverse: (text) => text,
};

/** Flatten rendered lines for substring assertions. */
function rendered(overlay: { render(w: number): string[] }, width = 80): string {
	return overlay.render(width).join("\n");
}

test("createSettingsOverlay returns overlay+component with focused defaulting false", () => {
	const { overlay, component } = createSettingsOverlay({}, theme, () => {}, () => {});
	assert.equal(component, overlay);
	assert.equal(overlay.focused, false);
	assert.equal(typeof overlay.render, "function");
	assert.equal(typeof overlay.handleInput, "function");
	assert.equal(typeof overlay.invalidate, "function");
});

test("render draws the title, tab bar, the first runtime setting, and the hint", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	const out = rendered(overlay);
	assert.ok(out.includes("pi-crew Settings"));
	assert.ok(out.includes("Runtime")); // tab label
	assert.ok(out.includes("Runtime Mode")); // first setting label on runtime tab
	assert.ok(out.includes("Navigate")); // keybind hint
});

test("invalidate is safe to call with no submenu open", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	assert.doesNotThrow(() => overlay.invalidate());
});

test("Escape and q both trigger onClose (done)", () => {
	let closes = 0;
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => closes++);
	overlay.handleInput("\u001b"); // escape
	overlay.handleInput("q");
	assert.equal(closes, 2);
});

test("Tab advances to the next tab (runtime -> limits) and resets selection", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	assert.ok(rendered(overlay).includes("How workers execute")); // runtime.mode description
	overlay.handleInput("\t");
	const out = rendered(overlay);
	assert.ok(out.includes("Max Concurrent")); // limits.maxConcurrentWorkers label
	assert.ok(out.includes("workers running simultaneously"));
});

test("shift+tab wraps back to the last tab (runtime -> advanced)", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	overlay.handleInput("\u001b[Z"); // backtab
	assert.ok(rendered(overlay).includes("Execute Workers")); // advanced first setting
});

test("down/up moves the selection and updates the description line", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	overlay.handleInput("\u001b[B"); // down -> index 1 (Max Turns)
	assert.ok(rendered(overlay).includes("Maximum agent turns"));
	overlay.handleInput("\u001b[A"); // up -> back to index 0
	assert.ok(rendered(overlay).includes("How workers execute"));
});

test("Enter on a boolean setting toggles the value and fires onChange each time", () => {
	const changes: Array<[string, unknown]> = [];
	const { overlay } = createSettingsOverlay({}, theme, (id, value) => changes.push([id, value]), () => {});
	// runtime(0) limits(1) agents(2) ui(3) themes(4) autonomous(5)
	for (let i = 0; i < 5; i++) overlay.handleInput("\t");
	assert.ok(rendered(overlay).includes("Enable autonomous pi-crew delegation"));
	overlay.handleInput("\r"); // undefined !== true -> true
	overlay.handleInput("\r"); // true !== true -> false
	assert.deepEqual(changes, [
		["autonomous.enabled", true],
		["autonomous.enabled", false],
	]);
});

test("Enter on an enum setting opens the select submenu; Esc cancels back to the list", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	overlay.handleInput("\r"); // runtime.mode (enum) -> open submenu
	let out = rendered(overlay);
	assert.ok(out.includes("Enter to select")); // submenu hint
	assert.ok(out.includes("Esc to go back"));
	overlay.handleInput("\u001b"); // cancel submenu (must NOT close overlay)
	out = rendered(overlay);
	assert.ok(!out.includes("Enter to select"));
	assert.ok(out.includes("Runtime Mode")); // back on the settings list
});

test("number submenu: typing digits + Enter fires onChange with a number", () => {
	const changes: Array<[string, unknown]> = [];
	const { overlay } = createSettingsOverlay({}, theme, (id, value) => changes.push([id, value]), () => {});
	overlay.handleInput("\u001b[B"); // down -> Max Turns (number)
	overlay.handleInput("\r"); // open text input
	overlay.handleInput("5");
	overlay.handleInput("2");
	overlay.handleInput("\r"); // submit -> 52
	assert.deepEqual(changes, [["runtime.maxTurns", 52]]);
});

test("number submenu: submitting an empty buffer unsets the value (onChange undefined)", () => {
	const changes: Array<[string, unknown]> = [];
	const { overlay } = createSettingsOverlay({}, theme, (id, value) => changes.push([id, value]), () => {});
	overlay.handleInput("\u001b[B"); // Max Turns
	overlay.handleInput("\r"); // open
	overlay.handleInput("\r"); // submit empty
	assert.deepEqual(changes, [["runtime.maxTurns", undefined]]);
});

test("number submenu: Esc cancels without firing onChange", () => {
	const changes: Array<[string, unknown]> = [];
	const { overlay } = createSettingsOverlay({}, theme, (id, value) => changes.push([id, value]), () => {});
	overlay.handleInput("\u001b[B"); // Max Turns
	overlay.handleInput("\r"); // open
	overlay.handleInput("9");
	overlay.handleInput("\u001b"); // cancel
	assert.deepEqual(changes, []);
	assert.ok(rendered(overlay).includes("Max Turns")); // back on list
});

test("agent overrides submenu opens and Esc cancels", () => {
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {});
	overlay.handleInput("\t"); // limits
	overlay.handleInput("\t"); // agents
	overlay.handleInput("\r"); // open agent overrides submenu
	assert.ok(rendered(overlay).includes("edit thinking")); // submenu hint
	overlay.handleInput("\u001b"); // cancel
	assert.ok(!rendered(overlay).includes("edit thinking"));
});

test("action setting (Pi theme) dispatches onAction with the action id and chosen value", () => {
	const actions: Array<[string, unknown]> = [];
	const { overlay } = createSettingsOverlay({}, theme, () => {}, () => {}, (a, v) => actions.push([a, v]));
	// runtime(0) limits(1) agents(2) ui(3) themes(4)
	for (let i = 0; i < 4; i++) overlay.handleInput("\t");
	overlay.handleInput("\r"); // open theme select submenu
	overlay.handleInput("\r"); // select current option
	assert.equal(actions.length, 1);
	assert.equal(actions[0][0], "piTheme");
	assert.equal(typeof actions[0][1], "string");
});

test("explicitly-set config values render without a (default) suffix", () => {
	const { overlay } = createSettingsOverlay({ runtime: { maxTurns: 7 } }, theme, () => {}, () => {});
	const out = rendered(overlay);
	assert.ok(out.includes("7")); // value flowed through formatValue
	assert.ok(!out.includes("10000")); // the EFFECTIVE_DEFAULTS value is suppressed
});
