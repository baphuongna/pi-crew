import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectLiveSessionHealth, formatLiveSessionDiagnostics, type LiveSessionHealth } from "../../src/runtime/live-session-health.ts";

describe("collectLiveSessionHealth", () => {
	it("returns zero counts for empty agents list", () => {
		const health = collectLiveSessionHealth([], () => undefined);
		assert.equal(health.totalAgents, 0);
		assert.equal(health.runningAgents, 0);
		assert.equal(health.idleAgents, 0);
		assert.equal(health.completedAgents, 0);
		assert.equal(health.failedAgents, 0);
		assert.equal(health.totalTokens, 0);
		assert.ok(health.timestamp);
	});

	it("counts agents by status correctly", () => {
		const agents = [
			{ status: "running", agentId: "a1" },
			{ status: "running", agentId: "a2" },
			{ status: "idle", agentId: "a3" },
			{ status: "completed", agentId: "a4" },
			{ status: "failed", agentId: "a5" },
		];
		const health = collectLiveSessionHealth(agents, () => undefined);
		assert.equal(health.totalAgents, 5);
		assert.equal(health.runningAgents, 2);
		assert.equal(health.idleAgents, 1);
		assert.equal(health.completedAgents, 1);
		assert.equal(health.failedAgents, 1);
	});

	it("ignores unknown status values", () => {
		const agents = [
			{ status: "pending", agentId: "a1" },
			{ status: "unknown", agentId: "a2" },
		];
		const health = collectLiveSessionHealth(agents, () => undefined);
		assert.equal(health.totalAgents, 2);
		assert.equal(health.runningAgents, 0);
		assert.equal(health.idleAgents, 0);
		assert.equal(health.completedAgents, 0);
		assert.equal(health.failedAgents, 0);
	});

	it("sums tokens from getUsage for agents with agentId", () => {
		const agents = [
			{ status: "running", agentId: "a1" },
			{ status: "running", agentId: "a2" },
			{ status: "running" }, // no agentId
		];
		const getUsage = (id: string) => {
			if (id === "a1") return { input: 100, output: 50 };
			if (id === "a2") return { input: 200, output: 80 };
			return undefined;
		};
		const health = collectLiveSessionHealth(agents, getUsage);
		assert.equal(health.totalTokens, 430); // 100+50+200+80
	});

	it("handles getUsage returning undefined", () => {
		const agents = [{ status: "running", agentId: "a1" }];
		const health = collectLiveSessionHealth(agents, () => undefined);
		assert.equal(health.totalTokens, 0);
	});

	it("produces a valid ISO timestamp", () => {
		const health = collectLiveSessionHealth([], () => undefined);
		assert.ok(!Number.isNaN(Date.parse(health.timestamp)));
	});
});

describe("formatLiveSessionDiagnostics", () => {
	it("formats a single-line diagnostic summary", () => {
		const health: LiveSessionHealth = {
			totalAgents: 3,
			runningAgents: 1,
			idleAgents: 0,
			completedAgents: 1,
			failedAgents: 1,
			totalTokens: 500,
			timestamp: new Date().toISOString(),
		};
		const text = formatLiveSessionDiagnostics(health);
		assert.ok(text.includes("agents=3"));
		assert.ok(text.includes("running=1"));
		assert.ok(text.includes("idle=0"));
		assert.ok(text.includes("completed=1"));
		assert.ok(text.includes("failed=1"));
		assert.ok(text.includes("tokens=500"));
	});

	it("includes [Live-Session Health] prefix", () => {
		const health: LiveSessionHealth = {
			totalAgents: 0,
			runningAgents: 0,
			idleAgents: 0,
			completedAgents: 0,
			failedAgents: 0,
			totalTokens: 0,
			timestamp: new Date().toISOString(),
		};
		const text = formatLiveSessionDiagnostics(health);
		assert.ok(text.startsWith("[Live-Session Health]"));
	});

	it("handles all-zero health", () => {
		const health: LiveSessionHealth = {
			totalAgents: 0,
			runningAgents: 0,
			idleAgents: 0,
			completedAgents: 0,
			failedAgents: 0,
			totalTokens: 0,
			timestamp: "",
		};
		const text = formatLiveSessionDiagnostics(health);
		assert.ok(text.includes("agents=0"));
		assert.ok(text.includes("tokens=0"));
	});
});
