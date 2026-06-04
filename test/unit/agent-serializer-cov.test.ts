import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { serializeAgent } from "../../src/agents/agent-serializer.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "A test agent",
		source: "project",
		filePath: "/test/agent.md",
		systemPrompt: "You are a test agent.",
		...overrides,
	};
}

describe("serializeAgent", () => {
	it("serializes a minimal agent with required fields", () => {
		const agent = makeAgent();
		const result = serializeAgent(agent);
		assert.ok(result.startsWith("---"));
		assert.ok(result.includes("name: test-agent"));
		assert.ok(result.includes("description: A test agent"));
		assert.ok(result.includes("You are a test agent."));
		// Should end with the system prompt and a trailing newline
		const lines = result.split("\n");
		assert.ok(lines[0] === "---");
	});

	it("serializes agent with model and tools", () => {
		const agent = makeAgent({
			model: "claude-3-opus",
			tools: ["bash", "read"],
		});
		const result = serializeAgent(agent);
		assert.ok(result.includes("model: claude-3-opus"));
		assert.ok(result.includes("tools: bash, read"));
	});

	it("serializes agent with routing metadata", () => {
		const agent = makeAgent({
			routing: {
				triggers: ["deploy", "ship"],
				useWhen: ["needs deployment"],
				avoidWhen: ["local testing"],
				cost: "cheap",
				category: "ops",
			},
		});
		const result = serializeAgent(agent);
		assert.ok(result.includes("triggers: deploy, ship"));
		assert.ok(result.includes("useWhen: needs deployment"));
		assert.ok(result.includes("avoidWhen: local testing"));
		assert.ok(result.includes("cost: cheap"));
		assert.ok(result.includes("category: ops"));
	});

	it("omits undefined optional fields", () => {
		const agent = makeAgent();
		const result = serializeAgent(agent);
		assert.ok(!result.includes("model:"));
		assert.ok(!result.includes("fallbackModels:"));
		assert.ok(!result.includes("tools:"));
	});

	it("serializes extensions as empty array", () => {
		const agent = makeAgent({ extensions: [] });
		const result = serializeAgent(agent);
		assert.ok(result.includes("extensions:"));
	});

	it("serializes extensions with values", () => {
		const agent = makeAgent({ extensions: ["ext-a", "ext-b"] });
		const result = serializeAgent(agent);
		assert.ok(result.includes("extensions: ext-a, ext-b"));
	});

	it("serializes boolean fields", () => {
		const agent = makeAgent({
			inheritProjectContext: true,
			inheritSkills: false,
		});
		const result = serializeAgent(agent);
		assert.ok(result.includes("inheritProjectContext: true"));
		assert.ok(result.includes("inheritSkills: false"));
	});

	it("serializes fallbackModels array", () => {
		const agent = makeAgent({
			fallbackModels: ["model-a", "model-b"],
		});
		const result = serializeAgent(agent);
		assert.ok(result.includes("fallbackModels: model-a, model-b"));
	});

	it("serializes systemPromptMode", () => {
		const agent = makeAgent({ systemPromptMode: "append" });
		const result = serializeAgent(agent);
		assert.ok(result.includes("systemPromptMode: append"));
	});

	it("serializes memory field", () => {
		const agent = makeAgent({ memory: "project" });
		const result = serializeAgent(agent);
		assert.ok(result.includes("memory: project"));
	});

	it("serializes loadMode field", () => {
		const agent = makeAgent({ loadMode: "lean" });
		const result = serializeAgent(agent);
		assert.ok(result.includes("loadMode: lean"));
	});

	it("serializes defaultTools array", () => {
		const agent = makeAgent({ defaultTools: ["bash", "read"] });
		const result = serializeAgent(agent);
		assert.ok(result.includes("defaultTools: bash, read"));
	});

	it("serializes contextMode field", () => {
		const agent = makeAgent({ contextMode: "fork" });
		const result = serializeAgent(agent);
		assert.ok(result.includes("contextMode: fork"));
	});

	it("handles multiline system prompt", () => {
		const agent = makeAgent({
			systemPrompt: "Line one\nLine two\nLine three",
		});
		const result = serializeAgent(agent);
		assert.ok(result.includes("Line one\nLine two\nLine three"));
	});

	it("trims trailing whitespace from system prompt", () => {
		const agent = makeAgent({
			systemPrompt: "  Hello world  ",
		});
		const result = serializeAgent(agent);
		assert.ok(result.includes("Hello world"));
	});

	it("serializes thinking field", () => {
		const agent = makeAgent({ thinking: "enabled" });
		const result = serializeAgent(agent);
		assert.ok(result.includes("thinking: enabled"));
	});

	it("serializes skills array", () => {
		const agent = makeAgent({ skills: ["skill-a", "skill-b"] });
		const result = serializeAgent(agent);
		assert.ok(result.includes("skills: skill-a, skill-b"));
	});
});
