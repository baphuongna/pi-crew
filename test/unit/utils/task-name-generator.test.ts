import assert from "node:assert/strict";
import test from "node:test";
import { generateTaskName, resetTaskNames } from "../../../src/utils/task-name-generator.ts";

const NAME_PATTERN = /^[A-Z][a-z]+[A-Z][a-z]+$/;

test("generates non-empty names", () => {
	resetTaskNames();
	const name = generateTaskName();
	assert.ok(name.length > 0, "name should be non-empty");
	assert.match(name, NAME_PATTERN, `name "${name}" should match AdjectiveNoun pattern`);
});

test("generates unique names across calls", () => {
	resetTaskNames();
	const names = new Set<string>();
	for (let i = 0; i < 200; i++) {
		const name = generateTaskName();
		assert.ok(!names.has(name), `duplicate name generated: "${name}" at iteration ${i}`);
		names.add(name);
	}
	assert.equal(names.size, 200, "should have 200 unique names");
});

test("reset clears state", () => {
	resetTaskNames();
	const first = generateTaskName();
	const second = generateTaskName();
	assert.notEqual(first, second, "names should differ before reset");

	resetTaskNames();
	const afterReset = generateTaskName();
	// After reset, previously used names can be generated again
	assert.ok(typeof afterReset === "string" && afterReset.length > 0, "should generate valid name after reset");
});

test("names match AdjectiveNoun pattern", () => {
	resetTaskNames();
	for (let i = 0; i < 50; i++) {
		const name = generateTaskName();
		assert.match(name, NAME_PATTERN, `name "${name}" should match AdjectiveNoun pattern`);
	}
});

test("handles exhaustion by resetting", () => {
	resetTaskNames();
	// There are 120 adjectives × 120 nouns = 14,400 combinations
	// Generate more than that to force exhaustion
	const total = 14_400 + 10;
	const names: string[] = [];
	for (let i = 0; i < total; i++) {
		names.push(generateTaskName());
	}
	// Should still get valid names after exhaustion
	const lastName = names[names.length - 1]!;
	assert.ok(lastName.length > 0, "should generate name even after exhaustion");
	assert.match(lastName, NAME_PATTERN, `post-exhaustion name "${lastName}" should match pattern`);
});
