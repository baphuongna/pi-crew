import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { crewEventBus } from "../../src/observability/event-bus.ts";
import { ProgressTracker } from "../../src/runtime/progress-tracker.ts";

test("ProgressTracker counts tool calls", () => {
	const tracker = new ProgressTracker();

	// Create mock session
	const events: AgentSessionEvent[] = [];
	const mockSession = {
		subscribe: (listener: (e: any) => void) => {
			events.forEach((e) => listener(e));
			return () => {};
		},
	};

	// Add events
	events.push(
		{
			type: "tool_execution_start",
			toolName: "read",
			toolCallId: "1",
			args: {},
		} as any,
		{
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "1",
			isError: false,
			result: "ok",
		} as any,
		{
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "2",
			args: {},
		} as any,
		{
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "2",
			isError: false,
			result: "ok",
		} as any,
	);

	tracker.track(mockSession as any, "agent-1", "run-1");

	const progress = tracker.getProgress("agent-1");
	assert.equal(progress?.toolCalls, 2);
});

test("ProgressTracker tracks errors", () => {
	const tracker = new ProgressTracker();

	const events: any[] = [
		{
			type: "tool_execution_start",
			toolName: "bash",
			toolCallId: "1",
			args: {},
		},
		{
			type: "tool_execution_end",
			toolName: "bash",
			toolCallId: "1",
			isError: true,
			result: "Exit code 1",
		},
	];

	const mockSession = {
		subscribe: (listener: (e: any) => void) => {
			events.forEach((e) => listener(e));
			return () => {};
		},
	};

	tracker.track(mockSession as any, "agent-2", "run-1");

	const progress = tracker.getProgress("agent-2");
	assert.equal(progress?.errors.length, 1);
});

test("EventBus emits progress events", () => {
	const events: any[] = [];
	const unsubscribe = crewEventBus.on("agent:progress", (e) => events.push(e));

	crewEventBus.emit({
		type: "agent:progress",
		runId: "test-run",
		agentId: "test-agent",
		payload: { toolCalls: 1 } as any,
		timestamp: Date.now(),
	});

	assert.equal(events.length, 1);
	assert.equal(events[0].agentId, "test-agent");

	unsubscribe();
});

test("ProgressTracker untrack removes subscription", () => {
	const tracker = new ProgressTracker();
	let subscriptionActive = false;

	const mockSession = {
		subscribe: () => {
			subscriptionActive = true;
			return () => {
				subscriptionActive = false;
			};
		},
	};

	tracker.track(mockSession as any, "agent-3", "run-1");
	assert.equal(subscriptionActive, true);

	tracker.untrack("agent-3");
	assert.equal(subscriptionActive, false);
});
