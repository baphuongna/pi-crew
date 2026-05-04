import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildConfiguredModelRouting } from "../../src/runtime/model-fallback.ts";

describe("model inheritance precedence", () => {
	it("overrideModel takes precedence over stepModel", () => {
		const routing = buildConfiguredModelRouting({
			overrideModel: "gpt-5",
			stepModel: "claude-haiku-4-5",
			agentModel: "claude-sonnet-4-5",
			parentModel: undefined,
		});
		assert.equal(routing.requested, "gpt-5");
	});

	it("stepModel takes precedence over agentModel", () => {
		const routing = buildConfiguredModelRouting({
			stepModel: "claude-haiku-4-5",
			agentModel: "claude-sonnet-4-5",
			parentModel: undefined,
		});
		assert.equal(routing.requested, "claude-haiku-4-5");
	});

	it("agentModel takes precedence over parentModel", () => {
		const routing = buildConfiguredModelRouting({
			agentModel: "claude-sonnet-4-5",
			parentModel: { provider: "anthropic", id: "claude-opus-4" },
		});
		assert.equal(routing.requested, "claude-sonnet-4-5");
	});

	it("parentModel used when no agent model", () => {
		const routing = buildConfiguredModelRouting({
			agentModel: undefined,
			parentModel: { provider: "anthropic", id: "claude-opus-4" },
		});
		assert.equal(routing.requested, "anthropic/claude-opus-4");
	});

	it("all models specified: override wins", () => {
		const routing = buildConfiguredModelRouting({
			overrideModel: "gpt-5",
			stepModel: "claude-haiku-4-5",
			agentModel: "claude-sonnet-4-5",
			parentModel: { provider: "anthropic", id: "claude-opus-4" },
		});
		assert.equal(routing.requested, "gpt-5");
	});

	it("empty string agentModel falls back to parentModel", () => {
		const routing = buildConfiguredModelRouting({
			agentModel: "",
			parentModel: { provider: "anthropic", id: "claude-opus-4" },
		});
		// Empty agentModel is treated as unspecified → falls back to parentModel
		assert.equal(routing.requested, "anthropic/claude-opus-4");
	});
});
