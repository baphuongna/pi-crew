import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { countTokens } from "../../src/utils/token-counter.ts";

describe("countTokens", () => {
	it("returns 0 for empty string", () => {
		assert.equal(countTokens(""), 0);
	});

	it("returns 0 for whitespace-only string", () => {
		assert.equal(countTokens("   "), 0);
		assert.equal(countTokens("\n\n"), 0);
		assert.equal(countTokens("  \t  "), 0);
	});

	it("counts English text tokens accurately", () => {
		// Simple English sentence - should be close to actual token count
		const text = "The quick brown fox jumps over the lazy dog.";
		const count = countTokens(text);
		// Words: The, quick, brown, fox, jumps, over, the, lazy, dog = 9 words
		// Punctuation: . = 1
		// Total should be ~10 tokens (±10% of actual ~10 tokens)
		assert.ok(count >= 9 && count <= 11, `Expected 9-11 tokens, got ${count}`);
	});

	it("counts code tokens accurately", () => {
		// Code with operators and keywords
		const code = "function add(a, b) { return a + b; }";
		const count = countTokens(code);
		// Words: function, add, a, b, return, a, b = 7 words
		// Punctuation: (, ), {, }, +, ;, ) = 7 punctuation
		// Total should be ~14 tokens (±10% of actual ~12-14 tokens)
		assert.ok(count >= 12 && count <= 16, `Expected 12-16 tokens, got ${count}`);
	});

	it("counts mixed content tokens", () => {
		// Mix of English and code
		const text = "Here is some code: const x = 42;";
		const count = countTokens(text);
		// Words: Here, is, some, code, const, x, 42 = 7 words
		// Punctuation: :, =, ; = 3 punctuation
		// Total should be ~10 tokens (±10% of actual ~10 tokens)
		assert.ok(count >= 9 && count <= 11, `Expected 9-11 tokens, got ${count}`);
	});

	it("handles large text within performance threshold (<1ms for 10KB)", () => {
		// Generate ~10KB of text
		const repeatText = "This is a test sentence with some words. ";
		const largeText = repeatText.repeat(250); // ~10KB
		// Warm up V8
		for (let i = 0; i < 3; i++) countTokens(largeText);
		// Measure over multiple iterations to amortize Node test framework overhead
		const iterations = 10;
		const start = performance.now();
		let totalTokens = 0;
		for (let i = 0; i < iterations; i++) totalTokens += countTokens(largeText);
		const duration = performance.now() - start;
		const perCall = duration / iterations;

		assert.ok(perCall < 1, `Expected <1ms per call, got ${perCall.toFixed(2)}ms (${iterations} iters of ${largeText.length} chars)`);
		assert.ok(totalTokens > 0, "Should count tokens in large text");
	});

	it("is more accurate than char/4 heuristic for code-heavy content", () => {
		// Code-heavy content where char/4 is less accurate
		const code = "const result = arr.filter(x => x > 0).map(x => x * 2);";
		const count = countTokens(code);
		const charHeuristic = Math.ceil(code.length / 4);

		// Reference: ~24 tokens is what BPE tokenizers (gpt-3.5/4) produce for
		// this code. Each operator/bracket/semicolon is typically its own token,
		// while the alphanumeric parts average ~4 chars/token.
		// char/4 (14) undercounts because it treats `=>`, `.`, `;` etc. as
		// ~4 chars each rather than as separate tokens.
		const actualApprox = 24;
		const ourError = Math.abs(count - actualApprox) / actualApprox;
		const charError = Math.abs(charHeuristic - actualApprox) / actualApprox;

		assert.ok(
			ourError < charError,
			`Our heuristic (${count} tokens, ${(ourError * 100).toFixed(1)}% off) should beat char/4 (${charHeuristic} tokens, ${(charError * 100).toFixed(1)}% off)`,
		);
	});

	it("handles special characters and symbols", () => {
		const text = "Hello! How are you? I'm fine, thanks.";
		const count = countTokens(text);
		// Words: Hello, How, are, you, I, m, fine, thanks = 8 words
		// Punctuation: !, ?, ', ,, . = 5 punctuation
		// Total should be ~13 tokens (±10% of actual ~13 tokens)
		assert.ok(count >= 12 && count <= 14, `Expected 12-14 tokens, got ${count}`);
	});

	it("handles newlines and whitespace correctly", () => {
		const text = "Line one\nLine two\nLine three";
		const count = countTokens(text);
		// Words: Line, one, Line, two, Line, three = 6 words
		// Punctuation: 0
		// Total should be ~6 tokens
		assert.ok(count >= 6 && count <= 7, `Expected 6-7 tokens, got ${count}`);
	});
});
