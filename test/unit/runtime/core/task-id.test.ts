import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	calculateAdaptiveLength,
	childId,
	generateTaskHashId,
	hashToBase36,
	parseHierarchicalId,
} from "../../../../src/runtime/task-id.ts";

describe("task-id: hashToBase36", () => {
	it("produces a string of the requested length", () => {
		const result = hashToBase36("hello", 5);
		assert.equal(result.length, 5);
	});

	it("contains only base36 characters", () => {
		const result = hashToBase36("test-content", 8);
		assert.match(result, /^[0-9a-z]+$/);
	});

	it("is deterministic — same input yields same output", () => {
		const a = hashToBase36("deterministic", 6);
		const b = hashToBase36("deterministic", 6);
		assert.equal(a, b);
	});

	it("different inputs produce different hashes (high probability)", () => {
		const a = hashToBase36("input-a", 6);
		const b = hashToBase36("input-b", 6);
		assert.notEqual(a, b);
	});

	it("pads short results to the requested length", () => {
		// Even if hash is shorter, result should be padded
		const result = hashToBase36("x", 8);
		assert.equal(result.length, 8);
	});

	it("respects minimum length of 3", () => {
		const result = hashToBase36("short", 3);
		assert.equal(result.length, 3);
	});

	it("handles empty string input", () => {
		const result = hashToBase36("", 4);
		assert.equal(result.length, 4);
		assert.match(result, /^[0-9a-z]+$/);
	});
});

describe("task-id: calculateAdaptiveLength", () => {
	it("returns minLength for zero existing count", () => {
		const length = calculateAdaptiveLength(0);
		assert.equal(length, 3);
	});

	it("returns minLength for small existing count", () => {
		const length = calculateAdaptiveLength(5);
		assert.equal(length, 3);
	});

	it("returns longer length for large existing count", () => {
		const length = calculateAdaptiveLength(10000);
		assert.ok(length > 3, `Expected length > 3, got ${length}`);
	});

	it("never exceeds maxLength", () => {
		const length = calculateAdaptiveLength(1_000_000_000);
		assert.ok(length <= 8, `Expected length <= 8, got ${length}`);
	});

	it("respects custom config", () => {
		const length = calculateAdaptiveLength(10, {
			maxCollisionProbability: 0.01,
			minLength: 2,
			maxLength: 6,
		});
		assert.ok(length >= 2);
		assert.ok(length <= 6);
	});
});

describe("task-id: generateTaskHashId", () => {
	it("generates ID with default prefix 'pc'", () => {
		const id = generateTaskHashId(["task title"]);
		assert.ok(id.startsWith("pc-"));
	});

	it("uses custom prefix", () => {
		const id = generateTaskHashId(["task title"], "custom");
		assert.ok(id.startsWith("custom-"));
	});

	it("is deterministic", () => {
		const a = generateTaskHashId(["same", "parts"]);
		const b = generateTaskHashId(["same", "parts"]);
		assert.equal(a, b);
	});

	it("different parts produce different IDs", () => {
		const a = generateTaskHashId(["task-a"]);
		const b = generateTaskHashId(["task-b"]);
		assert.notEqual(a, b);
	});

	it("joins parts with pipe delimiter", () => {
		// Verify that ["a","b"] joins as "a|b" for hashing.
		// generateTaskHashId(["a", "b"]) should equal generateTaskHashId(["a|b"])
		// only if the join delimiter is pipe. We test by confirming
		// different partitionings of the same joined string produce different IDs.
		const joined = generateTaskHashId(["alpha", "beta", "gamma"]);
		const single = generateTaskHashId(["alpha|beta|gamma"]);
		// These should be the same if pipe is the joiner
		assert.equal(joined, single);
	});
});

describe("task-id: parseHierarchicalId", () => {
	it("parses a hierarchical ID", () => {
		const result = parseHierarchicalId("pc-a1b2.3");
		assert.deepEqual(result, {
			parentId: "pc-a1b2",
			childNum: 3,
			isHierarchical: true,
		});
	});

	it("returns isHierarchical=false for non-hierarchical ID", () => {
		const result = parseHierarchicalId("pc-a1b2");
		assert.equal(result.isHierarchical, false);
		assert.equal(result.parentId, "pc-a1b2");
		assert.equal(result.childNum, 0);
	});

	it("rejects dot position too early (< 3)", () => {
		// e.g. "ab.3" — dotIndex < 3
		const result = parseHierarchicalId("ab.3");
		assert.equal(result.isHierarchical, false);
	});

	it("rejects child number of 0", () => {
		const result = parseHierarchicalId("pc-a1b2.0");
		assert.equal(result.isHierarchical, false);
	});

	it("rejects non-numeric child number", () => {
		const result = parseHierarchicalId("pc-a1b2.abc");
		assert.equal(result.isHierarchical, false);
	});

	it("uses last dot for splitting", () => {
		const result = parseHierarchicalId("pc-a1.b2.5");
		assert.equal(result.isHierarchical, true);
		assert.equal(result.parentId, "pc-a1.b2");
		assert.equal(result.childNum, 5);
	});
});

describe("task-id: childId", () => {
	it("generates child ID from parent and number", () => {
		assert.equal(childId("pc-a1b2", 3), "pc-a1b2.3");
	});

	it("works with 1 as child number", () => {
		assert.equal(childId("pc-abc", 1), "pc-abc.1");
	});

	it("works with large child numbers", () => {
		assert.equal(childId("pc-abc", 99), "pc-abc.99");
	});
});
