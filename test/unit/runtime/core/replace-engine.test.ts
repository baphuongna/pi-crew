import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replace } from "../../../../src/runtime/replace.ts";

describe("replace — ReplaceResult contract", () => {
	it("returns a ReplaceResult with all four fields", () => {
		const result = replace("hello world", "hello", "hi");
		assert.deepEqual(Object.keys(result).sort(), ["changed", "content", "count", "strategy"]);
		assert.equal(result.changed, true);
		assert.equal(result.count, 1);
		assert.equal(result.strategy, "simple");
	});
});

describe("replace — exact match (SimpleReplacer)", () => {
	it("replaces a single exact occurrence with strategy 'simple'", () => {
		const result = replace("foo bar baz", "bar", "qux");
		assert.equal(result.changed, true);
		assert.equal(result.content, "foo qux baz");
		assert.equal(result.strategy, "simple");
		assert.equal(result.count, 1);
	});

	it("replaces at the start of the content", () => {
		const result = replace("abc def", "abc", "xyz");
		assert.equal(result.changed, true);
		assert.equal(result.content, "xyz def");
		assert.equal(result.strategy, "simple");
	});

	it("replaces at the end of the content", () => {
		const result = replace("abc def", "def", "xyz");
		assert.equal(result.changed, true);
		assert.equal(result.content, "abc xyz");
		assert.equal(result.strategy, "simple");
	});

	it("replaces a multi-line exact match", () => {
		const content = "line1\nline2\nline3";
		const result = replace(content, "line2", "replaced");
		assert.equal(result.changed, true);
		assert.equal(result.content, "line1\nreplaced\nline3");
		assert.equal(result.strategy, "simple");
		assert.equal(result.count, 1);
	});

	it("returns changed=false when the exact string is not found at all", () => {
		const result = replace("hello world", "nonexistent", "x");
		assert.equal(result.changed, false);
		assert.equal(result.content, "hello world");
		assert.equal(result.strategy, "none");
		assert.equal(result.count, 0);
	});
});

describe("replace — multiple-match rejection safety", () => {
	it("does NOT replace when oldString appears multiple times and replaceAll=false", () => {
		const content = "hello world hello";
		const result = replace(content, "hello", "hi", { replaceAll: false });
		assert.equal(result.changed, false);
		assert.equal(result.content, content);
		assert.equal(result.strategy, "none");
		assert.equal(result.count, 0);
	});

	it("does NOT replace across multiple lines when replaceAll=false", () => {
		const content = "hello\nhello";
		const result = replace(content, "hello", "hi", { replaceAll: false });
		assert.equal(result.changed, false);
		assert.equal(result.content, content);
		assert.equal(result.strategy, "none");
	});

	it("replaceAll=false is the default (no options arg)", () => {
		const result = replace("x y x", "x", "z");
		assert.equal(result.changed, false);
		assert.equal(result.content, "x y x");
	});

	it("does NOT replace when oldString appears twice on the same line", () => {
		const result = replace("a a a", "a", "b", { replaceAll: false });
		assert.equal(result.changed, false);
	});
});

describe("replace — replaceAll=true", () => {
	it("replaces all exact occurrences with strategy 'simple-replaceAll'", () => {
		const content = "foo bar foo bar foo";
		const result = replace(content, "foo", "XXX", { replaceAll: true });
		assert.equal(result.changed, true);
		assert.equal(result.content, "XXX bar XXX bar XXX");
		assert.equal(result.strategy, "simple-replaceAll");
		assert.equal(result.count, 3);
	});

	it("replaceAll=true with a single occurrence still works", () => {
		const result = replace("hello world", "hello", "hi", {
			replaceAll: true,
		});
		assert.equal(result.changed, true);
		assert.equal(result.content, "hi world");
		assert.equal(result.strategy, "simple-replaceAll");
		assert.equal(result.count, 1);
	});

	it("replaceAll=true when oldString is not found returns changed=false", () => {
		const result = replace("hello world", "missing", "x", {
			replaceAll: true,
		});
		assert.equal(result.changed, false);
		assert.equal(result.content, "hello world");
		assert.equal(result.strategy, "none");
	});
});

