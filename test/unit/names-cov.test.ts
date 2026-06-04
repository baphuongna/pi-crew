import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeName, requireString, parseConfigObject, hasOwn } from "../../src/utils/names.ts";

describe("sanitizeName", () => {
	it("lowercases and replaces spaces with hyphens", () => {
		assert.equal(sanitizeName("Hello World"), "hello-world");
	});

	it("strips non-alphanumeric characters except hyphens", () => {
		assert.equal(sanitizeName("foo@bar!baz"), "foobarbaz");
	});

	it("collapses multiple hyphens into one", () => {
		assert.equal(sanitizeName("a---b"), "a-b");
	});

	it("trims leading/trailing hyphens", () => {
		assert.equal(sanitizeName("--hello--"), "hello");
	});

	it("returns 'unnamed' for all-special-character input", () => {
		assert.equal(sanitizeName("@@@!!!"), "unnamed");
	});

	it("returns 'unnamed' for empty string", () => {
		assert.equal(sanitizeName(""), "unnamed");
	});

	it("handles single word", () => {
		assert.equal(sanitizeName("Test"), "test");
	});

	it("handles tabs and newlines as whitespace", () => {
		assert.equal(sanitizeName("hello\tworld\nfoo"), "hello-world-foo");
	});
});

describe("requireString", () => {
	it("returns trimmed value for valid string", () => {
		const result = requireString("  hello  ", "test");
		assert.equal(result.value, "hello");
		assert.equal(result.error, undefined);
	});

	it("returns error for empty string", () => {
		const result = requireString("", "field");
		assert.equal(result.value, undefined);
		assert.ok(result.error);
	});

	it("returns error for whitespace-only string", () => {
		const result = requireString("   ", "field");
		assert.ok(result.error);
	});

	it("returns error for non-string value", () => {
		const result = requireString(42, "field");
		assert.ok(result.error);
		assert.ok(result.error!.includes("non-empty string"));
	});

	it("returns error for null", () => {
		const result = requireString(null, "field");
		assert.ok(result.error);
	});

	it("includes label in error message", () => {
		const result = requireString("", "MyField");
		assert.ok(result.error!.includes("MyField"));
	});
});

describe("parseConfigObject", () => {
	it("parses a valid JSON string into object", () => {
		const result = parseConfigObject('{"a":1}');
		assert.deepEqual(result.value, { a: 1 });
	});

	it("returns object as-is when already an object", () => {
		const obj = { x: 1 };
		const result = parseConfigObject(obj);
		assert.equal(result.value, obj);
	});

	it("returns error for invalid JSON string", () => {
		const result = parseConfigObject("{invalid");
		assert.ok(result.error);
		assert.ok(result.error!.includes("valid JSON"));
	});

	it("returns error for null", () => {
		const result = parseConfigObject(null);
		assert.ok(result.error);
		assert.ok(result.error!.includes("must be an object"));
	});

	it("returns error for array", () => {
		const result = parseConfigObject([1, 2, 3]);
		assert.ok(result.error);
	});

	it("returns error for number", () => {
		const result = parseConfigObject(42);
		assert.ok(result.error);
	});
});

describe("hasOwn", () => {
	it("returns true for own property", () => {
		assert.equal(hasOwn({ a: 1 }, "a"), true);
	});

	it("returns false for missing property", () => {
		assert.equal(hasOwn({ a: 1 }, "b"), false);
	});

	it("returns false for inherited property", () => {
		const obj = Object.create({ inherited: true });
		obj.own = 1;
		assert.equal(hasOwn(obj, "inherited"), false);
		assert.equal(hasOwn(obj, "own"), true);
	});

	it("returns false for undefined own property", () => {
		assert.equal(hasOwn({ a: undefined }, "a"), true);
	});
});
