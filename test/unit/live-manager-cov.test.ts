import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import {
	clearLiveAgentsForTest,
	evictStaleLiveAgentHandles,
	followUpLiveAgent,
	getLiveAgent,
	getLiveAgentContextPercent,
	listActiveLiveAgents,
	listLiveAgents,
	listLiveAgentsByWorkspace,
	markLiveAgentCompleted,
	registerLiveAgent,
	steerLiveAgent,
	stopLiveAgent,
	terminateLiveAgentsForRun,
	trackLiveAgentResponseText,
	trackLiveAgentToolEnd,
	trackLiveAgentToolStart,
	trackLiveAgentTurnEnd,
	updateLiveAgentStatus,
} from "../../src/runtime/live-agent-manager.ts";

function makeSession() {
	return {
		steer: async () => {},
		prompt: async () => {},
		abort: async () => {},
		dispose: () => {},
		getSessionStats: () => ({ contextUsage: { percent: 42 } }),
	};
}

test.afterEach(() => clearLiveAgentsForTest());

describe("registerLiveAgent", () => {
	it("registers a live agent and returns a handle", () => {
		const handle = registerLiveAgent({
			agentId: "agent-1",
			taskId: "task-1",
			runId: "run-1",
			workspaceId: "ws-1",
			role: "explorer",
			agent: "explorer",
			description: "test",
			session: makeSession(),
			status: "running",
		});
		assert.equal(handle.agentId, "agent-1");
		assert.equal(handle.status, "running");
		assert.ok(handle.createdAt);
		assert.ok(handle.updatedAt);
	});

	it("preserves pending steers when re-registering", () => {
		const s = makeSession();
		const handle1 = registerLiveAgent({
			agentId: "agent-2",
			taskId: "task-2",
			runId: "run-2",
			workspaceId: "ws-1",
			session: { ...s, steer: undefined },
			status: "running",
		});
		handle1.pendingSteers.push("hello");
		// Re-register with steer capability
		const steered: string[] = [];
		registerLiveAgent({
			agentId: "agent-2",
			taskId: "task-2",
			runId: "run-2",
			workspaceId: "ws-1",
			session: {
				...s,
				steer: async (msg: string) => {
					steered.push(msg);
				},
			},
			status: "running",
		});
		assert.deepEqual(steered, ["hello"]);
	});

	it("assigns default activity with startedAtMs", () => {
		const handle = registerLiveAgent({
			agentId: "agent-3",
			taskId: "task-3",
			runId: "run-3",
			workspaceId: "ws-1",
			session: makeSession(),
			status: "running",
		});
		assert.ok(handle.activity.startedAtMs > 0);
		assert.equal(handle.activity.toolUses, 0);
		assert.equal(handle.activity.turnCount, 0);
	});
});

describe("listLiveAgents / listLiveAgentsByWorkspace", () => {
	it("lists all registered agents", () => {
		registerLiveAgent({
			agentId: "a1",
			taskId: "t1",
			runId: "r1",
			workspaceId: "ws-1",
			session: makeSession(),
			status: "running",
		});
		registerLiveAgent({
			agentId: "a2",
			taskId: "t2",
			runId: "r1",
			workspaceId: "ws-1",
			session: makeSession(),
			status: "completed",
		});
		assert.equal(listLiveAgents().length, 2);
	});

	it("filters by workspace", () => {
		registerLiveAgent({
			agentId: "a3",
			taskId: "t3",
			runId: "r2",
			workspaceId: "ws-a",
			session: makeSession(),
			status: "running",
		});
		registerLiveAgent({
			agentId: "a4",
			taskId: "t4",
			runId: "r2",
			workspaceId: "ws-b",
			session: makeSession(),
			status: "running",
		});
		assert.equal(listLiveAgentsByWorkspace("ws-a").length, 1);
		assert.equal(listLiveAgentsByWorkspace("ws-b").length, 1);
		assert.equal(listLiveAgentsByWorkspace("ws-c").length, 0);
	});
});

