import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { abortOwned, type AbortOwnedResult } from "../../src/extension/team-tool/cancel.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";

/**
 * abortOwned is the primary pure-logic export from cancel.ts.
 * handleCancel and handleRetry require filesystem state so we test abortOwned thoroughly.
 */
describe("abortOwned", () => {
	it("returns all IDs as missing when runId does not resolve to a cwd", () => {
		const ctx: TeamContext = { cwd: "/nonexistent/path/that/does/not/exist" };
		const result = abortOwned("nonexistent-run", ["t1", "t2"], ctx);
		assert.deepEqual(result.missingIds, ["t1", "t2"]);
		assert.deepEqual(result.abortedIds, []);
		assert.deepEqual(result.foreignIds, []);
	});

	it("returns empty abortedIds for non-existent run", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const result = abortOwned("fake-run-id-12345", undefined, ctx);
		assert.deepEqual(result.abortedIds, []);
		assert.deepEqual(result.missingIds, []);
		assert.deepEqual(result.foreignIds, []);
	});

	it("returns all IDs as missing when taskIds are provided but run not found", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const result = abortOwned("nonexistent", ["x", "y", "z"], ctx);
		assert.deepEqual(result.missingIds, ["x", "y", "z"]);
		assert.deepEqual(result.abortedIds, []);
	});

	it("returns empty missingIds when taskIds is undefined and run not found", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const result = abortOwned("nonexistent", undefined, ctx);
		assert.deepEqual(result.missingIds, []);
	});

	it("returns empty lists when cwd is an empty string", () => {
		const ctx: TeamContext = { cwd: "" };
		const result = abortOwned("any", ["t1"], ctx);
		assert.deepEqual(result.abortedIds, []);
		assert.deepEqual(result.missingIds, ["t1"]);
	});

	it("returns all IDs as missing when taskIds is empty array", () => {
		const ctx: TeamContext = { cwd: "/tmp" };
		const result = abortOwned("nonexistent", [], ctx);
		assert.deepEqual(result.missingIds, []);
		assert.deepEqual(result.abortedIds, []);
	});
});
