import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { countTokens, detectCodeContent } from "../../src/utils/token-counter.ts";

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

describe("detectCodeContent", () => {
	it("returns false for empty string", () => {
		assert.equal(detectCodeContent(""), false);
	});

	it("returns false for whitespace-only string", () => {
		assert.equal(detectCodeContent("   "), false);
	});

	it("detects code-heavy strings as code", () => {
		const codeSamples = [
			"function add(a, b) { return a + b; }",
			"const result = arr.filter(x => x > 0).map(x => x * 2);",
			"export function process(data: string): void { console.log(data); }",
			"if (x === 0 && y !== null) { return x + y; }",
			"import { foo } from './bar';",
			"class MyComponent extends React.Component { render() { return null; } }",
		];
		for (const code of codeSamples) {
			assert.equal(detectCodeContent(code), true, `Should detect as code: ${code.slice(0, 40)}...`);
		}
	});

	it("detects prose strings as not code", () => {
		const proseSamples = [
			"The quick brown fox jumps over the lazy dog.",
			"Hello! How are you? I'm fine, thanks.",
			"Line one\nLine two\nLine three",
			"Here is some code: const x = 42;", // low code density → prose
			"This is a paragraph of English text that discusses various topics.",
		];
		for (const prose of proseSamples) {
			assert.equal(detectCodeContent(prose), false, `Should detect as prose: ${prose.slice(0, 40)}...`);
		}
	});
});

describe("countTokens — code-aware estimation accuracy", () => {
	/**
	 * Helper: compute percent error between estimated and reference token count.
	 */
	function pctError(estimated: number, reference: number): number {
		return (Math.abs(estimated - reference) / reference) * 100;
	}

	it("estimates TypeScript function declaration within ±10%", () => {
		const code = "export function add(a: number, b: number): number {\n\treturn a + b;\n}";
		const count = countTokens(code);
		// BPE reference: export(1) function(1) add(1) ((1) a(1) :(1) number(1)
		// ,(1) b(1) :(1) number(1) )(1) :(1) number(1) {(1) return(1) a(1) +(1)
		// b(1) ;(1) }(1) ≈ 23 tokens
		const reference = 23;
		const error = pctError(count, reference);
		assert.ok(error <= 10, `Expected ≤10% error vs ${reference}, got ${count} (${error.toFixed(1)}%)`);
	});

	it("estimates method chaining within ±10%", () => {
		const code = "const result = arr.filter(x => x > 0).map(x => x * 2);";
		const count = countTokens(code);
		// BPE reference ≈ 21-24 tokens (each identifier/operator/bracket = ~1 token)
		const reference = 22;
		const error = pctError(count, reference);
		assert.ok(error <= 10, `Expected ≤10% error vs ${reference}, got ${count} (${error.toFixed(1)}%)`);
	});

	it("estimates conditional with operators within ±10%", () => {
		const code = "if (x === 0 && y !== null) { return x + y; }";
		const count = countTokens(code);
		// BPE reference: if(1) ((1) x(1) ===(~2) 0(1) &&(1) y(1) !==(~2) null(1)
		// )(1) {(1) return(1) x(1) +(1) y(1) ;(1) }(1) ≈ 19 tokens
		const reference = 19;
		const error = pctError(count, reference);
		assert.ok(error <= 10, `Expected ≤10% error vs ${reference}, got ${count} (${error.toFixed(1)}%)`);
	});

	it("estimates multi-line function within ±15%", () => {
		// Larger sample with long identifiers — slightly wider tolerance
		const code = [
			"function process(items) {",
			"  return items.filter(x => x.active).map(x => x.value);",
			"}",
		].join("\n");
		const count = countTokens(code);
		// BPE reference: function(1) process(1) items(1) ((1) items(1) )(1) {(1)
		// return(1) items(1) .(1) filter(1) ((1) x(1) =>(1) x(1) .(1) active(1)
		// )(1) .(1) map(1) ((1) x(1) =>(1) x(1) .(1) value(1) )(1) ;(1) }(1) ≈ 32
		const reference = 32;
		const error = pctError(count, reference);
		assert.ok(error <= 15, `Expected ≤15% error vs ${reference}, got ${count} (${error.toFixed(1)}%)`);
	});

	it("does not regress prose estimation", () => {
		// Prose should still use the original ceil(alpha/4) + punct formula.
		// These samples must produce the same results as before the change.
		const proseSamples: Array<[string, number, number]> = [
			["The quick brown fox jumps over the lazy dog.", 9, 11],
			["Hello! How are you? I'm fine, thanks.", 12, 14],
			["Line one\nLine two\nLine three", 6, 7],
		];
		for (const [text, lo, hi] of proseSamples) {
			const count = countTokens(text);
			assert.ok(count >= lo && count <= hi, `Prose "${text.slice(0, 30)}..." expected ${lo}-${hi}, got ${count}`);
		}
	});
});

describe("countTokens — mixed content", () => {
	it("handles prose-dominant content with minor code elements", () => {
		// Mostly prose, a few code-like tokens — should stay as prose estimation
		const text = "The function returns a value: return x + y; done.";
		const count = countTokens(text);
		// Low code-punctuation density → prose path.
		// Prose formula: ceil(36/4) + 4 = 9 + 4 = 13
		assert.ok(count >= 11 && count <= 15, `Expected 11-15 tokens, got ${count}`);
		assert.equal(detectCodeContent(text), false);
	});

	it("handles code-dominant content with short comment", () => {
		// Code with a brief comment — still detected as code
		const text = "// helper\nfunction add(a, b) { return a + b; }";
		assert.equal(detectCodeContent(text), true);
		const count = countTokens(text);
		assert.ok(count > 0, "Should produce a positive token count");
	});

	it("handles markdown with embedded code", () => {
		// Markdown code block — should be detected as code due to high density
		const text = "```ts\nconst x = 42;\nfunction foo() { return x; }\n```";
		assert.equal(detectCodeContent(text), true);
		const count = countTokens(text);
		assert.ok(count > 0, "Should produce a positive token count");
	});
});

describe("countTokens — code performance", () => {
	/**
	 * Measure best-of-N batches to filter out system-load spikes.
	 * Returns the minimum per-call time across all batches.
	 */
	function bestPerCall(text: string, warmup: number, batches: number, itersPerBatch: number): number {
		for (let i = 0; i < warmup; i++) countTokens(text);
		let best = Infinity;
		for (let b = 0; b < batches; b++) {
			const start = performance.now();
			for (let i = 0; i < itersPerBatch; i++) countTokens(text);
			const perCall = (performance.now() - start) / itersPerBatch;
			if (perCall < best) best = perCall;
		}
		return best;
	}

	it("handles 10KB of code within <1ms", () => {
		// Generate ~10KB of repetitive code
		const codeLine = "const x = arr.filter(y => y > 0).map(z => z * 2);\n";
		const largeCode = codeLine.repeat(200); // ~10KB
		const perCall = bestPerCall(largeCode, 10, 5, 20);

		assert.ok(perCall < 1, `Expected <1ms per call for 10KB code, got ${perCall.toFixed(2)}ms`);
	});

	it("handles 10KB of mixed content within <1ms", () => {
		// Generate ~10KB of mixed content
		const segment = "Some prose here. const x = 42; More text follows.\n";
		const largeMixed = segment.repeat(180); // ~10KB
		const perCall = bestPerCall(largeMixed, 10, 5, 20);

		assert.ok(perCall < 1, `Expected <1ms per call for 10KB mixed, got ${perCall.toFixed(2)}ms`);
	});
});
