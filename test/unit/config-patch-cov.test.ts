import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeObject, autonomousPatchFromConfig, configPatchFromConfig, effectiveRunConfig, formatAutonomyStatus } from "../../src/extension/team-tool/config-patch.ts";

describe("sanitizeObject", () => {
	it("strips __proto__ keys from null-prototype objects", () => {
		const obj = Object.create(null);
		obj.__proto__ = "bad";
		obj.safe = "yes";
		const result = sanitizeObject(obj) as Record<string, unknown>;
		assert.equal(Object.keys(result).includes("__proto__"), false);
		assert.equal(result.safe, "yes");
	});

	it("strips constructor keys", () => {
		const obj = Object.create(null);
		obj.constructor = "oops";
		obj.name = "test";
		const result = sanitizeObject(obj) as Record<string, unknown>;
		assert.equal(Object.keys(result).includes("constructor"), false);
		assert.equal(result.name, "test");
	});

	it("strips prototype keys", () => {
		const obj = Object.create(null);
		obj.prototype = "bad";
		obj.value = 1;
		const result = sanitizeObject(obj) as Record<string, unknown>;
		assert.equal(Object.keys(result).includes("prototype"), false);
		assert.equal(result.value, 1);
	});

	it("recursively sanitizes nested objects", () => {
		const inner = Object.create(null);
		inner.__proto__ = "bad";
		inner.inner = true;
		const obj = { outer: inner };
		const result = sanitizeObject(obj) as Record<string, unknown>;
		const outer = result.outer as Record<string, unknown>;
		assert.equal(Object.keys(outer).includes("__proto__"), false);
		assert.equal(outer.inner, true);
	});

	it("passes through null and undefined unchanged", () => {
		assert.equal(sanitizeObject(null), null);
		assert.equal(sanitizeObject(undefined), undefined);
	});

	it("passes through primitives unchanged", () => {
		assert.equal(sanitizeObject("hello"), "hello");
		assert.equal(sanitizeObject(42), 42);
		assert.equal(sanitizeObject(true), true);
	});

	it("sanitizes arrays recursively", () => {
		const inner = Object.create(null);
		inner.__proto__ = "bad";
		inner.ok = true;
		const result = sanitizeObject([inner]) as Record<string, unknown>[];
		assert.ok(Array.isArray(result));
		assert.equal(Object.keys(result[0]).includes("__proto__"), false);
		assert.equal(result[0].ok, true);
	});

	it("preserves safe keys", () => {
		const input = { a: 1, b: "two", c: [3], d: { e: 4 } };
		assert.deepEqual(sanitizeObject(input), input);
	});
});

describe("autonomousPatchFromConfig", () => {
	it("returns autonomous config from root-level config with valid profile", () => {
		const result = autonomousPatchFromConfig({ autonomous: { profile: "assisted", enabled: true } });
		assert.equal(result.profile, "assisted");
		assert.equal(result.enabled, true);
	});

	it("returns empty-ish config for undefined input", () => {
		const result = autonomousPatchFromConfig(undefined);
		assert.equal(result.profile, undefined);
	});

	it("returns empty-ish config for null input", () => {
		const result = autonomousPatchFromConfig(null);
		assert.equal(result.profile, undefined);
	});

	it("returns empty-ish config for empty object", () => {
		const result = autonomousPatchFromConfig({});
		assert.equal(result.profile, undefined);
	});
});

describe("configPatchFromConfig", () => {
	it("returns parsed config with valid limits", () => {
		const result = configPatchFromConfig({ limits: { maxConcurrentWorkers: 5 } });
		assert.ok(result);
		assert.equal(result.limits?.maxConcurrentWorkers, 5);
	});

	it("returns default config for undefined", () => {
		const result = configPatchFromConfig(undefined);
		assert.ok(result);
		assert.equal(typeof result, "object");
	});

	it("returns default config for null", () => {
		const result = configPatchFromConfig(null);
		assert.ok(result);
	});
});

describe("effectiveRunConfig", () => {
	it("merges limits from override", () => {
		const base = configPatchFromConfig({ limits: { maxConcurrentWorkers: 1 } });
		const result = effectiveRunConfig(base, { limits: { maxConcurrentWorkers: 5 } });
		assert.equal(result.limits?.maxConcurrentWorkers, 5);
	});

	it("preserves base limits when override only touches runtime", () => {
		const base = configPatchFromConfig({ limits: { maxConcurrentWorkers: 3 } });
		const result = effectiveRunConfig(base, { runtime: { mode: "sync" } });
		assert.equal(result.limits?.maxConcurrentWorkers, 3);
	});

	it("preserves base when override is empty", () => {
		const base = configPatchFromConfig({ limits: { maxConcurrentWorkers: 3 } });
		const result = effectiveRunConfig(base, {});
		assert.equal(result.limits?.maxConcurrentWorkers, 3);
	});

	it("handles undefined override by keeping base", () => {
		const base = configPatchFromConfig({ limits: { maxConcurrentWorkers: 3 } });
		const result = effectiveRunConfig(base, undefined);
		assert.equal(result.limits?.maxConcurrentWorkers, 3);
	});

	it("strips dangerous keys from override before merging", () => {
		const obj: Record<string, unknown> = {};
		obj.__proto__ = "bad";
		obj.limits = { maxConcurrentWorkers: 10 };
		const base = configPatchFromConfig({});
		const result = effectiveRunConfig(base, obj as any);
		assert.equal(result.limits?.maxConcurrentWorkers, 10);
	});
});

describe("formatAutonomyStatus", () => {
	it("formats updated status message with path", () => {
		const msg = formatAutonomyStatus({ profile: "assisted", enabled: true, injectPolicy: true, preferAsyncForLongTasks: false, allowWorktreeSuggestion: false }, "/path/to/config", true);
		assert.ok(msg.includes("Updated"));
		assert.ok(msg.includes("/path/to/config"));
		assert.ok(msg.includes("assisted"));
	});

	it("formats read-only status message", () => {
		const msg = formatAutonomyStatus({ profile: "manual", enabled: false, injectPolicy: false, preferAsyncForLongTasks: false, allowWorktreeSuggestion: false }, "/other", false);
		assert.ok(msg.includes("autonomous mode:"));
		assert.ok(msg.includes("/other"));
	});

	it("handles undefined config", () => {
		const msg = formatAutonomyStatus(undefined, "/default", false);
		assert.ok(msg.includes("/default"));
		assert.ok(msg.includes("autonomous mode:"));
	});
});
