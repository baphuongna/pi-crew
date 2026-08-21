/**
 * Unit tests for the dependency-free dock-footer registry (widget → crew-vibes
 * footer handoff for `widgetPlacement: "bottom"`).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	getFooterDockProvider,
	isFooterDockSinkActive,
	resetFooterDockRegistry,
	setFooterDockProvider,
	setFooterDockSinkActive,
} from "../../../src/ui/dock-footer.ts";

test("registry starts empty: no provider, sink inactive", () => {
	resetFooterDockRegistry();
	assert.equal(getFooterDockProvider(), undefined);
	assert.equal(isFooterDockSinkActive(), false);
});

test("provider round-trips and is cleared by reset", () => {
	resetFooterDockRegistry();
	const provider = (width: number): string[] => [`row @ ${width}`];
	setFooterDockProvider(provider);
	assert.equal(getFooterDockProvider(), provider, "same reference is returned");
	assert.equal(getFooterDockProvider()?.(42).join("|"), "row @ 42");
	resetFooterDockRegistry();
	assert.equal(getFooterDockProvider(), undefined);
});

test("replacing the provider swaps the reference", () => {
	resetFooterDockRegistry();
	const first = (): string[] => ["a"];
	const second = (): string[] => ["b"];
	setFooterDockProvider(first);
	setFooterDockProvider(second);
	assert.equal(getFooterDockProvider(), second);
	assert.equal(getFooterDockProvider()?.(80).join("|"), "b");
});

test("sink flag toggles independently of the provider", () => {
	resetFooterDockRegistry();
	setFooterDockSinkActive(true);
	assert.equal(isFooterDockSinkActive(), true);
	assert.equal(getFooterDockProvider(), undefined, "provider unaffected by sink flag");
	const provider = (): string[] => [];
	setFooterDockProvider(provider);
	setFooterDockSinkActive(false);
	assert.equal(isFooterDockSinkActive(), false);
	assert.equal(getFooterDockProvider(), provider, "sink flag toggle does not drop the provider");
	resetFooterDockRegistry();
});
