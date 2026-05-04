import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildConfiguredModelRouting } from "../../src/runtime/model-fallback.ts";

describe("Parent model inheritance (B3)", () => {
	it("uses agent model when specified", () => {
		const routing = buildConfiguredModelRouting({
			agentModel: "claude-sonnet-4-5",
			parentModel: undefined,
		});
		assert.ok(routing.requested);
		assert.ok(routing.candidates.length > 0);
	});

	it("inherits parent model when agent has no model", () => {
		const routing = buildConfiguredModelRouting({
			agentModel: undefined,
			parentModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
		assert.ok(routing.requested);
		assert.equal(routing.requested, "anthropic/claude-sonnet-4-5");
	});

	it("override model takes precedence over agent model", () => {
		const routing = buildConfiguredModelRouting({
			overrideModel: "gpt-5",
			agentModel: "claude-sonnet-4-5",
			parentModel: undefined,
		});
		assert.equal(routing.requested, "gpt-5");
	});

	it("override model takes precedence over parent model", () => {
		const routing = buildConfiguredModelRouting({
			overrideModel: "gpt-5",
			agentModel: undefined,
			parentModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
		assert.equal(routing.requested, "gpt-5");
	});

	it("step model takes precedence over parent model", () => {
		const routing = buildConfiguredModelRouting({
			stepModel: "claude-haiku-4-5",
			agentModel: undefined,
			parentModel: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
		assert.equal(routing.requested, "claude-haiku-4-5");
	});

	it("no models specified returns undefined requested", () => {
		const routing = buildConfiguredModelRouting({
			agentModel: undefined,
			parentModel: undefined,
		});
		assert.equal(routing.requested, undefined);
	});
});
