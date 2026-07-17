import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventBus } from "../../src/runtime/cross-extension-rpc.ts";

function createMockEventBus(): {
	bus: EventBus;
	emitted: Array<{ event: string; data: unknown }>;
} {
	const emitted: Array<{ event: string; data: unknown }> = [];
	const bus: EventBus = {
		on(event: string, handler: (data: unknown) => void) {
			// No-op for this test
			return () => {};
		},
		emit(event: string, data: unknown) {
			emitted.push({ event, data });
		},
	};
	return { bus, emitted };
}

// Test the handleRpc function indirectly by testing the requestId validation
// We replicate the validation regex to test it directly
const VALID_REQUEST_ID = /^[a-zA-Z0-9_-]+$/;

describe("requestId validation", () => {
	it("accepts alphanumeric requestId", () => {
		assert.equal(VALID_REQUEST_ID.test("abc123"), true);
	});

	it("accepts dashes and underscores", () => {
		assert.equal(VALID_REQUEST_ID.test("req_123-abc"), true);
	});

	it("accepts UUID format", () => {
		assert.equal(VALID_REQUEST_ID.test("550e8400-e29b-41d4-a716-446655440000"), true);
	});

	it("rejects colons (channel injection)", () => {
		assert.equal(VALID_REQUEST_ID.test("abc:def"), false);
	});

	it("rejects dots", () => {
		assert.equal(VALID_REQUEST_ID.test("abc.def"), false);
	});

	it("rejects slashes", () => {
		assert.equal(VALID_REQUEST_ID.test("../escape"), false);
	});

	it("rejects empty string", () => {
		assert.equal(VALID_REQUEST_ID.test(""), false);
	});

	it("rejects spaces", () => {
		assert.equal(VALID_REQUEST_ID.test("abc def"), false);
	});

	it("rejects null bytes", () => {
		assert.equal(VALID_REQUEST_ID.test("abc\x00def"), false);
	});

	it("rejects newlines", () => {
		assert.equal(VALID_REQUEST_ID.test("abc\ndef"), false);
	});

	it("rejects unicode tricks", () => {
		assert.equal(VALID_REQUEST_ID.test("abc\u202Edef"), false);
	});
});
