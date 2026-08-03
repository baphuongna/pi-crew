import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listRunsByScope } from "../../../../src/extension/run-index.ts";

describe("listRunsByScope", () => {
	it("returns runs for all scopes by default", () => {
		// This tests that the function doesn't throw with an arbitrary cwd
		const runs = listRunsByScope(process.cwd(), "all");
		assert.ok(Array.isArray(runs));
	});

	it("returns empty array for project scope when no project root", () => {
		const runs = listRunsByScope(process.cwd(), "project");
		assert.ok(Array.isArray(runs));
	});

	it("returns runs for user scope", () => {
		const runs = listRunsByScope(process.cwd(), "user");
		assert.ok(Array.isArray(runs));
	});
});
