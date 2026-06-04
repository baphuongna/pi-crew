import { describe, it } from "node:test";
import assert from "node:assert/strict";
import test from "node:test";
import {
	probeLiveSessionRuntime,
} from "../../src/runtime/live-session-runtime.ts";
import {
	clearLiveAgentsForTest,
	registerLiveAgent,
	getLiveAgent,
	trackLiveAgentToolStart,
	trackLiveAgentToolEnd,
	trackLiveAgentTurnEnd,
	markLiveAgentCompleted,
} from "../../src/runtime/live-agent-manager.ts";
import { clearLiveControlRealtimeForTest } from "../../src/runtime/live-control-realtime.ts";

test.afterEach(() => {
	clearLiveAgentsForTest();
	clearLiveControlRealtimeForTest();
});

describe("probeLiveSessionRuntime", () => {
	it("returns result with available boolean", async () => {
		const result = await probeLiveSessionRuntime();
		assert.ok(result !== null && result !== undefined);
		assert.strictEqual(typeof result.available, "boolean");
	});

	it("returns a string reason", async () => {
		const result = await probeLiveSessionRuntime();
		assert.strictEqual(typeof result.reason, "string");
		assert.ok(result.reason.length > 0);
	});

	it("returns consistent results on repeated calls", async () => {
		const r1 = await probeLiveSessionRuntime();
		const r2 = await probeLiveSessionRuntime();
		assert.equal(r1.available, r2.available);
		assert.equal(r1.reason, r2.reason);
	});
});

describe("live agent lifecycle (session-runtime context)", () => {
	it("tracks full agent lifecycle from registration to completion", () => {
		const session = {
			steer: async () => {},
			prompt: async () => {},
			abort: async () => {},
			dispose: () => {},
		};
		const handle = registerLiveAgent({
			agentId: "lifecycle-agent",
			taskId: "task-1",
			runId: "run-1",
			workspaceId: "ws-1",
			role: "executor",
			agent: "executor",
			session,
			status: "running",
		});

		// Simulate tool use
		trackLiveAgentToolStart("lifecycle-agent", "bash");
		assert.equal(handle.activity.toolUses, 1);
		assert.ok(handle.activity.activeTools.has("bash"));

		// Simulate tool end
		trackLiveAgentToolEnd("lifecycle-agent", "bash");
		assert.ok(!handle.activity.activeTools.has("bash"));

		// Simulate turn
		trackLiveAgentTurnEnd("lifecycle-agent");
		assert.equal(handle.activity.turnCount, 1);

		// Complete
		markLiveAgentCompleted("lifecycle-agent");
		assert.ok(handle.activity.completedAtMs > 0);
	});

	it("supports multiple concurrent agents with independent state", () => {
		const s1 = { steer: async () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} };
		const s2 = { steer: async () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} };
		registerLiveAgent({ agentId: "multi-1", taskId: "t1", runId: "r1", workspaceId: "ws", session: s1, status: "running" });
		registerLiveAgent({ agentId: "multi-2", taskId: "t2", runId: "r1", workspaceId: "ws", session: s2, status: "running" });

		trackLiveAgentToolStart("multi-1", "tool-a");
		trackLiveAgentToolStart("multi-2", "tool-b");

		const h1 = getLiveAgent("multi-1")!;
		const h2 = getLiveAgent("multi-2")!;
		assert.equal(h1.activity.toolUses, 1);
		assert.equal(h2.activity.toolUses, 1);
		assert.ok(h1.activity.activeTools.has("tool-a"));
		assert.ok(!h1.activity.activeTools.has("tool-b"));
		assert.ok(h2.activity.activeTools.has("tool-b"));
		assert.ok(!h2.activity.activeTools.has("tool-a"));
	});

	it("handles turn with compaction tracking", () => {
		const s = { steer: async () => {}, prompt: async () => {}, abort: async () => {}, dispose: () => {} };
		registerLiveAgent({ agentId: "compact", taskId: "t", runId: "r", workspaceId: "ws", session: s, status: "running" });

		trackLiveAgentTurnEnd("compact", false);
		trackLiveAgentTurnEnd("compact", true);
		trackLiveAgentTurnEnd("compact", false);

		const handle = getLiveAgent("compact")!;
		assert.equal(handle.activity.turnCount, 3);
		assert.equal(handle.activity.compactionCount, 1);
	});
});
