import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { abortOwned } from "../../src/extension/team-tool/cancel.ts";

describe("abortOwned", () => {
	it("returns missing IDs when run not found", () => {
		const result = abortOwned("nonexistent-run", ["t1", "t2"], { cwd: process.cwd() });
		assert.deepEqual(result, { abortedIds: [], missingIds: ["t1", "t2"], foreignIds: [] });
	});

	it("returns empty when no task IDs specified and run not found", () => {
		const result = abortOwned("nonexistent-run", undefined, { cwd: process.cwd() });
		assert.deepEqual(result, { abortedIds: [], missingIds: [], foreignIds: [] });
	});
});
