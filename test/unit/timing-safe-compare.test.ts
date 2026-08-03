import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canUseTaskClaim, createTaskClaim, timingSafeTokenMatch } from "../../src/state/coordination/task-claims.ts";

describe("timing-safe claim token comparison", () => {
	it("accepts matching claim token", () => {
		const claim = createTaskClaim("owner1");
		const task = { claim };
		assert.equal(canUseTaskClaim(task, "owner1", claim.token), true);
	});

	it("rejects wrong claim token", () => {
		const claim = createTaskClaim("owner1");
		const task = { claim };
		assert.equal(canUseTaskClaim(task, "owner1", "wrong-token"), false);
	});

	it("rejects wrong owner", () => {
		const claim = createTaskClaim("owner1");
		const task = { claim };
		assert.equal(canUseTaskClaim(task, "other", claim.token), false);
	});

	it("rejects empty token", () => {
		const claim = createTaskClaim("owner1");
		const task = { claim };
		assert.equal(canUseTaskClaim(task, "owner1", ""), false);
	});

	it("rejects token of different length", () => {
		const claim = createTaskClaim("owner1");
		const task = { claim };
		assert.equal(canUseTaskClaim(task, "owner1", claim.token.slice(0, 5)), false);
	});
});

describe("timingSafeTokenMatch", () => {
	it("accepts identical strings", () => {
		const token = "abc123";
		assert.equal(timingSafeTokenMatch(token, token), true);
	});

	it("rejects different strings of same length", () => {
		assert.equal(timingSafeTokenMatch("abc", "def"), false);
	});

	it("rejects different lengths", () => {
		assert.equal(timingSafeTokenMatch("abc", "ab"), false);
	});

	it("handles empty strings", () => {
		assert.equal(timingSafeTokenMatch("", ""), true);
		assert.equal(timingSafeTokenMatch("abc", ""), false);
		assert.equal(timingSafeTokenMatch("", "abc"), false);
	});
});
