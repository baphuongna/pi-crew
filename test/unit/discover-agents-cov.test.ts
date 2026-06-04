import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	registerDynamicAgent,
	unregisterDynamicAgent,
	listDynamicAgents,
	allAgents,
	clearSecurityEventLog,
	getSecurityEventLog,
	invalidateAgentDiscoveryCache,
	getCacheVersion,
	sanitizeAgentSystemPrompt,
} from "../../src/agents/discover-agents.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

function makeDynamicAgent(name: string): AgentConfig {
	return {
		name,
		description: `Dynamic agent ${name}`,
		source: "dynamic",
		filePath: "<test>",
		systemPrompt: `You are ${name}.`,
	};
}

describe("registerDynamicAgent", () => {
	it("registers a valid dynamic agent", () => {
		clearSecurityEventLog();
		const agent = makeDynamicAgent("my-custom-bot");
		registerDynamicAgent(agent);
		const listed = listDynamicAgents();
		const found = listed.find((a) => a.name === "my-custom-bot");
		assert.ok(found);
		assert.equal(found.source, "dynamic");
		// Cleanup
		unregisterDynamicAgent("my-custom-bot");
	});

	it("throws when registering a protected builtin name", () => {
		clearSecurityEventLog();
		assert.throws(
			() => registerDynamicAgent(makeDynamicAgent("executor")),
			/protected builtin name/i,
		);
	});

	it("throws when registering a pattern-matching protected name", () => {
		clearSecurityEventLog();
		assert.throws(
			() => registerDynamicAgent(makeDynamicAgent("executor-v2")),
			/protected pattern/i,
		);
	});

	it("throws when registering duplicate agent", () => {
		clearSecurityEventLog();
		registerDynamicAgent(makeDynamicAgent("unique-test-agent"));
		assert.throws(
			() => registerDynamicAgent(makeDynamicAgent("unique-test-agent")),
			/already registered/i,
		);
		unregisterDynamicAgent("unique-test-agent");
	});

	it("logs security event on blocked registration", () => {
		clearSecurityEventLog();
		try { registerDynamicAgent(makeDynamicAgent("planner")); } catch { /* expected */ }
		const events = getSecurityEventLog();
		assert.equal(events.length, 1);
		assert.equal(events[0].type, "AGENT_REGISTRATION_BLOCKED");
		assert.equal(events[0].name, "planner");
		clearSecurityEventLog();
	});
});

describe("unregisterDynamicAgent", () => {
	it("removes a registered agent", () => {
		clearSecurityEventLog();
		registerDynamicAgent(makeDynamicAgent("temp-agent"));
		unregisterDynamicAgent("temp-agent");
		const listed = listDynamicAgents();
		assert.ok(!listed.find((a) => a.name === "temp-agent"));
	});

	it("throws when agent not found", () => {
		assert.throws(
			() => unregisterDynamicAgent("nonexistent-agent"),
			/not found/i,
		);
	});

	it("is case-insensitive for lookup", () => {
		clearSecurityEventLog();
		registerDynamicAgent(makeDynamicAgent("CaseAgent"));
		unregisterDynamicAgent("caseagent");
		const listed = listDynamicAgents();
		assert.ok(!listed.find((a) => a.name === "CaseAgent"));
	});
});

describe("listDynamicAgents", () => {
	it("returns empty array after clearing all agents", () => {
		clearSecurityEventLog();
		registerDynamicAgent(makeDynamicAgent("list-test-a"));
		unregisterDynamicAgent("list-test-a");
		assert.deepEqual(listDynamicAgents().filter((a) => a.name === "list-test-a"), []);
	});

	it("returns all registered agents", () => {
		clearSecurityEventLog();
		registerDynamicAgent(makeDynamicAgent("list-test-b"));
		registerDynamicAgent(makeDynamicAgent("list-test-c"));
		const listed = listDynamicAgents();
		const names = listed.map((a) => a.name);
		assert.ok(names.includes("list-test-b"));
		assert.ok(names.includes("list-test-c"));
		unregisterDynamicAgent("list-test-b");
		unregisterDynamicAgent("list-test-c");
	});
});

describe("allAgents", () => {
	it("returns empty array for undefined discovery", () => {
		assert.deepEqual(allAgents(undefined), []);
	});

	it("merges project, builtin, user agents with user priority", () => {
		clearSecurityEventLog();
		const makeAgent = (name: string, source: AgentConfig["source"]): AgentConfig => ({
			name, description: `${source} ${name}`, source, filePath: `<${source}>`, systemPrompt: "",
		});
		const discovery = {
			project: [makeAgent("shared", "project")],
			builtin: [makeAgent("shared", "builtin")],
			user: [makeAgent("shared", "user")],
		};
		const result = allAgents(discovery);
		const shared = result.find((a) => a.name === "shared");
		assert.ok(shared);
		assert.equal(shared!.source, "user", "user should win over project and builtin");
	});

	it("excludes disabled agents", () => {
		clearSecurityEventLog();
		const makeAgent = (name: string, disabled: boolean): AgentConfig => ({
			name, description: name, source: "builtin", filePath: "", systemPrompt: "", disabled,
		});
		const discovery = {
			project: [],
			builtin: [makeAgent("active", false), makeAgent("inactive", true)],
			user: [],
		};
		const result = allAgents(discovery);
		const names = result.map((a) => a.name);
		assert.ok(names.includes("active"));
		assert.ok(!names.includes("inactive"));
	});

	it("dynamic agents fill gaps but do not override existing", () => {
		clearSecurityEventLog();
		registerDynamicAgent(makeDynamicAgent("dynamic-only"));
		const discovery = { project: [], builtin: [], user: [] };
		const result = allAgents(discovery);
		assert.ok(result.find((a) => a.name === "dynamic-only"));
		unregisterDynamicAgent("dynamic-only");
	});
});

describe("getCacheVersion / invalidateAgentDiscoveryCache", () => {
	it("cache version increments on invalidation", () => {
		const before = getCacheVersion();
		invalidateAgentDiscoveryCache();
		const after = getCacheVersion();
		assert.ok(after > before, "cache version should increment");
	});
});

describe("sanitizeAgentSystemPrompt", () => {
	it("strips zero-width chars for all trust levels", () => {
		const result = sanitizeAgentSystemPrompt("hello\u200Bworld", "builtin");
		assert.equal(result, "helloworld");
	});

	it("builtin trust preserves SYSTEM: directives", () => {
		const result = sanitizeAgentSystemPrompt("SYSTEM: ok", "builtin");
		assert.equal(result, "SYSTEM: ok");
	});

	it("user trust strips SYSTEM: directives", () => {
		const result = sanitizeAgentSystemPrompt("SYSTEM: bad", "user");
		assert.ok(!result.includes("SYSTEM:"));
	});

	it("project trust strips role assignment patterns", () => {
		const result = sanitizeAgentSystemPrompt("role: admin", "project");
		assert.ok(!result.includes("role:"));
	});
});
