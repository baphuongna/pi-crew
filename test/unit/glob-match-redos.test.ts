import assert from "node:assert/strict";
import test from "node:test";

/**
 * Tests for the hardened globMatch function (MEDIUM #4 fix).
 *
 * Imports the real implementation from `src/utils/glob-match.ts` (extracted
 * from `src/extension/team-tool/api.ts` on 2026-08-10 so this regression suite
 * exercises the shipped function rather than a stale inline copy).
 */

import { globMatch } from "../../src/utils/glob-match.ts";

test("globMatch: basic wildcard matches any non-slash chars", () => {
	assert.equal(globMatch("foo", "*"), true);
	assert.equal(globMatch("bar", "*"), true);
	assert.equal(globMatch("foo/bar", "*"), false); // * does not cross /
});

test("globMatch: path-safe * does not match path separator", () => {
	assert.equal(globMatch("src/index.ts", "*.ts"), false);
	assert.equal(globMatch("index.ts", "*.ts"), true);
	assert.equal(globMatch("src/utils/helpers.ts", "src/*.ts"), false);
});

test("globMatch: ? matches single non-slash char", () => {
	assert.equal(globMatch("a", "?"), true);
	assert.equal(globMatch("ab", "?"), false);
	assert.equal(globMatch("a/b", "?/?"), true); // ? matches a and b, / matches /
	assert.equal(globMatch("a/b", "?"), false); // single ? can't match two chars + /
});

test("globMatch: exact match without wildcards", () => {
	assert.equal(globMatch("hello", "hello"), true);
	assert.equal(globMatch("hello", "world"), false);
});

test("globMatch: combined * and ?", () => {
	assert.equal(globMatch("test.ts", "*.?s"), true);
	assert.equal(globMatch("test.js", "*.?s"), true);
	assert.equal(globMatch("test.txt", "*.?s"), false);
});

test("globMatch: regex special chars in pattern are escaped", () => {
	assert.equal(globMatch("file.name", "file.name"), true);
	assert.equal(globMatch("filename", "file.name"), false);
	assert.equal(globMatch("file+extra", "file+extra"), true);
	assert.equal(globMatch("fileextra", "file+extra"), false);
	assert.equal(globMatch("a$b", "a$b"), true);
	assert.equal(globMatch("a(b)", "a(b)"), true);
	assert.equal(globMatch("a[b]", "a[b]"), true);
});

test("globMatch: ReDoS pattern rejected via max length check", () => {
	// Patterns over 200 chars are rejected outright — prevents crafted ReDoS payloads
	const longPattern = "a".repeat(201);
	assert.equal(globMatch("anything", longPattern), false);
	// 200 chars is still allowed
	const maxPattern = "a".repeat(200);
	// This won't match but should not error
	assert.equal(globMatch("anything", maxPattern), false);
});

test("globMatch: no ReDoS with old .* conversion (verified path-safe)", () => {
	// The old globMatch used .* which allowed catastrophic backtracking.
	// The new version uses [^/]* which limits matching to non-slash chars.
	// Verify that * cannot cross path boundaries:
	const text = "foo/bar/baz/qux";
	// With old .* conversion: * would match "foo/bar/baz/qux"
	// With new [^/]* conversion: * only matches "foo"
	assert.equal(globMatch(text, "*"), false);
	assert.equal(globMatch(text, "*/*"), false);
	assert.equal(globMatch(text, "*/*/*/*"), true);
	// Ensure the match is deterministic and fast
	const start = Date.now();
	for (let i = 0; i < 1000; i++) {
		globMatch(text, "*/*/*/*");
	}
	const elapsed = Date.now() - start;
	assert.ok(elapsed < 200, `1000 iterations took ${elapsed}ms — possible ReDoS`);
});

test("globMatch: empty pattern matches empty string", () => {
	assert.equal(globMatch("", ""), true);
	assert.equal(globMatch("a", ""), false);
});

test("globMatch: path segments with *", () => {
	assert.equal(globMatch("src/test.ts", "src/*"), true);
	assert.equal(globMatch("src/sub/test.ts", "src/*"), false);
	assert.equal(globMatch("src/sub/test.ts", "src/*/*"), true);
});
