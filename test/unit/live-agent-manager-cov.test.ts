import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CrewAgentStatus } from "../../src/runtime/crew-agent-runtime.ts";
import {
	broadcastIrcMessage,
	clearLiveAgentsForTest,
	evictStaleLiveAgentHandles,
	followUpLiveAgent,
	getLiveAgent,
	listActiveLiveAgents,
	listLiveAgents,
	listLiveAgentsByWorkspace,
	markLiveAgentCompleted,
	registerLiveAgent,
	sendIrcMessage,
	steerLiveAgent,
	terminateLiveAgent,
	trackLiveAgentResponseText,
	trackLiveAgentToolEnd,
	trackLiveAgentToolStart,
	trackLiveAgentTurnEnd,
	updateLiveAgentStatus,
} from "../../src/runtime/live-agent-manager.ts";

function makeHandle(
	overrides: {
		agentId?: string;
		taskId?: string;
		workspaceId?: string;
		status?: CrewAgentStatus;
		session?: Record<string, unknown>;
	} = {},
) {
	return {
		agentId: overrides.agentId ?? "agent_1",
		taskId: overrides.taskId ?? "task_1",
		runId: "run_1",
		workspaceId: overrides.workspaceId ?? "ws_1",
		role: "executor",
		agent: "test-agent",
		session: overrides.session ?? {},
		status: overrides.status ?? ("running" as CrewAgentStatus),
	};
}