describe("getLiveAgent", () => {
	it("finds agent by agentId", () => {
		registerLiveAgent({
			agentId: "find-me",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		const found = getLiveAgent("find-me");
		assert.ok(found);
		assert.equal(found!.agentId, "find-me");
	});

	it("finds agent by taskId", () => {
		registerLiveAgent({
			agentId: "by-task",
			taskId: "special-task",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		const found = getLiveAgent("special-task");
		assert.ok(found);
		assert.equal(found!.taskId, "special-task");
	});

	it("returns undefined for unknown agent", () => {
		assert.equal(getLiveAgent("nonexistent"), undefined);
	});
});

describe("updateLiveAgentStatus", () => {
	it("updates status and updatedAt", () => {
		registerLiveAgent({
			agentId: "status-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		const before = getLiveAgent("status-agent")!.updatedAt;
		updateLiveAgentStatus("status-agent", "completed");
		const after = getLiveAgent("status-agent")!;
		assert.equal(after.status, "completed");
		assert.ok(after.updatedAt >= before);
	});

	it("does nothing for unknown agent", () => {
		// Should not throw
		updateLiveAgentStatus("unknown", "completed");
	});
});

describe("steerLiveAgent", () => {
	it("steers a registered agent", async () => {
		const steered: string[] = [];
		registerLiveAgent({
			agentId: "steer-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: {
				...makeSession(),
				steer: async (msg: string) => {
					steered.push(msg);
				},
			},
			status: "running",
		});
		await steerLiveAgent("steer-agent", "go faster");
		assert.deepEqual(steered, ["go faster"]);
	});

	it("throws for unknown agent", async () => {
		await assert.rejects(() => steerLiveAgent("unknown", "msg"), /not registered/);
	});
});

describe("followUpLiveAgent", () => {
	it("sends follow-up prompt to agent", async () => {
		const prompted: string[] = [];
		registerLiveAgent({
			agentId: "follow-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: {
				...makeSession(),
				prompt: async (msg: string) => {
					prompted.push(msg);
				},
			},
			status: "running",
		});
		await followUpLiveAgent("follow-agent", "check this");
		assert.equal(prompted.length, 1);
		assert.ok(prompted[0]!.includes("check this"));
	});

	it("queues follow-up when prompt is not available", async () => {
		registerLiveAgent({
			agentId: "follow-no-prompt",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: { ...makeSession(), prompt: undefined },
			status: "running",
		});
		const handle = await followUpLiveAgent("follow-no-prompt", "queued");
		assert.equal(handle.pendingFollowUps.length, 1);
	});
});

describe("stopLiveAgent", () => {
	it("stops a running agent", async () => {
		let aborted = false;
		registerLiveAgent({
			agentId: "stop-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: {
				...makeSession(),
				abort: async () => {
					aborted = true;
				},
			},
			status: "running",
		});
		const result = await stopLiveAgent("stop-agent");
		assert.equal(result.status, "stopped");
		assert.equal(aborted, true);
	});

	it("throws for unknown agent", async () => {
		await assert.rejects(() => stopLiveAgent("unknown"), /not registered/);
	});
});

describe("terminateLiveAgentsForRun", () => {
	it("terminates all agents for a given run", async () => {
		registerLiveAgent({
			agentId: "r1a",
			taskId: "t1",
			runId: "run-x",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		registerLiveAgent({
			agentId: "r1b",
			taskId: "t2",
			runId: "run-x",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		registerLiveAgent({
			agentId: "r2a",
			taskId: "t3",
			runId: "run-y",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		const count = await terminateLiveAgentsForRun("run-x", "failed");
		assert.equal(count, 2);
	});
});

describe("trackLiveAgentToolStart/End", () => {
	it("tracks tool usage", () => {
		registerLiveAgent({
			agentId: "tool-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		trackLiveAgentToolStart("tool-agent", "bash");
		trackLiveAgentToolStart("tool-agent", "read");
		const handle = getLiveAgent("tool-agent")!;
		assert.equal(handle.activity.toolUses, 2);
		assert.ok(handle.activity.activeTools.has("bash"));
		assert.ok(handle.activity.activeTools.has("read"));
		trackLiveAgentToolEnd("tool-agent", "bash");
		assert.ok(!handle.activity.activeTools.has("bash"));
		assert.ok(handle.activity.activeTools.has("read"));
	});

	it("does nothing for unknown agent", () => {
		// Should not throw
		trackLiveAgentToolStart("unknown", "tool");
		trackLiveAgentToolEnd("unknown", "tool");
	});
});

describe("trackLiveAgentTurnEnd", () => {
	it("increments turn count", () => {
		registerLiveAgent({
			agentId: "turn-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		trackLiveAgentTurnEnd("turn-agent");
		trackLiveAgentTurnEnd("turn-agent");
		assert.equal(getLiveAgent("turn-agent")!.activity.turnCount, 2);
	});

	it("tracks compaction when flag is true", () => {
		registerLiveAgent({
			agentId: "compact-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		trackLiveAgentTurnEnd("compact-agent", true);
		assert.equal(getLiveAgent("compact-agent")!.activity.compactionCount, 1);
	});
});

describe("trackLiveAgentResponseText", () => {
	it("stores last 200 chars of response text", () => {
		registerLiveAgent({
			agentId: "resp-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		const longText = "x".repeat(300);
		trackLiveAgentResponseText("resp-agent", longText);
		const handle = getLiveAgent("resp-agent")!;
		assert.equal(handle.activity.responseText.length, 200);
	});
});

describe("markLiveAgentCompleted", () => {
	it("sets completedAtMs and clears active tools", () => {
		registerLiveAgent({
			agentId: "done-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		trackLiveAgentToolStart("done-agent", "tool");
		markLiveAgentCompleted("done-agent");
		const handle = getLiveAgent("done-agent")!;
		assert.ok(handle.activity.completedAtMs > 0);
		assert.equal(handle.activity.activeTools.size, 0);
	});
});

describe("evictStaleLiveAgentHandles", () => {
	it("evicts completed agents older than 10 minutes", () => {
		registerLiveAgent({
			agentId: "old-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "completed",
		});
		const handle = getLiveAgent("old-agent")!;
		// Set updatedAt to 11 minutes ago
		const elevenMinutesAgo = new Date(Date.now() - 11 * 60 * 1000).toISOString();
		handle.updatedAt = elevenMinutesAgo;
		const evicted = evictStaleLiveAgentHandles();
		assert.equal(evicted, 1);
		assert.equal(getLiveAgent("old-agent"), undefined);
	});

	it("keeps recently completed agents", () => {
		registerLiveAgent({
			agentId: "fresh-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "completed",
		});
		const evicted = evictStaleLiveAgentHandles();
		assert.equal(evicted, 0);
		assert.ok(getLiveAgent("fresh-agent"));
	});
});

describe("listActiveLiveAgents", () => {
	it("returns only running/queued/waiting agents", () => {
		registerLiveAgent({
			agentId: "running",
			taskId: "t1",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		registerLiveAgent({
			agentId: "completed",
			taskId: "t2",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "completed",
		});
		registerLiveAgent({
			agentId: "queued",
			taskId: "t3",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "queued",
		});
		const active = listActiveLiveAgents();
		assert.equal(active.length, 2);
		assert.ok(active.every((a) => a.status === "running" || a.status === "queued"));
	});
});

describe("getLiveAgentContextPercent", () => {
	it("returns context percent for running agent", () => {
		registerLiveAgent({
			agentId: "ctx-agent",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "running",
		});
		const pct = getLiveAgentContextPercent("ctx-agent");
		assert.equal(pct, 42);
	});

	it("returns null for unknown agent", () => {
		assert.equal(getLiveAgentContextPercent("unknown"), null);
	});

	it("returns null for non-running agent", () => {
		registerLiveAgent({
			agentId: "done-ctx",
			taskId: "t",
			runId: "r",
			workspaceId: "ws",
			session: makeSession(),
			status: "completed",
		});
		assert.equal(getLiveAgentContextPercent("done-ctx"), null);
	});
});