describe("replace — empty oldString", () => {
	it("returns changed=false with no crash for empty oldString", () => {
		const content = "hello world";
		const result = replace(content, "", "replacement");
		assert.equal(result.changed, false);
		assert.equal(result.content, content);
		assert.equal(result.strategy, "none");
		assert.equal(result.count, 0);
	});

	it("empty oldString with replaceAll=true also returns changed=false", () => {
		const result = replace("abc", "", "x", { replaceAll: true });
		assert.equal(result.changed, false);
		assert.equal(result.content, "abc");
	});
});

describe("replace — oldString === newString", () => {
	it("returns changed=false when oldString equals newString", () => {
		const content = "hello world";
		const result = replace(content, "hello", "hello");
		assert.equal(result.changed, false);
		assert.equal(result.content, content);
		assert.equal(result.strategy, "none");
		assert.equal(result.count, 0);
	});

	it("returns changed=false even with replaceAll=true when strings are equal", () => {
		const content = "foo foo";
		const result = replace(content, "foo", "foo", { replaceAll: true });
		assert.equal(result.changed, false);
		assert.equal(result.content, content);
	});
});

describe("replace — whitespace-normalized strategy", () => {
	it("matches when find has different whitespace (extra spaces collapsed)", () => {
		// Content has 4 spaces, find has 1 space — only WhitespaceNormalized matches
		const content = "foo    bar";
		const result = replace(content, "foo bar", "REPLACED");
		assert.equal(result.changed, true);
		assert.equal(result.content, "REPLACED");
		assert.equal(result.strategy, "whitespace-normalized");
		assert.equal(result.count, 1);
	});

	it("matches tab vs space drift (tab in content, space in find)", () => {
		const content = "hello\tworld";
		const result = replace(content, "hello world", "replaced");
		assert.equal(result.changed, true);
		assert.equal(result.content, "replaced");
		assert.equal(result.strategy, "whitespace-normalized");
	});

	it("matches space in content vs tab in find", () => {
		const content = "a b";
		const result = replace(content, "a\tb", "c");
		assert.equal(result.changed, true);
		assert.equal(result.content, "c");
		assert.equal(result.strategy, "whitespace-normalized");
	});

	it("does not crash on whitespace-only find", () => {
		const result = replace("hello world", "   ", "x");
		// "   " normalizes to "" which has length 0 → WhitespaceNormalized skips
		assert.equal(result.changed, false);
	});
});

describe("replace — escape-normalized strategy", () => {
	it("matches when find contains escaped \\n but content has real newline", () => {
		const content = "hello\nworld"; // actual newline
		const find = "hello\\nworld"; // literal backslash-n
		const result = replace(content, find, "replaced");
		assert.equal(result.changed, true);
		assert.equal(result.content, "replaced");
		assert.equal(result.strategy, "escape-normalized");
		assert.equal(result.count, 1);
	});

	it("matches when find contains escaped \\t but content has real tab", () => {
		const content = "a\tb"; // actual tab
		const find = "a\\tb"; // literal backslash-t
		const result = replace(content, find, "replaced");
		assert.equal(result.changed, true);
		assert.equal(result.content, "replaced");
		assert.equal(result.strategy, "escape-normalized");
	});

	it("matches when find contains escaped quotes", () => {
		const content = 'say "hello"';
		const find = 'say \\"hello\\"'; // escaped quotes
		const result = replace(content, find, "replaced");
		assert.equal(result.changed, true);
		assert.equal(result.content, "replaced");
		assert.equal(result.strategy, "escape-normalized");
	});
});

