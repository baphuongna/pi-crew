import assert from "node:assert/strict";
import test from "node:test";
import { findClosestKey, levenshtein, suggestConfigKey } from "../../../src/config/suggestions.ts";

// ---------------------------------------------------------------------------
// levenshtein
// ---------------------------------------------------------------------------

test("levenshtein: identical strings have distance 0", () => {
	assert.equal(levenshtein("", ""), 0);
	assert.equal(levenshtein("abc", "abc"), 0);
});

test("levenshtein: empty vs non-empty equals length of non-empty", () => {
	assert.equal(levenshtein("", "abc"), 3);
	assert.equal(levenshtein("xyz", ""), 3);
});

test("levenshtein: single character operations", () => {
	assert.equal(levenshtein("kitten", "sitting"), 3);
	assert.equal(levenshtein("saturday", "sunday"), 3);
});

test("levenshtein: insertion", () => {
	assert.equal(levenshtein("abc", "abxc"), 1);
});

test("levenshtein: deletion", () => {
	assert.equal(levenshtein("abxc", "abc"), 1);
});

test("levenshtein: substitution", () => {
	assert.equal(levenshtein("abc", "axc"), 1);
});

// ---------------------------------------------------------------------------
// findClosestKey
// ---------------------------------------------------------------------------

const VALID_KEYS = [
	"asyncByDefault",
	"executeWorkers",
	"notifierIntervalMs",
	"limits",
	"runtime",
	"autonomous",
	"concurrency",
	"maxConcurrentWorkers",
] as const;

test("findClosestKey: exact match returns the key", () => {
	assert.equal(findClosestKey("runtime", VALID_KEYS), "runtime");
});

test("findClosestKey: typo returns closest match", () => {
	assert.equal(findClosestKey("runime", VALID_KEYS), "runtime");
	assert.equal(findClosestKey("concucrency", VALID_KEYS), "concurrency");
});

test("findClosestKey: returns null when nothing is close enough", () => {
	assert.equal(findClosestKey("zzzzzzzzzzz", VALID_KEYS), null);
});

test("findClosestKey: case-insensitive matching", () => {
	assert.equal(findClosestKey("RUNTIME", VALID_KEYS), "runtime");
	assert.equal(findClosestKey("AsyncByDefault", VALID_KEYS), "asyncByDefault");
});

test("findClosestKey: empty valid keys returns null", () => {
	assert.equal(findClosestKey("anything", []), null);
});

test("findClosestKey: respects custom maxDistance", () => {
	// "runtim" is distance 1 from "runtime"
	assert.equal(findClosestKey("runtim", VALID_KEYS, 0), null);
	assert.equal(findClosestKey("runtim", VALID_KEYS, 1), "runtime");
});

// ---------------------------------------------------------------------------
// suggestConfigKey (convenience wrapper)
// ---------------------------------------------------------------------------

test("suggestConfigKey: delegates to findClosestKey", () => {
	assert.equal(suggestConfigKey("excecuteWorkers", VALID_KEYS), "executeWorkers");
	assert.equal(suggestConfigKey("total_garbage_xyz", VALID_KEYS), null);
});
