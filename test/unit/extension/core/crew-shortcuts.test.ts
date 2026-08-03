import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CREW_SHORTCUT_KEYS, registerCrewShortcuts } from "../../../../src/extension/crew-shortcuts.ts";

describe("registerCrewShortcuts", () => {
	it("registers every crew shortcut on a Pi-like object", () => {
		const registered: Array<{ key: unknown; description?: string }> = [];
		const fakePi = {
			registerShortcut: (key: unknown, options: { description?: string }) => {
				registered.push({ key, description: options.description });
			},
		};
		registerCrewShortcuts(fakePi);
		assert.equal(registered.length, CREW_SHORTCUT_KEYS.length);
		// alt+s must be present (settings overlay)
		assert.ok(
			registered.some((r) => r.key === "alt+s"),
			"alt+s shortcut should be registered",
		);
		for (const r of registered) {
			assert.ok(typeof r.description === "string" && r.description.length > 0, "each shortcut needs a description");
		}
	});

	it("is a no-op when registerShortcut is unavailable (older Pi)", () => {
		// Should not throw even with an empty object.
		assert.doesNotThrow(() => registerCrewShortcuts({}));
		assert.doesNotThrow(() => registerCrewShortcuts({ registerShortcut: undefined }));
	});

	it("uses keys that do not collide with Pi's built-in keymap", () => {
		// Pi's built-in alt+ keymap spans BOTH pi-tui editor bindings
		// (TUI_KEYBINDINGS) and pi core app bindings (core/keybindings.js).
		// An earlier revision only checked a partial set and wrongly picked
		// `alt+d`, which collides with `tui.editor.deleteWordForward`.
		// This is the complete occupied alt+ set as of the verified keymaps.
		const piBuiltinAlt = new Set([
			// editor word/delete/navigation (pi-tui)
			"alt+b", // cursor word left
			"alt+f", // cursor word right
			"alt+d", // delete word forward
			"alt+y", // yank pop
			"alt+backspace", // delete word backward
			"alt+delete", // delete word forward (alt)
			// app-level (pi core)
			"alt+v", // paste
			"alt+enter",
			"alt+up",
			"alt+down",
			"alt+left",
			"alt+right",
		]);
		for (const key of CREW_SHORTCUT_KEYS) {
			assert.ok(!piBuiltinAlt.has(key), `crew shortcut ${key} must not collide with a Pi built-in`);
		}
	});

	it("the alt+s handler is an async-friendly function", () => {
		const captured: Array<{ key: unknown; handler: unknown }> = [];
		const fakePi = {
			registerShortcut: (key: unknown, options: { handler: unknown }) => {
				captured.push({ key, handler: options.handler });
			},
		};
		registerCrewShortcuts(fakePi);
		const settingsEntry = captured.find((c) => c.key === "alt+s");
		assert.ok(settingsEntry, "alt+s entry should exist");
		assert.equal(typeof settingsEntry?.handler, "function");
	});
});
