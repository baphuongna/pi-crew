import assert from "node:assert/strict";
import test from "node:test";
import {
	__test_resetSessionModel,
	captureRunModelContext,
	currentSessionModel,
	currentSessionThinking,
	noteSessionModel,
	noteSessionThinking,
	registryFromModelContext,
	resolveParentModel,
	sessionModelSnapshot,
} from "../../../../src/runtime/model/session-model.ts";

test("noteSessionModel accepts Model objects", () => {
	__test_resetSessionModel();
	noteSessionModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
	assert.equal(currentSessionModel(), "anthropic/claude-sonnet-4-5");
});

test("noteSessionModel accepts provider/id strings", () => {
	__test_resetSessionModel();
	noteSessionModel("minimax/MiniMax-M3");
	assert.equal(currentSessionModel(), "minimax/MiniMax-M3");
});

test("noteSessionModel ignores unrecognized input", () => {
	__test_resetSessionModel();
	noteSessionModel({ provider: "anthropic", id: "claude-sonnet-4-5" });
	noteSessionModel(42);
	noteSessionModel(null);
	noteSessionModel({});
	assert.equal(currentSessionModel(), "anthropic/claude-sonnet-4-5");
});

test("session_start seed does not overwrite model_select value", () => {
	__test_resetSessionModel();
	// model_select fires first (restore), then session_start tries to seed.
	noteSessionModel("minimax/MiniMax-M3", "model_select");
	noteSessionModel({ provider: "anthropic", id: "claude-sonnet-4-5" }, "session_start");
	assert.equal(currentSessionModel(), "minimax/MiniMax-M3");
});

test("session_start seed works when no model_select has fired", () => {
	__test_resetSessionModel();
	noteSessionModel({ provider: "anthropic", id: "claude-sonnet-4-5" }, "session_start");
	assert.equal(currentSessionModel(), "anthropic/claude-sonnet-4-5");
});

test("noteSessionThinking records and clears", () => {
	__test_resetSessionModel();
	noteSessionThinking("high");
	assert.equal(currentSessionThinking(), "high");
	noteSessionThinking("off");
	assert.equal(currentSessionThinking(), undefined);
});

test("noteSessionThinking ignores non-string input", () => {
	__test_resetSessionModel();
	noteSessionThinking("medium");
	noteSessionThinking(undefined);
	noteSessionThinking(null);
	assert.equal(currentSessionThinking(), "medium");
});

test("resolveParentModel prefers tracked value over ctx.model", () => {
	__test_resetSessionModel();
	noteSessionModel("minimax/MiniMax-M3");
	assert.equal(resolveParentModel({ provider: "anthropic", id: "claude-sonnet-4-5" }), "minimax/MiniMax-M3");
});

test("resolveParentModel falls back to ctx.model when nothing tracked", () => {
	__test_resetSessionModel();
	assert.equal(resolveParentModel({ provider: "anthropic", id: "claude-sonnet-4-5" }), "anthropic/claude-sonnet-4-5");
	assert.equal(resolveParentModel("openai/gpt-5"), "openai/gpt-5");
	assert.equal(resolveParentModel(undefined), undefined);
});

test("sessionModelSnapshot returns source and timestamp", () => {
	__test_resetSessionModel();
	noteSessionModel("minimax/MiniMax-M3");
	const snap = sessionModelSnapshot();
	assert.equal(snap.source, "model_select");
	assert.equal(snap.model, "minimax/MiniMax-M3");
	assert.ok(snap.updatedAt);
});

test("captureRunModelContext returns undefined when nothing to persist", () => {
	__test_resetSessionModel();
	assert.equal(captureRunModelContext({}), undefined);
});

test("captureRunModelContext captures parent model and override", () => {
	__test_resetSessionModel();
	noteSessionModel("minimax/MiniMax-M3");
	noteSessionThinking("high");
	const ctx = captureRunModelContext({ model: { provider: "anthropic", id: "claude-sonnet-4-5" } }, "openai/gpt-5");
	assert.equal(ctx?.parentModel, "minimax/MiniMax-M3");
	assert.equal(ctx?.override, "openai/gpt-5");
	assert.equal(ctx?.parentThinking, "high");
});

test("captureRunModelContext captures registry models", () => {
	__test_resetSessionModel();
	const registry = {
		getAvailable: () => [
			{ provider: "openai-codex", id: "gpt-5.5" },
			{ provider: "openai-codex", id: "gpt-5-mini" },
		],
	};
	const ctx = captureRunModelContext({ modelRegistry: registry });
	assert.deepEqual(ctx?.availableModels, ["openai-codex/gpt-5.5", "openai-codex/gpt-5-mini"]);
});

test("registryFromModelContext rebuilds a registry-shaped object", () => {
	const registry = registryFromModelContext({
		availableModels: ["openai-codex/gpt-5.5", "gemini/gemini-pro"],
	});
	assert.ok(registry);
	assert.deepEqual(registry.getAvailable(), [
		{ provider: "openai-codex", id: "gpt-5.5" },
		{ provider: "gemini", id: "gemini-pro" },
	]);
});

test("registryFromModelContext returns undefined for empty/missing models", () => {
	assert.equal(registryFromModelContext(undefined), undefined);
	assert.equal(registryFromModelContext({}), undefined);
	assert.equal(registryFromModelContext({ availableModels: [] }), undefined);
});
