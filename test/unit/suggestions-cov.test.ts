import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	levenshtein,
	findClosestKey,
	suggestConfigKey,
} from "../../src/config/suggestions.ts";

describe("levenshtein", () => {
	it("returns 0 for identical single-char strings", () => {
		assert.equal(levenshtein("a", "a"), 0);
	});

	it("returns 1 for single substitution", () => {
		assert.equal(levenshtein("a", "b"), 1);
	});

	it("computes distance for completely different strings", () => {
		assert.equal(levenshtein("abc", "xyz"), 3);
	});

	it("handles symmetric distances", () => {
		assert.equal(levenshtein("foo", "bar"), levenshtein("bar", "foo"));
	});

	it("handles unicode strings", () => {
		assert.equal(levenshtein("café", "cafe"), 1);
	});

	it("handles strings with spaces", () => {
		assert.equal(levenshtein("hello world", "hello"), 6);
	});

	it("returns length when one string is empty", () => {
		assert.equal(levenshtein("", "abcdef"), 6);
		assert.equal(levenshtein("abcdef", ""), 6);
	});
});

describe("findClosestKey", () => {
	const keys = ["asyncByDefault", "executeWorkers", "limits", "runtime", "agents", "tools"] as const;

	it("finds exact match", () => {
		assert.equal(findClosestKey("limits", keys), "limits");
	});

	it("finds closest match for 1-char typo", () => {
		assert.equal(findClosestKey("agnts", keys), "agents");
	});

	it("returns null when distance exceeds maxDistance", () => {
		assert.equal(findClosestKey("zzzzzzz", keys), null);
	});

	it("uses default maxDistance of 3", () => {
		// "asyncByDefalt" is distance 1 from "asyncByDefault" (missing 'u')
		assert.equal(findClosestKey("asyncByDefalt", keys), "asyncByDefault");
	});

	it("respects custom maxDistance of 0 (exact only)", () => {
		assert.equal(findClosestKey("asyncByDefalt", keys, 0), null);
		assert.equal(findClosestKey("limits", keys, 0), "limits");
	});

	it("returns null for empty valid keys array", () => {
		assert.equal(findClosestKey("anything", []), null);
	});

	it("is case-insensitive", () => {
		assert.equal(findClosestKey("LIMITS", keys), "limits");
		assert.equal(findClosestKey("limits", keys), "limits");
	});

	it("picks closest among multiple candidates", () => {
		// "tols" is closer to "tools" (d=1) than "tools" vs others
		assert.equal(findClosestKey("tols", keys), "tools");
	});
});

describe("suggestConfigKey", () => {
	it("delegates to findClosestKey for known keys", () => {
		const keys = ["asyncByDefault", "executeWorkers"] as const;
		assert.equal(suggestConfigKey("executeWorkrs", keys), "executeWorkers");
	});

	it("returns null for unrecognizable input", () => {
		const keys = ["abc"] as const;
		assert.equal(suggestConfigKey("zzzzzzz", keys), null);
	});

	it("returns exact match without modification", () => {
		const keys = ["myKey"] as const;
		assert.equal(suggestConfigKey("myKey", keys), "myKey");
	});
});
