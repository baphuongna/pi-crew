import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tryRegisterSessionCleanup } from "../../src/runtime/session-resources.ts";

describe("tryRegisterSessionCleanup", () => {
	it("returns undefined when API is not available", () => {
		const pi = {} as never; // No registerSessionResourceCleanup method
		const result = tryRegisterSessionCleanup(pi, () => {});
		assert.equal(result, undefined);
	});

	it("returns undefined when API is not a function", () => {
		const pi = { registerSessionResourceCleanup: "not-a-function" } as never;
		const result = tryRegisterSessionCleanup(pi, () => {});
		assert.equal(result, undefined);
	});

	it("calls registerSessionResourceCleanup when available", () => {
		let registered = false;
		const pi = {
			registerSessionResourceCleanup: (cleanup: () => void) => {
				registered = true;
				return () => { registered = false; };
			},
		} as never;
		const result = tryRegisterSessionCleanup(pi, () => {});
		assert.equal(registered, true);
		assert.equal(typeof result, "function");
	});

	it("handles API that returns void", () => {
		let registered = false;
		const pi = {
			registerSessionResourceCleanup: () => { registered = true; },
		} as never;
		const result = tryRegisterSessionCleanup(pi, () => {});
		assert.equal(registered, true);
		assert.equal(result, undefined); // void return
	});

	it("handles API that throws", () => {
		const pi = {
			registerSessionResourceCleanup: () => { throw new Error("test error"); },
		} as never;
		const result = tryRegisterSessionCleanup(pi, () => {});
		assert.equal(result, undefined);
	});
});