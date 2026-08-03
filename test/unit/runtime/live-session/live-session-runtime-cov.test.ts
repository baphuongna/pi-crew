import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { probeLiveSessionRuntime } from "../../../../src/runtime/live-session/live-session-runtime.ts";

// Note: runLiveSessionTask requires the @earendil-works/pi-coding-agent package
// and a complex session setup, so we test probeLiveSessionRuntime which is
// the simpler exported function that checks availability.

describe("probeLiveSessionRuntime", () => {
	it("returns an object with 'available' property", async () => {
		const result = await probeLiveSessionRuntime();
		assert.ok(result !== null && result !== undefined);
		assert.ok("available" in result);
		assert.ok("reason" in result);
	});

	it("returns a string reason", async () => {
		const result = await probeLiveSessionRuntime();
		assert.strictEqual(typeof result.reason, "string");
		assert.ok(result.reason.length > 0, "reason should not be empty");
	});

	it("available is boolean", async () => {
		const result = await probeLiveSessionRuntime();
		assert.strictEqual(typeof result.available, "boolean");
	});
});
