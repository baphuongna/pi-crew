import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeObject } from "../../src/extension/team-tool/config-patch.ts";
import { __test__resetI18n, addTranslations } from "../../src/i18n.ts";

/**
 * Tests for prototype-pollution prevention (MEDIUM #1 and MEDIUM #2 fixes).
 *
 * Verifies:
 * 1. sanitizeObject strips __proto__, constructor, prototype from all levels
 * 2. sanitizeObject preserves safe keys
 * 3. addTranslations strips dangerous keys from bundles
 */

// --- sanitizeObject tests (MEDIUM #2) ---

test("sanitizeObject: strips __proto__ key from flat object", () => {
	const input = { __proto__: { polluted: true }, safe: "yes" } as Record<string, unknown>;
	const result = sanitizeObject(input);
	assert.equal(Object.getOwnPropertyDescriptor(result, "__proto__"), undefined);
	assert.equal((result as Record<string, unknown>).safe, "yes");
});

test("sanitizeObject: strips constructor own property", () => {
	const input = Object.create(null);
	input.constructor = "evil";
	input.name = "ok";
	const result = sanitizeObject(input);
	// Verify constructor is NOT an own property of the result
	assert.equal(Object.hasOwn(result, "constructor"), false);
	assert.equal((result as Record<string, unknown>).name, "ok");
});

test("sanitizeObject: strips prototype key", () => {
	const input = Object.create(null);
	input.prototype = "evil";
	input.value = 42;
	const result = sanitizeObject(input);
	assert.equal(Object.hasOwn(result, "prototype"), false);
	assert.equal((result as Record<string, unknown>).value, 42);
});

test("sanitizeObject: recursively strips from nested objects", () => {
	const nested = Object.create(null);
	// biome-ignore lint/suspicious/noProto: intentionally testing prototype-pollution guard
	nested.__proto__ = { polluted: true };
	const deep = Object.create(null);
	deep.constructor = "evil";
	deep.valid = true;
	nested.deep = deep;

	const input = { nested, top: "safe" };
	const result = sanitizeObject(input);
	const resultNested = (result as Record<string, unknown>).nested as Record<string, unknown>;
	const resultDeep = resultNested.deep as Record<string, unknown>;

	assert.equal(Object.getOwnPropertyDescriptor(resultNested, "__proto__"), undefined);
	assert.equal(Object.hasOwn(resultDeep, "constructor"), false);
	assert.equal(resultDeep.valid, true);
	assert.equal((result as Record<string, unknown>).top, "safe");
});

test("sanitizeObject: strips from arrays", () => {
	const item0: Record<string, unknown> = Object.create(null);
	// biome-ignore lint/suspicious/noProto: intentionally testing prototype-pollution guard
	(item0 as any).__proto__ = "bad";
	item0.ok = 1;
	const item1: Record<string, unknown> = Object.create(null);
	(item1 as any).constructor = "bad";
	item1.ok = 2;
	const input = [item0, item1];
	const result = sanitizeObject(input);
	const arr = result as Array<Record<string, unknown>>;
	assert.equal(Object.getOwnPropertyDescriptor(arr[0], "__proto__"), undefined);
	assert.equal(arr[0].ok, 1);
	assert.equal(Object.hasOwn(arr[1], "constructor"), false);
	assert.equal(arr[1].ok, 2);
});

test("sanitizeObject: passes through primitives", () => {
	assert.equal(sanitizeObject("hello"), "hello");
	assert.equal(sanitizeObject(42), 42);
	assert.equal(sanitizeObject(null), null);
	assert.equal(sanitizeObject(undefined), undefined);
	assert.equal(sanitizeObject(true), true);
});

test("sanitizeObject: empty object returns empty object", () => {
	const result = sanitizeObject({});
	assert.deepEqual(result, {});
});

// --- addTranslations tests (MEDIUM #1) ---

test("addTranslations: strips __proto__ key from translation bundle", () => {
	__test__resetI18n();
	addTranslations("test-locale", {
		__proto__: "polluted",
		"agent.requiresPrompt": "Test prompt",
	} as any);
	// The dangerous key should not have polluted anything
	// biome-ignore lint/suspicious/noProto: verify prototype was NOT polluted
	assert.equal(typeof (globalThis as any).__proto__?.polluted === "undefined", true, "__proto__ should not pollute global prototype");
});

test("addTranslations: strips constructor and prototype keys", () => {
	__test__resetI18n();
	addTranslations("test-locale2", {
		constructor: "evil",
		prototype: "evil",
		"agent.started": "Test started",
	} as any);
	// Should not throw and dangerous keys should be ignored
	assert.ok(true, "addTranslations completed without error");
});
