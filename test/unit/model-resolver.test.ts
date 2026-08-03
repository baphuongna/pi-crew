import assert from "node:assert/strict";
import test from "node:test";
import { fuzzyResolveModelId, type SimpleModelEntry } from "../../src/runtime/model/model-resolver.ts";

const sampleModels: SimpleModelEntry[] = [
	{ id: "gpt-4", provider: "openai" },
	{ id: "claude-3", provider: "anthropic", name: "Claude 3" },
	{ id: "gpt-4-turbo", provider: "openai" },
];

test("exact match by id (case-insensitive)", () => {
	assert.equal(fuzzyResolveModelId("gpt-4", sampleModels), "openai/gpt-4");
	assert.equal(fuzzyResolveModelId("GPT-4", sampleModels), "openai/gpt-4");
	assert.equal(fuzzyResolveModelId("Claude-3", sampleModels), "anthropic/claude-3");
});

test("exact match by fullId provider/id (case-insensitive)", () => {
	assert.equal(fuzzyResolveModelId("openai/gpt-4", sampleModels), "openai/gpt-4");
	assert.equal(fuzzyResolveModelId("OpenAI/GPT-4", sampleModels), "openai/gpt-4");
	assert.equal(fuzzyResolveModelId("anthropic/claude-3", sampleModels), "anthropic/claude-3");
});

test("fuzzy partial match by id substring", () => {
	assert.equal(fuzzyResolveModelId("gpt", sampleModels), "openai/gpt-4");
	assert.equal(fuzzyResolveModelId("turbo", sampleModels), "openai/gpt-4-turbo");
	assert.equal(fuzzyResolveModelId("claude", sampleModels), "anthropic/claude-3");
});

test("fuzzy match by name substring", () => {
	assert.equal(fuzzyResolveModelId("claude 3", sampleModels), "anthropic/claude-3");
	assert.equal(fuzzyResolveModelId("Claude 3", sampleModels), "anthropic/claude-3");
});

test("fuzzy match by split words across id/name/provider", () => {
	assert.equal(fuzzyResolveModelId("openai gpt", sampleModels), "openai/gpt-4");
	assert.equal(fuzzyResolveModelId("anthropic claude", sampleModels), "anthropic/claude-3");
	assert.equal(fuzzyResolveModelId("openai-turbo", sampleModels), "openai/gpt-4-turbo");
});

test("returns undefined when no match meets threshold", () => {
	assert.equal(fuzzyResolveModelId("xyz", sampleModels), undefined);
	assert.equal(fuzzyResolveModelId("nonexistent-model", sampleModels), undefined);
});

test("returns best score when multiple partial matches", () => {
	// "gpt" matches both "gpt-4" (score 75) and "gpt-4-turbo" (score 67.5);
	// best score should win.
	assert.equal(fuzzyResolveModelId("gpt", sampleModels), "openai/gpt-4");

	// "4" matches both "gpt-4" and "gpt-4-turbo" via id inclusion;
	// "gpt-4" has higher score because query is a larger fraction of its id.
	assert.equal(fuzzyResolveModelId("4", sampleModels), "openai/gpt-4");
});
