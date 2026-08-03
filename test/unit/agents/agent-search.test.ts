import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentConfig } from "../../../src/agents/agent-config.ts";
import { buildAgentSearchIndex, searchAgents } from "../../../src/agents/agent-search.ts";

function makeAgent(overrides: Partial<AgentConfig> & { name: string }): AgentConfig {
	return {
		systemPrompt: "",
		filePath: "",
		description: "",
		source: "builtin",
		...overrides,
	};
}

describe("agent-search", () => {
	it("ranks agents by BM25 relevance", () => {
		const agents = [
			makeAgent({
				name: "explorer",
				description: "Fast codebase discovery and file mapping",
			}),
			makeAgent({
				name: "planner",
				description: "Create execution plans with clear sequencing",
			}),
			makeAgent({
				name: "executor",
				description: "Implement planned code changes",
			}),
			makeAgent({
				name: "reviewer",
				description: "Review code for correctness and regressions",
			}),
		];
		const index = buildAgentSearchIndex(agents);
		const results = searchAgents(index, "explore codebase files", 3);
		assert.ok(results.length > 0);
		assert.equal(results[0].agent.name, "explorer", "explorer should rank first for exploration query");
	});

	it("returns empty for empty query", () => {
		const agents = [makeAgent({ name: "test" })];
		const index = buildAgentSearchIndex(agents);
		assert.deepEqual(searchAgents(index, "", 5), []);
		assert.deepEqual(searchAgents(index, "!!!", 5), []);
	});

	it("returns empty for empty index", () => {
		const index = buildAgentSearchIndex([]);
		assert.deepEqual(searchAgents(index, "find bugs", 5), []);
	});

	it("respects limit parameter", () => {
		const agents = Array.from({ length: 10 }, (_, i) => makeAgent({ name: `agent-${i}`, description: `Agent number ${i}` }));
		const index = buildAgentSearchIndex(agents);
		const results = searchAgents(index, "agent", 3);
		assert.ok(results.length <= 3);
	});

	it("tokenizes camelCase and snake_case names", () => {
		const agents = [
			makeAgent({ name: "code-reviewer", description: "Reviews code" }),
			makeAgent({ name: "test-engineer", description: "Writes tests" }),
		];
		const index = buildAgentSearchIndex(agents);
		const results = searchAgents(index, "code review", 3);
		assert.ok(results.length > 0);
		assert.equal(results[0].agent.name, "code-reviewer");
	});

	it("scores agent name higher than description", () => {
		const agents = [
			makeAgent({
				name: "security-reviewer",
				description: "Review general changes",
			}),
			makeAgent({
				name: "general-helper",
				description: "Security audit and vulnerability scanning",
			}),
		];
		const index = buildAgentSearchIndex(agents);
		const results = searchAgents(index, "security", 2);
		assert.ok(results.length >= 2);
		// Name match should score higher than description match
		assert.equal(results[0].agent.name, "security-reviewer");
	});

	it("handles duplicate terms in query", () => {
		const agents = [makeAgent({ name: "test-agent", description: "Testing agent" })];
		const index = buildAgentSearchIndex(agents);
		const results = searchAgents(index, "test test test", 5);
		assert.ok(results.length > 0);
		assert.ok(results[0].score > 0);
	});

	it("builds index with correct average length", () => {
		const agents = [
			makeAgent({ name: "a", description: "short" }),
			makeAgent({
				name: "b",
				description: "much longer description with many words",
			}),
		];
		const index = buildAgentSearchIndex(agents);
		assert.ok(index.averageLength > 0);
		assert.ok(index.documents.length === 2);
		assert.ok(index.documentFrequencies.size > 0);
	});
});
