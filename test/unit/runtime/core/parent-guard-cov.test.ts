import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startParentGuard, stopParentGuard } from "../../../../src/runtime/parent-guard.ts";

describe("startParentGuard", () => {
	it("does not throw for pid 0 (returns immediately)", () => {
		// pid 0 is falsy — guard should not start
		assert.doesNotThrow(() => startParentGuard(0));
	});

	it("does not throw for negative pid", () => {
		assert.doesNotThrow(() => startParentGuard(-1));
	});

	it("does not throw for NaN pid", () => {
		assert.doesNotThrow(() => startParentGuard(NaN));
	});

	it("does not throw for Infinity pid", () => {
		assert.doesNotThrow(() => startParentGuard(Infinity));
	});

	it("does not throw for current process pid (self is always alive)", () => {
		// This starts the guard against the current process (which is alive).
		// We must stop it immediately to avoid the interval keeping the process open.
		assert.doesNotThrow(() => startParentGuard(process.pid));
		stopParentGuard();
	});
});

describe("stopParentGuard", () => {
	it("can be called without prior startParentGuard", () => {
		assert.doesNotThrow(() => stopParentGuard());
	});

	it("can be called multiple times safely", () => {
		stopParentGuard();
		stopParentGuard();
		assert.ok(true, "no throw on repeated stop");
	});

	it("stops guard started with current pid", () => {
		startParentGuard(process.pid);
		stopParentGuard();
		// Verify no lingering interval by calling stop again
		assert.doesNotThrow(() => stopParentGuard());
	});
});
