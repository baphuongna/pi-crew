import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DENIED_METRIC_NAMES, parseMetricLines } from "../../../../src/runtime/metric-parser.ts";

describe("parseMetricLines", () => {
	it("parses a single valid CREW_METRIC line", () => {
		const result = parseMetricLines("CREW_METRIC files_changed=3\n");
		assert.deepStrictEqual(result, { files_changed: 3 });
	});

	it("parses multiple valid CREW_METRIC lines", () => {
		const output = [
			"Some regular output",
			"CREW_METRIC files_changed=3",
			"More output",
			"CREW_METRIC tests_passed=12",
			"CREW_METRIC duration_ms=4500.5",
		].join("\n");
		const result = parseMetricLines(output);
		assert.deepStrictEqual(result, {
			files_changed: 3,
			tests_passed: 12,
			duration_ms: 4500.5,
		});
	});

	it("returns empty object for empty input", () => {
		assert.deepStrictEqual(parseMetricLines(""), {});
	});

	it("returns empty object for input with no CREW_METRIC lines", () => {
		assert.deepStrictEqual(parseMetricLines("hello\nworld\nfoo=bar"), {});
	});

	it("skips lines with non-numeric values", () => {
		const result = parseMetricLines("CREW_METRIC bad_value=not_a_number\n");
		assert.deepStrictEqual(result, {});
	});

	it("skips lines with NaN values", () => {
		const result = parseMetricLines("CREW_METRIC nan_value=NaN\n");
		assert.deepStrictEqual(result, {});
	});

	it("skips lines with Infinity values", () => {
		const result = parseMetricLines("CREW_METRIC inf_value=Infinity\n");
		assert.deepStrictEqual(result, {});
	});

	it("skips denied metric names (prototype pollution prevention)", () => {
		const output = ["CREW_METRIC __proto__=42", "CREW_METRIC constructor=99", "CREW_METRIC prototype=100"].join("\n");
		const result = parseMetricLines(output);
		assert.deepStrictEqual(result, {});
	});

	it("parses valid metrics alongside denied names", () => {
		const output = ["CREW_METRIC __proto__=42", "CREW_METRIC valid_count=7", "CREW_METRIC constructor=99"].join("\n");
		const result = parseMetricLines(output);
		assert.deepStrictEqual(result, { valid_count: 7 });
	});

	it("handles negative numbers", () => {
		const result = parseMetricLines("CREW_METRIC delta=-5\n");
		assert.deepStrictEqual(result, { delta: -5 });
	});

	it("handles zero", () => {
		const result = parseMetricLines("CREW_METRIC count=0\n");
		assert.deepStrictEqual(result, { count: 0 });
	});

	it("handles scientific notation numbers", () => {
		const result = parseMetricLines("CREW_METRIC bytes=1.5e6\n");
		assert.deepStrictEqual(result, { bytes: 1_500_000 });
	});

	it("overwrites duplicate metric names with last value", () => {
		const output = ["CREW_METRIC count=1", "CREW_METRIC count=2"].join("\n");
		const result = parseMetricLines(output);
		assert.deepStrictEqual(result, { count: 2 });
	});

	it("skips lines with spaces in value", () => {
		const result = parseMetricLines("CREW_METRIC bad=1 2\n");
		assert.deepStrictEqual(result, {});
	});
});

describe("DENIED_METRIC_NAMES", () => {
	it("contains __proto__", () => {
		assert.ok(DENIED_METRIC_NAMES.has("__proto__"));
	});

	it("contains constructor", () => {
		assert.ok(DENIED_METRIC_NAMES.has("constructor"));
	});

	it("contains prototype", () => {
		assert.ok(DENIED_METRIC_NAMES.has("prototype"));
	});

	it("is a ReadonlySet", () => {
		assert.ok(DENIED_METRIC_NAMES instanceof Set);
	});

	it("has exactly 3 entries", () => {
		assert.strictEqual(DENIED_METRIC_NAMES.size, 3);
	});
});
