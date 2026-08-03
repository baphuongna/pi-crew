import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseChainDSL } from "../../../src/runtime/chain-parser.ts";

describe("chain-parser: parseChainDSL", () => {
	it("parses a simple single-step chain", () => {
		const result = parseChainDSL("step1");
		assert.deepEqual(result, [{ name: "step1" }]);
	});

	it("parses a two-step chain with arrow", () => {
		const result = parseChainDSL("step1 -> step2");
		assert.deepEqual(result, [{ name: "step1" }, { name: "step2" }]);
	});

	it("parses a chain with parallel group", () => {
		const result = parseChainDSL("step1 -> parallel(step2, step3) -> step4");
		assert.deepEqual(result, [
			{ name: "step1" },
			{
				name: "parallel",
				parallel: [{ name: "step2" }, { name: "step3" }],
			},
			{ name: "step4" },
		]);
	});

	it("parses nested parallel groups", () => {
		const result = parseChainDSL("parallel(a, parallel(b, c)) -> d");
		assert.deepEqual(result, [
			{
				name: "parallel",
				parallel: [
					{ name: "a" },
					{
						name: "parallel",
						parallel: [{ name: "b" }, { name: "c" }],
					},
				],
			},
			{ name: "d" },
		]);
	});

	it("parses loop count modifier with colon", () => {
		const result = parseChainDSL("step1:3 -> step2");
		assert.deepEqual(result, [{ name: "step1", loopCount: 3 }, { name: "step2" }]);
	});

	it("parses --with-context flag", () => {
		const result = parseChainDSL("step1 --with-context -> step2");
		assert.deepEqual(result, [{ name: "step1", withContext: true }, { name: "step2" }]);
	});

	it("parses quoted arguments", () => {
		const result = parseChainDSL('step1 "arg1" "arg2"');
		assert.deepEqual(result, [{ name: "step1", args: ["arg1", "arg2"] }]);
	});

	it("parses quoted arguments with escape sequences", () => {
		const result = parseChainDSL('step1 "arg\\"1"');
		assert.deepEqual(result, [{ name: "step1", args: ['arg"1'] }]);
	});

	it("parses single-quoted arguments", () => {
		const result = parseChainDSL("step1 'hello world'");
		assert.deepEqual(result, [{ name: "step1", args: ["hello world"] }]);
	});

	it("parses complex chain with all modifiers", () => {
		const result = parseChainDSL('explore:2 --with-context "target" -> parallel(a, b) -> verify');
		assert.equal(result.length, 3);
		assert.equal(result[0].name, "explore");
		assert.equal(result[0].loopCount, 2);
		assert.equal(result[0].withContext, true);
		assert.deepEqual(result[0].args, ["target"]);
		assert.equal(result[1].name, "parallel");
		assert.equal(result[1].parallel!.length, 2);
		assert.equal(result[2].name, "verify");
	});

	it("handles extra whitespace gracefully", () => {
		const result = parseChainDSL("  step1   ->   step2  ");
		assert.deepEqual(result, [{ name: "step1" }, { name: "step2" }]);
	});

	it("throws on unclosed parenthesis", () => {
		assert.throws(() => parseChainDSL("parallel(step1, step2"), /Expected RPAREN|end of chain/);
	});

	it("throws on unclosed quoted string", () => {
		assert.throws(() => parseChainDSL('step1 "unterminated'), /Unclosed quoted/);
	});

	it("throws on unexpected character", () => {
		assert.throws(() => parseChainDSL("step1 @ step2"), /Unexpected character/);
	});

	it("throws on empty parallel group", () => {
		// parallel() with no args would fail because NAME is expected
		assert.throws(() => parseChainDSL("parallel()"), /Expected NAME/);
	});

	it("parses step names with dots and hyphens", () => {
		const result = parseChainDSL("my-step.v2 -> other_step");
		assert.deepEqual(result, [{ name: "my-step.v2" }, { name: "other_step" }]);
	});
});