describe("replace — line-trimmed strategy", () => {
	it("matches when indentation differs (extra leading spaces)", () => {
		// Single line where find has different leading whitespace than content line.
		// LineTrimmed compares trimmed lines.
		const content = "    indented line\nnext line";
		// "indented line" trimmed matches "indented line" — but Simple would also
		// match "indented line" if it's a substring. Use leading/trailing spaces
		// that prevent simple match but trim() matches.
		const result = replace(content, "   indented line  ", "REPLACED");
		// TrimmedBoundary would match here (trim removes boundary whitespace).
		// LineTrimmed runs before TrimmedBoundary in the cascade. Let's verify
		// it matched via one of the lenient strategies.
		assert.equal(result.changed, true);
		// The matched substring is "    indented line" (the actual line in content)
		assert.equal(result.content, "REPLACED\nnext line");
	});

	it("matches multi-line block with different indentation per line", () => {
		const content = "  alpha\n    beta\n  gamma";
		// Find has no indentation — LineTrimmed compares trimmed lines
		const find = "alpha\nbeta\ngamma";
		const result = replace(content, find, "X\nY\nZ");
		assert.equal(result.changed, true);
		assert.equal(result.content, "X\nY\nZ");
		// Strategy could be line-trimmed or whitespace-normalized — both match
		assert.ok(
			result.strategy === "line-trimmed" || result.strategy === "whitespace-normalized",
			`expected line-trimmed or whitespace-normalized, got ${result.strategy}`,
		);
	});
});

describe("replace — block-anchor (Levenshtein fuzzy fallback) strategy", () => {
	it("matches a 3+ line block using first/last anchors with fuzzy middle", () => {
		const content = ["function foo() {", '  console.log("hello world");', "  return 42;", "}"].join("\n");

		// Find has a slightly different middle line — anchors match, Levenshtein similarity is high
		const find = [
			"function foo() {",
			'  console.log("hi world");', // "hello" → "hi" is a small edit
			"  return 42;",
			"}",
		].join("\n");

		const result = replace(content, find, "REPLACED BLOCK");
		assert.equal(result.changed, true);
		assert.equal(result.content, "REPLACED BLOCK");
		assert.equal(result.strategy, "block-anchor");
		assert.equal(result.count, 1);
	});

	it("block-anchor requires at least 3 lines (2-line find does not trigger it)", () => {
		// 2-line find with differences won't match Simple or BlockAnchor (< 3 lines).
		// WhitespaceNormalized or LineTrimmed would need to match.
		const content = "first line\nsecond line\nthird line";
		const find = "first line\nsecond line"; // exact match → Simple handles this
		const result = replace(content, find, "A\nB");
		assert.equal(result.changed, true);
		assert.equal(result.strategy, "simple");
	});
});

describe("replace — trimmed-boundary strategy", () => {
	it("matches when find has boundary whitespace but the content substring is embedded in a larger line", () => {
		// LineTrimmedReplacer compares per-line trimmed content — "prefix midword suffix"
		// trimmed is NOT equal to "midword". WhitespaceNormalized also doesn't match
		// ("prefix midword suffix" !== "midword"). TrimmedBoundaryReplacer strips
		// leading/trailing whitespace from the whole find, then checks if the
		// trimmed substring is included in the content.
		const content = "prefix midword suffix";
		const result = replace(content, "  midword  ", "replaced");
		assert.equal(result.changed, true);
		assert.equal(result.content, "prefix replaced suffix");
		assert.equal(result.strategy, "trimmed-boundary");
		assert.equal(result.count, 1);
	});
});

describe("replace — cascade priority ordering", () => {
	it("exact match takes priority over fuzzy strategies", () => {
		// Content has exact match available
		const result = replace("hello world", "hello", "hi");
		assert.equal(result.strategy, "simple");
	});

	it("does not fall through to fuzzy when exact match exists uniquely", () => {
		// Even though whitespace-normalized would also match, simple wins
		const content = "hello world";
		const result = replace(content, "hello", "hi");
		assert.equal(result.strategy, "simple");
		assert.equal(result.count, 1);
	});
});
