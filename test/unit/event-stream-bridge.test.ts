import assert from "node:assert/strict";
import test from "node:test";
import { bridgeEventFromJsonEvent, registerStreamBridge } from "../../src/runtime/event-stream-bridge.ts";
import { runEventBus } from "../../src/ui/run-event-bus.ts";

test("registerStreamBridge returns handler and dispose", () => {
	const { handler, dispose } = registerStreamBridge("test-register-1");
	assert.equal(typeof handler, "function");
	assert.equal(typeof dispose, "function");
	dispose();
});

test("registerStreamBridge same runId returns same handler", () => {
	const a = registerStreamBridge("test-register-2");
	const b = registerStreamBridge("test-register-2");
	assert.equal(a.handler, b.handler);
	a.dispose();
	b.dispose();
});

test("unregisterStreamBridge removes handler", () => {
	const { handler, dispose } = registerStreamBridge("test-register-3");
	dispose();
	// Re-registering should produce a different handler
	const next = registerStreamBridge("test-register-3");
	assert.notEqual(handler, next.handler);
	next.dispose();
});

test("bridge handler emits worker_status via runEventBus", () => {
	const received: unknown[] = [];
	const unsub = runEventBus.on("test-emit-1", (event) => received.push(event));
	const { handler, dispose } = registerStreamBridge("test-emit-1");
	handler({
		runId: "test-emit-1",
		taskId: "task-1",
		eventType: "tool_use",
		toolName: "read",
		timestamp: 1000,
	});
	assert.equal(received.length, 1);
	const emitted = received[0] as {
		type: string;
		runId: string;
		taskId: string;
		data: unknown;
	};
	assert.equal(emitted.type, "worker_status");
	assert.equal(emitted.runId, "test-emit-1");
	assert.equal(emitted.taskId, "task-1");
	dispose();
	unsub();
});

test("bridgeEventFromJsonEvent returns null for non-objects", () => {
	assert.equal(bridgeEventFromJsonEvent("r1", "t1", null), null);
	assert.equal(bridgeEventFromJsonEvent("r1", "t1", undefined), null);
	assert.equal(bridgeEventFromJsonEvent("r1", "t1", "string"), null);
	assert.equal(bridgeEventFromJsonEvent("r1", "t1", 42), null);
	assert.equal(bridgeEventFromJsonEvent("r1", "t1", true), null);
});

test("bridgeEventFromJsonEvent extracts tool name and args", () => {
	const result = bridgeEventFromJsonEvent("r1", "t1", {
		type: "tool_use",
		toolName: "write",
		args: { path: "/tmp/test.txt", content: "hello" },
	});
	assert.ok(result);
	assert.equal(result.runId, "r1");
	assert.equal(result.taskId, "t1");
	assert.equal(result.eventType, "tool_use");
	assert.equal(result.toolName, "write");
	assert.ok(result.toolArgs);
	assert.ok(result.toolArgs!.includes("test.txt"));
	assert.equal(typeof result.timestamp, "number");
});

test("bridgeEventFromJsonEvent extracts intent", () => {
	const result = bridgeEventFromJsonEvent("r1", "t1", {
		type: "assistant",
		intent: "Implement feature X",
	});
	assert.ok(result);
	assert.equal(result.intent, "Implement feature X");
});

test("bridgeEventFromJsonEvent extracts tokens from usage", () => {
	const result = bridgeEventFromJsonEvent("r1", "t1", {
		type: "message_end",
		usage: { input: 100, output: 50 },
	});
	assert.ok(result);
	assert.equal(result.tokens, 150);
});

test("bridgeEventFromJsonEvent extracts tokens from message.usage", () => {
	const result = bridgeEventFromJsonEvent("r1", "t1", {
		type: "message_end",
		message: { usage: { input: 200, output: 80 } },
	});
	assert.ok(result);
	assert.equal(result.tokens, 280);
});

test("bridgeEventFromJsonEvent omits tokens when zero", () => {
	const result = bridgeEventFromJsonEvent("r1", "t1", {
		type: "message_end",
		usage: { input: 0, output: 0 },
	});
	assert.ok(result);
	assert.equal(result.tokens, undefined);
});

test("bridgeEventFromJsonEvent handles empty object", () => {
	const result = bridgeEventFromJsonEvent("r1", "t1", {});
	assert.ok(result);
	assert.equal(result.eventType, "");
	assert.equal(result.toolName, undefined);
	assert.equal(result.tokens, undefined);
});