describe("live-agent-manager", () => {
	// Reset between tests
	it("clearLiveAgentsForTest clears all agents", () => {
		registerLiveAgent(makeHandle({ agentId: "clear-test" }));
		assert.ok(getLiveAgent("clear-test"));
		clearLiveAgentsForTest();
		assert.equal(getLiveAgent("clear-test"), undefined);
	});

	// registerLiveAgent
	describe("registerLiveAgent", () => {
		it("registers a new agent and returns handle", () => {
			clearLiveAgentsForTest();
			const handle = registerLiveAgent(makeHandle({ agentId: "reg1" }));
			assert.equal(handle.agentId, "reg1");
			assert.equal(handle.status, "running");
			assert.ok(handle.createdAt);
			assert.ok(handle.updatedAt);
			assert.deepEqual(handle.pendingSteers, []);
			assert.deepEqual(handle.pendingFollowUps, []);
			assert.equal(handle.activity.toolUses, 0);
			assert.equal(handle.activity.turnCount, 0);
		});

		it("preserves createdAt on re-registration", () => {
			clearLiveAgentsForTest();
			const first = registerLiveAgent(makeHandle({ agentId: "reg2" }));
			const firstCreatedAt = first.createdAt;
			// Re-register same agentId
			const second = registerLiveAgent(makeHandle({ agentId: "reg2" }));
			assert.equal(second.createdAt, firstCreatedAt);
		});

		it("flushes pending steers on registration if session.steer is available", async () => {
			clearLiveAgentsForTest();
			// First register without steer
			const h1 = registerLiveAgent(makeHandle({ agentId: "reg3" }));
			// Add pending steer manually
			h1.pendingSteers.push("test message");
			// Re-register with steer function
			let steered = false;
			const h2 = registerLiveAgent({
				agentId: "reg3",
				taskId: "task_1",
				runId: "run_1",
				workspaceId: "ws_1",
				session: {
					steer: async (_text: string) => {
						steered = true;
					},
				},
				status: "running",
			});
			assert.equal(h2.pendingSteers.length, 0);
			// Allow microtask to settle
			await new Promise((r) => setTimeout(r, 10));
			assert.ok(steered);
		});
	});

	// getLiveAgent
	describe("getLiveAgent", () => {
		it("returns handle by agentId", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "get1" }));
			assert.ok(getLiveAgent("get1"));
		});

		it("returns handle by taskId", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "get2", taskId: "task_get2" }));
			assert.ok(getLiveAgent("task_get2"));
		});

		it("returns undefined for unknown id", () => {
			clearLiveAgentsForTest();
			assert.equal(getLiveAgent("nonexistent"), undefined);
		});
	});

	// updateLiveAgentStatus
	describe("updateLiveAgentStatus", () => {
		it("updates status", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "upd1" }));
			updateLiveAgentStatus("upd1", "completed");
			assert.equal(getLiveAgent("upd1")!.status, "completed");
		});

		it("does not throw for unknown agent", () => {
			clearLiveAgentsForTest();
			assert.doesNotThrow(() => updateLiveAgentStatus("unknown", "completed"));
		});

		it("updates updatedAt timestamp", async () => {
			clearLiveAgentsForTest();
			const h = registerLiveAgent(makeHandle({ agentId: "upd2" }));
			const before = h.updatedAt;
			await new Promise((r) => setTimeout(r, 5));
			updateLiveAgentStatus("upd2", "waiting");
			assert.notEqual(getLiveAgent("upd2")!.updatedAt, before);
		});
	});

	// handle removal is tested via terminateLiveAgent (inlines liveAgents.delete)
	describe("handle removal (via terminateLiveAgent)", () => {
		it("removes agent on termination", async () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "rem1" }));
			await terminateLiveAgent("rem1");
			assert.equal(getLiveAgent("rem1"), undefined);
		});

		it("returns handle from terminateLiveAgent", async () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "rem2" }));
			const stopped = await terminateLiveAgent("rem2");
			assert.ok(stopped);
			assert.equal(stopped.agentId, "rem2");
		});

		it("returns undefined for unknown agent", async () => {
			clearLiveAgentsForTest();
			const result = await terminateLiveAgent("unknown");
			assert.equal(result, undefined);
		});
	});

	// listLiveAgents / listActiveLiveAgents
	describe("listLiveAgents / listActiveLiveAgents", () => {
		it("lists all agents sorted by updatedAt desc", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "la1" }));
			registerLiveAgent(makeHandle({ agentId: "la2" }));
			const list = listLiveAgents();
			assert.equal(list.length, 2);
		});

		it("listActiveLiveAgents returns only running/queued/waiting", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "active1", status: "running" }));
			registerLiveAgent(makeHandle({ agentId: "active2", status: "completed" }));
			registerLiveAgent(makeHandle({ agentId: "active3", status: "queued" }));
			const active = listActiveLiveAgents();
			assert.equal(active.length, 2);
			assert.ok(active.every((a) => a.status === "running" || a.status === "queued"));
		});

		it("returns empty when no agents", () => {
			clearLiveAgentsForTest();
			assert.deepEqual(listLiveAgents(), []);
		});
	});

	// workspace-scoped listings
	describe("listLiveAgentsByWorkspace", () => {
		it("filters by workspaceId", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "ws1", workspaceId: "workspace_a" }));
			registerLiveAgent(makeHandle({ agentId: "ws2", workspaceId: "workspace_b" }));
			assert.equal(listLiveAgentsByWorkspace("workspace_a").length, 1);
			assert.equal(listLiveAgentsByWorkspace("workspace_b").length, 1);
		});

		it("returns empty for unknown workspace", () => {
			clearLiveAgentsForTest();
			assert.deepEqual(listLiveAgentsByWorkspace("nonexistent_ws"), []);
		});

		it("returns all agents in a workspace", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "ws3", workspaceId: "workspace_c" }));
			registerLiveAgent(makeHandle({ agentId: "ws4", workspaceId: "workspace_c" }));
			assert.equal(listLiveAgentsByWorkspace("workspace_c").length, 2);
		});
	});

	// steerLiveAgent
	describe("steerLiveAgent", () => {
		it("throws for unknown agent", async () => {
			clearLiveAgentsForTest();
			await assert.rejects(() => steerLiveAgent("unknown", "msg"), /not registered/);
		});

		it("queues pending steer when session.steer is not available", async () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "steer1" }));
			const h = await steerLiveAgent("steer1", "hello");
			assert.deepEqual(h.pendingSteers, ["hello"]);
		});

		it("calls session.steer when available", async () => {
			clearLiveAgentsForTest();
			let steered = "";
			registerLiveAgent({
				agentId: "steer2",
				taskId: "task_1",
				runId: "run_1",
				workspaceId: "ws_1",
				session: {
					steer: async (msg: string) => {
						steered = msg;
					},
				},
				status: "running",
			});
			await steerLiveAgent("steer2", "go!");
			assert.equal(steered, "go!");
		});
	});

	// followUpLiveAgent
	describe("followUpLiveAgent", () => {
		it("throws for unknown agent", async () => {
			clearLiveAgentsForTest();
			await assert.rejects(() => followUpLiveAgent("unknown", "msg"), /not registered/);
		});

		it("queues pending followUp when session.prompt is not available", async () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "fu1" }));
			const h = await followUpLiveAgent("fu1", "follow up");
			assert.deepEqual(h.pendingFollowUps, ["follow up"]);
		});

		it("calls session.prompt when available", async () => {
			clearLiveAgentsForTest();
			let prompted = "";
			registerLiveAgent({
				agentId: "fu2",
				taskId: "task_1",
				runId: "run_1",
				workspaceId: "ws_1",
				session: {
					prompt: async (msg: string) => {
						prompted = msg;
					},
				},
				status: "running",
			});
			await followUpLiveAgent("fu2", "prompt msg");
			assert.equal(prompted, "prompt msg");
		});
	});

	// activity tracking
	describe("activity tracking", () => {
		it("trackLiveAgentToolStart increments toolUses", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track1" }));
			trackLiveAgentToolStart("track1", "bash");
			assert.equal(getLiveAgent("track1")!.activity.toolUses, 1);
			assert.ok(getLiveAgent("track1")!.activity.activeTools.has("bash"));
		});

		it("trackLiveAgentToolEnd removes active tool", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track2" }));
			trackLiveAgentToolStart("track2", "write");
			trackLiveAgentToolEnd("track2", "write");
			assert.equal(getLiveAgent("track2")!.activity.activeTools.size, 0);
		});

		it("trackLiveAgentTurnEnd increments turnCount", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track3" }));
			trackLiveAgentTurnEnd("track3");
			assert.equal(getLiveAgent("track3")!.activity.turnCount, 1);
			assert.equal(getLiveAgent("track3")!.activity.activeTools.size, 0);
		});

		it("trackLiveAgentTurnEnd tracks compaction", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track3b" }));
			trackLiveAgentTurnEnd("track3b", true);
			assert.equal(getLiveAgent("track3b")!.activity.compactionCount, 1);
		});

		it("trackLiveAgentResponseText stores last 200 chars", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track4" }));
			trackLiveAgentResponseText("track4", "hello world");
			assert.equal(getLiveAgent("track4")!.activity.responseText, "hello world");
		});

		it("trackLiveAgentResponseText truncates long text", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track5" }));
			const long = "x".repeat(300);
			trackLiveAgentResponseText("track5", long);
			assert.equal(getLiveAgent("track5")!.activity.responseText.length, 200);
		});

		it("markLiveAgentCompleted sets completedAtMs", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "track6" }));
			markLiveAgentCompleted("track6");
			assert.ok(getLiveAgent("track6")!.activity.completedAtMs > 0);
		});
	});

	// evictStaleLiveAgentHandles
	describe("evictStaleLiveAgentHandles", () => {
		it("evicts old terminal handles", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "stale1" }));
			updateLiveAgentStatus("stale1", "completed");
			// Make updatedAt old (> 10 minutes)
			const handle = getLiveAgent("stale1")!;
			handle.updatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
			const evicted = evictStaleLiveAgentHandles();
			assert.equal(evicted, 1);
			assert.equal(getLiveAgent("stale1"), undefined);
		});

		it("keeps recent terminal handles", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "fresh1" }));
			updateLiveAgentStatus("fresh1", "completed");
			const evicted = evictStaleLiveAgentHandles();
			assert.equal(evicted, 0);
			assert.ok(getLiveAgent("fresh1"));
		});

		it("evicts stale running handles (>30min)", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "stale_run" }));
			const handle = getLiveAgent("stale_run")!;
			handle.updatedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
			const evicted = evictStaleLiveAgentHandles();
			assert.equal(evicted, 1);
		});
	});

	// IRC messaging (pendingMessages is internal bookkeeping; delivery is inline via sendIrcMessage)
	describe("IRC messaging", () => {
		it("sendIrcMessage queues message for agent", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "irc1" }));
			sendIrcMessage("irc1", {
				from: "user",
				to: "irc1",
				content: "hello",
				timestamp: new Date().toISOString(),
			});
			const handle = getLiveAgent("irc1");
			assert.equal(handle!.pendingMessages.length, 1);
			assert.equal(handle!.pendingMessages[0].content, "hello");
		});

		it("sendIrcMessage caps at MAX_PENDING_MESSAGES", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "irc3" }));
			const handle = getLiveAgent("irc3")!;
			// Fill up to 1000
			for (let i = 0; i < 1001; i++) {
				sendIrcMessage("irc3", {
					from: "user",
					to: "irc3",
					content: `msg_${i}`,
					timestamp: new Date().toISOString(),
				});
			}
			assert.equal(handle.pendingMessages.length, 1000);
		});

		it("broadcastIrcMessage sends to all running agents except sender", () => {
			clearLiveAgentsForTest();
			registerLiveAgent(makeHandle({ agentId: "bc1", status: "running" }));
			registerLiveAgent(makeHandle({ agentId: "bc2", status: "running" }));
			registerLiveAgent(makeHandle({ agentId: "bc3", status: "completed" }));
			const recipients = broadcastIrcMessage("bc1", {
				from: "bc1",
				to: "*",
				content: "broadcast!",
				timestamp: new Date().toISOString(),
			});
			assert.ok(recipients.includes("bc2"));
			assert.ok(!recipients.includes("bc1"));
		});
	});
});
