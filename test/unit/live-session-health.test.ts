import test from "node:test";
import assert from "node:assert/strict";
import {
	collectLiveSessionHealth,
	formatLiveSessionDiagnostics,
} from "../../src/runtime/live-session-health.ts";
import type { LiveSessionHealth } from "../../src/runtime/live-session-health.ts";

/**
 * Round 28 (test coverage gaps): `live-session-health.ts` provides health
 * snapshots and diagnostics for live-session workers.
 *
 * Both exports are pure functions — no file I/O.
 */

// ─── collectLiveSessionHealth ──────────────────────────────────────────────

test("collectLiveSessionHealth: empty agents list", () => {
	const health = collectLiveSessionHealth([], () => undefined);
	assert.equal(health.totalAgents, 0);
	assert.equal(health.runningAgents, 0);
	assert.equal(health.idleAgents, 0);
	assert.equal(health.completedAgents, 0);
	assert.equal(health.failedAgents, 0);
	assert.equal(health.totalTokens, 0);
	assert.ok(health.timestamp);
});

test("collectLiveSessionHealth: counts running agents", () => {
	const agents = [{ status: "running" }, { status: "running" }, { status: "completed" }];
	const health = collectLiveSessionHealth(agents, () => undefined);
	assert.equal(health.runningAgents, 2);
	assert.equal(health.completedAgents, 1);
	assert.equal(health.totalAgents, 3);
});

test("collectLiveSessionHealth: counts all status types", () => {
	const agents = [
		{ status: "running" },
		{ status: "idle" },
		{ status: "completed" },
		{ status: "failed" },
		{ status: "queued" },
	];
	const health = collectLiveSessionHealth(agents, () => undefined);
	assert.equal(health.runningAgents, 1);
	assert.equal(health.idleAgents, 1);
	assert.equal(health.completedAgents, 1);
	assert.equal(health.failedAgents, 1);
	assert.equal(health.totalAgents, 5);
});

test("collectLiveSessionHealth: sums tokens from getUsage", () => {
	const agents = [
		{ status: "running", agentId: "a1" },
		{ status: "completed", agentId: "a2" },
	];
	const getUsage = (id: string) => {
		if (id === "a1") return { input: 100, output: 50 };
		if (id === "a2") return { input: 200, output: 150 };
		return undefined;
	};
	const health = collectLiveSessionHealth(agents, getUsage);
	assert.equal(health.totalTokens, 500); // 150 + 350
});

test("collectLiveSessionHealth: handles missing usage gracefully", () => {
	const agents = [
		{ status: "running", agentId: "a1" },
		{ status: "running" }, // no agentId
	];
	const health = collectLiveSessionHealth(agents, () => undefined);
	assert.equal(health.totalTokens, 0);
});

test("collectLiveSessionHealth: timestamp is valid ISO string", () => {
	const health = collectLiveSessionHealth([], () => undefined);
	assert.ok(!isNaN(Date.parse(health.timestamp)));
});

// ─── formatLiveSessionDiagnostics ──────────────────────────────────────────

test("formatLiveSessionDiagnostics: formats health summary", () => {
	const health: LiveSessionHealth = {
		totalAgents: 5,
		runningAgents: 2,
		idleAgents: 1,
		completedAgents: 1,
		failedAgents: 1,
		totalTokens: 1234,
		timestamp: new Date().toISOString(),
	};
	const text = formatLiveSessionDiagnostics(health);
	assert.match(text, /agents=5/);
	assert.match(text, /running=2/);
	assert.match(text, /idle=1/);
	assert.match(text, /completed=1/);
	assert.match(text, /failed=1/);
	assert.match(text, /tokens=1234/);
});

test("formatLiveSessionDiagnostics: includes prefix label", () => {
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
	assert.match(text, /\[Live-Session Health\]/);
});
