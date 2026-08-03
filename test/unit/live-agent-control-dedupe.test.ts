import assert from "node:assert/strict";
import test from "node:test";
import { applyLiveAgentControlRequest } from "../../src/runtime/live-session/live-agent-control.ts";

test("live agent control dedupes realtime and durable delivery by request id", async () => {
	const seenRequestIds = new Set<string>();
	const steers: string[] = [];
	const request = {
		id: "ctrl_same",
		runId: "run",
		taskId: "task",
		agentId: "run:task",
		operation: "steer" as const,
		message: "once",
		createdAt: new Date().toISOString(),
	};
	const session = {
		steer: async (text: string) => {
			steers.push(text);
		},
	};
	assert.equal(
		await applyLiveAgentControlRequest({
			request,
			taskId: "task",
			agentId: "run:task",
			session,
			seenRequestIds,
		}),
		true,
	);
	assert.equal(
		await applyLiveAgentControlRequest({
			request,
			taskId: "task",
			agentId: "run:task",
			session,
			seenRequestIds,
		}),
		false,
	);
	assert.deepEqual(steers, ["once"]);
});

test("follow-up control routes through prompt instead of steer", async () => {
	const prompts: string[] = [];
	const steers: string[] = [];
	const request = {
		id: "ctrl_followup",
		runId: "run",
		taskId: "task",
		agentId: "run:task",
		operation: "follow-up" as const,
		message: "continue after stop",
		createdAt: new Date().toISOString(),
	};
	const session = {
		steer: async (text: string) => {
			steers.push(text);
		},
		prompt: async (text: string) => {
			prompts.push(text);
		},
	};
	assert.equal(
		await applyLiveAgentControlRequest({
			request,
			taskId: "task",
			agentId: "run:task",
			session,
		}),
		true,
	);
	assert.deepEqual(prompts, ["continue after stop"]);
	assert.deepEqual(steers, []);
});
