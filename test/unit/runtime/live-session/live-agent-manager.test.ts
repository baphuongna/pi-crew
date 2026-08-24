import assert from "node:assert/strict";
import test from "node:test";
import {
	clearLiveAgentsForTest,
	disposeLiveAgentSession,
	followUpLiveAgent,
	listActiveLiveAgents,
	listLiveAgents,
	registerLiveAgent,
	terminateLiveAgent,
	updateLiveAgentStatus,
} from "../../../../src/runtime/live-session/live-agent-manager.ts";

const TEST_WORKSPACE = "workspace:///test/cleanup";

function registerTestAgent(overrides: Partial<Parameters<typeof registerLiveAgent>[0]> = {}): void {
	const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
	registerLiveAgent({
		agentId: id,
		taskId: "task",
		runId: "run",
		status: "running",
		session: {},
		workspaceId: TEST_WORKSPACE,
		...overrides,
	});
}

test("followUpLiveAgent queues and flushes pending follow-ups through prompt", async () => {
	const prompts: string[] = [];
	const id = `followup-test-${Date.now()}`;
	try {
		registerLiveAgent({
			agentId: id,
			taskId: "task",
			runId: "run",
			status: "running",
			session: {},
			workspaceId: TEST_WORKSPACE,
		});
		const pending = await followUpLiveAgent(id, "review this next");
		assert.deepEqual(pending.pendingFollowUps, ["review this next"]);
		registerLiveAgent({
			agentId: id,
			taskId: "task",
			runId: "run",
			status: "running",
			session: {
				prompt: async (text: string) => {
					prompts.push(text);
				},
			},
			workspaceId: TEST_WORKSPACE,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(prompts, ["review this next"]);
		const handle = registerLiveAgent({
			agentId: id,
			taskId: "task",
			runId: "run",
			status: "running",
			session: {},
			workspaceId: TEST_WORKSPACE,
		});
		assert.deepEqual(handle.pendingFollowUps, []);
	} finally {
		terminateLiveAgent(id);
	}
});

test("terminateLiveAgent removes handle and calls abort + dispose", async () => {
	const calls: string[] = [];
	const id = `terminate-test-${Date.now()}`;
	registerLiveAgent({
		agentId: id,
		taskId: "task",
		runId: "run",
		status: "running",
		session: {
			abort: async () => {
				calls.push("abort");
			},
			dispose: () => {
				calls.push("dispose");
			},
		},
		workspaceId: TEST_WORKSPACE,
	});
	await terminateLiveAgent(id);
	assert.deepEqual(calls.sort(), ["abort", "dispose"]);
	assert.equal(
		listLiveAgents().find((a) => a.agentId === id),
		undefined,
	);
});

test("disposeLiveAgentSession removes session without abort", () => {
	const calls: string[] = [];
	const id = `dispose-test-${Date.now()}`;
	registerLiveAgent({
		agentId: id,
		taskId: "task",
		runId: "run",
		status: "running",
		session: {
			dispose: () => {
				calls.push("dispose");
			},
		},
		workspaceId: TEST_WORKSPACE,
	});
	disposeLiveAgentSession(id);
	assert.deepEqual(calls, ["dispose"]);
	terminateLiveAgent(id);
});

test("listActiveLiveAgents returns only non-terminal statuses", () => {
	clearLiveAgentsForTest();
	const id1 = `done-${Date.now()}`;
	const id2 = `active-${Date.now()}`;
	registerLiveAgent({
		agentId: id1,
		taskId: "t1",
		runId: "run",
		status: "completed",
		session: {},
		workspaceId: TEST_WORKSPACE,
	});
	registerLiveAgent({
		agentId: id2,
		taskId: "t2",
		runId: "run",
		status: "running",
		session: {},
		workspaceId: TEST_WORKSPACE,
	});
	assert.deepEqual(
		listActiveLiveAgents().map((agent) => agent.agentId),
		[id2],
	);
	terminateLiveAgent(id1);
	terminateLiveAgent(id2);
});

test("terminateLiveAgent with non-existent handle returns undefined", async () => {
	const result = await terminateLiveAgent("non-existent-agent");
	assert.equal(result, undefined);
});

test("listLiveAgents sorts by updatedAt descending and invalidates memo on update and unregister", async () => {
	clearLiveAgentsForTest();
	const base = `sort-test-${Date.now()}`;
	const oldest = registerLiveAgent({
		agentId: `${base}-oldest`,
		taskId: "t1",
		runId: "run",
		status: "running",
		session: {},
		workspaceId: TEST_WORKSPACE,
	});
	const middle = registerLiveAgent({
		agentId: `${base}-middle`,
		taskId: "t2",
		runId: "run",
		status: "running",
		session: {},
		workspaceId: TEST_WORKSPACE,
	});
	const newest = registerLiveAgent({
		agentId: `${base}-newest`,
		taskId: "t3",
		runId: "run",
		status: "running",
		session: {},
		workspaceId: TEST_WORKSPACE,
	});
	// Stagger updatedAt BEFORE the first listLiveAgents() call so the memoized
	// sort starts from a deterministic order (fake 2020 stamps are always older
	// than the real "now" written by updateLiveAgentStatus below).
	oldest.updatedAt = "2020-01-01T00:00:01.000Z";
	middle.updatedAt = "2020-01-02T00:00:01.000Z";
	newest.updatedAt = "2020-01-03T00:00:01.000Z";
	assert.deepEqual(
		listLiveAgents().map((a) => a.agentId),
		[`${base}-newest`, `${base}-middle`, `${base}-oldest`],
	);

	// Bumping updatedAt through the API must invalidate the memoized order.
	updateLiveAgentStatus(`${base}-oldest`, "running");
	assert.deepEqual(
		listLiveAgents().map((a) => a.agentId),
		[`${base}-oldest`, `${base}-newest`, `${base}-middle`],
	);

	// Unregistering must invalidate the memoized membership.
	await terminateLiveAgent(`${base}-middle`);
	assert.deepEqual(
		listLiveAgents().map((a) => a.agentId),
		[`${base}-oldest`, `${base}-newest`],
	);

	await terminateLiveAgent(`${base}-oldest`);
	await terminateLiveAgent(`${base}-newest`);
});
