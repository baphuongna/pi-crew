import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAgentSessionOptions } from "../../src/agents/agent-config.ts";

describe("getAgentSessionOptions", () => {
	it("returns tools restriction for explorer role", () => {
		const opts = getAgentSessionOptions("explorer");
		assert.ok(opts.tools);
		assert.ok(opts.tools!.includes("read"));
		assert.ok(opts.excludeTools);
		assert.ok(opts.excludeTools!.includes("edit"));
	});

	it("returns tools restriction for reviewer role", () => {
		const opts = getAgentSessionOptions("reviewer");
		assert.ok(opts.tools);
		assert.ok(opts.tools!.includes("read"));
		assert.ok(opts.excludeTools);
		assert.ok(opts.excludeTools!.includes("edit"));
		assert.ok(opts.excludeTools!.includes("write"));
	});

	it("returns empty options for unknown role", () => {
		const opts = getAgentSessionOptions("nonexistent_role");
		assert.deepEqual(opts, {});
	});

	it("returns empty options for executor (full access)", () => {
		const opts = getAgentSessionOptions("executor");
		assert.deepEqual(opts, {});
	});

	it("returns excludeTools for analyst role", () => {
		const opts = getAgentSessionOptions("analyst");
		assert.ok(opts.excludeTools);
		assert.ok(opts.excludeTools!.includes("edit"));
	});

	it("returns tools and excludeTools for writer role", () => {
		const opts = getAgentSessionOptions("writer");
		assert.ok(opts.tools);
		assert.ok(opts.tools!.includes("read"));
		assert.ok(opts.excludeTools);
		assert.ok(opts.excludeTools!.includes("bash"));
	});

	it("returns strict restrictions for security_reviewer", () => {
		const opts = getAgentSessionOptions("security_reviewer");
		assert.ok(opts.tools);
		assert.ok(opts.tools!.length <= 3);
		assert.ok(opts.excludeTools!.includes("bash"));
		assert.ok(opts.excludeTools!.includes("edit"));
		assert.ok(opts.excludeTools!.includes("write"));
	});

	it("returns tools for test_engineer", () => {
		const opts = getAgentSessionOptions("test_engineer");
		assert.ok(opts.tools);
		assert.ok(opts.tools!.includes("bash"));
		assert.ok(opts.excludeTools);
		assert.ok(opts.excludeTools!.includes("web"));
	});

	it("returns tools for planner role", () => {
		const opts = getAgentSessionOptions("planner");
		assert.ok(opts.excludeTools);
		assert.ok(opts.excludeTools!.includes("ask_question"));
	});

	it("does not return tools for a role without explicit tools list", () => {
		const opts = getAgentSessionOptions("executor");
		assert.equal(opts.tools, undefined);
		assert.equal(opts.excludeTools, undefined);
	});
});
