import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import * as themeAdapter from "../../src/ui/theme-adapter.ts";
import { asCrewTheme, subscribeThemeChange } from "../../src/ui/theme-adapter.ts";

/**
 * PR-F1 regression: theme-adapter must not leak event listeners or polling
 * intervals after dispose, and the dead `thinkingColorForLevel` helper must
 * stay removed.
 *
 * - UI-6: every addEventListener must be paired with a removeEventListener.
 * - UI-11: event-driven objects must not spawn a polling interval; polling
 *   intervals that are unavoidable must be cleared on dispose.
 * - UI-14: `thinkingColorForLevel` had zero callers and was removed.
 */

type Timer = ReturnType<typeof setInterval>;

describe("theme-adapter listener/interval leak (UI-6, UI-11, UI-14)", () => {
	let realSetInterval: typeof globalThis.setInterval;
	let realClearInterval: typeof globalThis.clearInterval;
	let createdTimers: Timer[];
	let clearedTimers: Timer[];

	beforeEach(() => {
		realSetInterval = globalThis.setInterval;
		realClearInterval = globalThis.clearInterval;
		createdTimers = [];
		clearedTimers = [];
		globalThis.setInterval = ((handler: () => void, ms?: number) => {
			const id = realSetInterval(handler, ms);
			createdTimers.push(id);
			return id;
		}) as typeof globalThis.setInterval;
		globalThis.clearInterval = ((id: Timer) => {
			clearedTimers.push(id);
			realClearInterval(id);
		}) as typeof globalThis.clearInterval;
	});

	afterEach(() => {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
	});

	it("UI-6: addEventListener listener is removed via removeEventListener on dispose", () => {
		type Pair = [string, () => void];
		const active: Pair[] = [];
		const theme = {
			addEventListener(type: string, cb: () => void): void {
				active.push([type, cb]);
			},
			removeEventListener(type: string, cb: () => void): void {
				const idx = active.findIndex(([t, c]) => t === type && c === cb);
				if (idx >= 0) active.splice(idx, 1);
			},
			getColorMode(): string {
				return "dark";
			},
		};

		const unsub = subscribeThemeChange(theme, () => {});
		assert.equal(active.length, 1, "listener registered on subscribe");
		assert.equal(active[0][0], "change", "registered for the 'change' event");

		unsub();
		assert.equal(active.length, 0, "removeEventListener paired with addEventListener (UI-6)");
	});

	it("UI-6: the exact listener reference added is the one removed", () => {
		type Pair = [string, () => void];
		const removed: Pair[] = [];
		const theme = {
			_listeners: [] as Pair[],
			addEventListener(this: { _listeners: Pair[] }, type: string, cb: () => void): void {
				this._listeners.push([type, cb]);
			},
			removeEventListener(this: { _listeners: Pair[] }, type: string, cb: () => void): void {
				removed.push([type, cb]);
				this._listeners = this._listeners.filter(([t, c]) => !(t === type && c === cb));
			},
			getColorMode(): string {
				return "dark";
			},
		};

		const unsub = subscribeThemeChange(theme, () => {});
		const registered = theme._listeners[0][1];
		unsub();

		assert.equal(removed.length, 1, "removeEventListener called exactly once");
		assert.equal(removed[0][1], registered, "removed the exact listener ref that was added (UI-6)");
	});

	it("UI-11: event-driven theme does NOT spawn a polling interval", () => {
		const theme = {
			addEventListener(): void {},
			removeEventListener(): void {},
			getColorMode(): string {
				return "dark";
			},
		};

		const unsub = subscribeThemeChange(theme, () => {});
		assert.equal(createdTimers.length, 0, "no polling interval for event-driven theme (UI-11)");
		unsub();
	});

	it("UI-11: polling interval is cleared on dispose for objects without an event API", () => {
		const theme = {
			getColorMode(): string {
				return "dark";
			},
		};

		const unsub = subscribeThemeChange(theme, () => {});
		assert.equal(createdTimers.length, 1, "polling fallback created exactly one interval");

		unsub();
		assert.equal(clearedTimers.length, 1, "polling interval cleared on dispose (UI-11)");
		assert.deepEqual(clearedTimers, createdTimers, "cleared the exact interval that was created");
	});

	it("UI-11: Node EventEmitter-style on/off is used event-driven instead of polling, and off() tears it down (UI-6)", () => {
		type Pair = [string, () => void];
		const listeners: Pair[] = [];
		const theme = {
			on(type: string, cb: () => void): void {
				listeners.push([type, cb]);
			},
			off(type: string, cb: () => void): void {
				const idx = listeners.findIndex(([t, c]) => t === type && c === cb);
				if (idx >= 0) listeners.splice(idx, 1);
			},
			getColorMode(): string {
				return "dark";
			},
		};

		const unsub = subscribeThemeChange(theme, () => {});
		assert.equal(createdTimers.length, 0, "on/off API used instead of polling (UI-11)");
		assert.equal(listeners.length, 1, "on() registered a listener");

		unsub();
		assert.equal(listeners.length, 0, "off() removed the listener on dispose (UI-6)");
	});

	it("UI-14: dead thinkingColorForLevel has been removed", () => {
		assert.equal(
			(themeAdapter as Record<string, unknown>).thinkingColorForLevel,
			undefined,
			"thinkingColorForLevel removed (zero callers; dead code)",
		);
		// Sanity: the module still exports its live surface.
		assert.equal(typeof subscribeThemeChange, "function");
		assert.equal(typeof asCrewTheme, "function");
	});
});
