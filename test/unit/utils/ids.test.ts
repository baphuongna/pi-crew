import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDisplayName, createRunId, createTaskId } from "../../../src/utils/ids.ts";

describe("createRunId", () => {
	it("uses default 'team' prefix", () => {
		const id = createRunId();
		assert.ok(id.startsWith("team_"), `expected prefix 'team_' in ${id}`);
	});

	it("accepts custom prefix", () => {
		const id = createRunId("custom");
		assert.ok(id.startsWith("custom_"), `expected prefix 'custom_' in ${id}`);
	});

	it("contains a timestamp portion (14 digits)", () => {
		const id = createRunId();
		// Format: prefix_YYYYMMDDHHMMSS_suffix
		const parts = id.split("_");
		assert.ok(parts.length >= 3, `expected at least 3 parts: ${parts}`);
		// The timestamp part should be 14 digits
		const stamp = parts[1]!;
		assert.equal(stamp.length, 14, `timestamp should be 14 chars: ${stamp}`);
		assert.ok(/^\d{14}$/.test(stamp), `timestamp should be all digits: ${stamp}`);
	});

	it("generates unique IDs on successive calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) ids.add(createRunId());
		assert.equal(ids.size, 100);
	});
});

describe("createTaskId", () => {
	it("normalizes step ID to lowercase with hyphens", () => {
		const id = createTaskId("My_Step", 0);
		assert.equal(id, "01_my-step");
	});

	it("pads the index to 2 digits", () => {
		assert.equal(createTaskId("task", 0), "01_task");
		assert.equal(createTaskId("task", 9), "10_task");
		assert.equal(createTaskId("task", 99), "100_task");
	});

	it("uses fallback for step IDs with no valid characters", () => {
		const id = createTaskId("!!!", 0);
		assert.equal(id, "01_task");
	});

	it("strips leading/trailing hyphens from normalized step ID", () => {
		const id = createTaskId("-leading-", 0);
		assert.equal(id, "01_leading");
	});

	it("handles special characters in step ID", () => {
		const id = createTaskId("Step#1: Review", 2);
		assert.equal(id, "03_step-1-review");
	});
});

describe("createDisplayName", () => {
	it("returns a non-empty string", () => {
		const name = createDisplayName();
		assert.ok(name.length > 0, "display name should not be empty");
	});

	it("returns a PascalCase-style name (Adjective + Noun)", () => {
		const name = createDisplayName();
		// Pattern: uppercase letter, followed by lowercase, then uppercase, then lowercase
		assert.ok(/^[A-Z][a-z]+[A-Z]/.test(name), `name '${name}' should match PascalCase pattern`);
	});

	it("returns unique names across multiple calls", () => {
		const names = new Set<string>();
		for (let i = 0; i < 50; i++) names.add(createDisplayName());
		// With ~14k combinations, 50 should all be unique
		assert.equal(names.size, 50);
	});
});
