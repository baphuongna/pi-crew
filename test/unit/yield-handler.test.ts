import test from "node:test";
import assert from "node:assert/strict";
import {
	isYieldEvent,
	extractYieldResult,
	hasYieldInOutput,
	buildYieldReminder,
	registerYieldTool,
	YIELD_TOOL_NAME,
	DEFAULT_YIELD_CONFIG,
} from "../../src/runtime/yield-handler.ts";
import { subprocessToolRegistry } from "../../src/runtime/subprocess-tool-registry.ts";

test("isYieldEvent detects submit_result tool_execution_start", () => {
	const event = { type: "tool_execution_start", toolName: "submit_result", args: { summary: "done" } };
	assert.equal(isYieldEvent(event), true);
});

test("isYieldEvent detects submit_result toolCall", () => {
	const event = { type: "toolCall", name: "submit_result", args: { summary: "done" } };
	assert.equal(isYieldEvent(event), true);
});

test("isYieldEvent detects submit_result tool_call", () => {
	const event = { type: "tool_call", tool: "submit_result", args: { summary: "done" } };
	assert.equal(isYieldEvent(event), true);
});

test("isYieldEvent returns false for other tool calls", () => {
	const event = { type: "tool_execution_start", toolName: "write_file", args: {} };
	assert.equal(isYieldEvent(event), false);
});

test("isYieldEvent returns false for non-tool events", () => {
	const event = { type: "message_end" };
	assert.equal(isYieldEvent(event), false);
});

test("isYieldEvent returns false for empty object", () => {
	assert.equal(isYieldEvent({}), false);
});

test("extractYieldResult parses structured data", () => {
	const event = {
		type: "tool_execution_start",
		toolName: "submit_result",
		toolCallId: "call-123",
		args: {
			summary: "Task completed successfully",
			artifacts: { "result.txt": "/path/to/result.txt" },
			structuredData: { filesChanged: 3, testsPassed: true },
		},
	};
	const result = extractYieldResult(event);
	assert.ok(result);
	assert.equal(result!.summary, "Task completed successfully");
	assert.equal(result!.toolCallId, "call-123");
	assert.deepEqual(result!.artifacts, { "result.txt": "/path/to/result.txt" });
	assert.deepEqual(result!.structuredData, { filesChanged: 3, testsPassed: true });
});

test("extractYieldResult returns undefined for non-yield events", () => {
	const event = { type: "tool_execution_start", toolName: "write_file", args: {} };
	assert.equal(extractYieldResult(event), undefined);
});

test("extractYieldResult returns undefined when args is missing", () => {
	const event = { type: "tool_execution_start", toolName: "submit_result" };
	assert.equal(extractYieldResult(event), undefined);
});

test("extractYieldResult returns undefined when summary is missing", () => {
	const event = { type: "tool_execution_start", toolName: "submit_result", args: {} };
	assert.equal(extractYieldResult(event), undefined);
});

test("extractYieldResult works without optional fields", () => {
	const event = {
		type: "tool_execution_start",
		toolName: "submit_result",
		toolCallId: "call-456",
		args: { summary: "Simple result" },
	};
	const result = extractYieldResult(event);
	assert.ok(result);
	assert.equal(result!.summary, "Simple result");
	assert.equal(result!.artifacts, undefined);
	assert.equal(result!.structuredData, undefined);
});

test("hasYieldInOutput detects yield in event sequence", () => {
	const events = [
		{ type: "tool_execution_start", toolName: "write_file", args: {} },
		{ type: "tool_execution_end", toolName: "write_file" },
		{ type: "tool_execution_start", toolName: "submit_result", args: { summary: "done" } },
	];
	assert.equal(hasYieldInOutput(events), true);
});

test("hasYieldInOutput returns false when no yield present", () => {
	const events = [
		{ type: "tool_execution_start", toolName: "write_file", args: {} },
		{ type: "tool_execution_end", toolName: "write_file" },
	];
	assert.equal(hasYieldInOutput(events), false);
});

test("hasYieldInOutput returns false for empty sequence", () => {
	assert.equal(hasYieldInOutput([]), false);
});

test("buildYieldReminder includes attempt number", () => {
	const reminder = buildYieldReminder(1, 3);
	assert.ok(reminder.includes("1"));
	assert.ok(reminder.includes("3"));
	assert.ok(reminder.includes(DEFAULT_YIELD_CONFIG.reminderPrompt));
});

test("buildYieldReminder includes attempt number at max", () => {
	const reminder = buildYieldReminder(3, 3);
	assert.ok(reminder.includes("3"));
});

test("registerYieldTool registers in subprocessToolRegistry", () => {
	// Ensure not already registered from a previous test
	assert.equal(subprocessToolRegistry.hasHandler(YIELD_TOOL_NAME), false);
	registerYieldTool();
	assert.equal(subprocessToolRegistry.hasHandler(YIELD_TOOL_NAME), true);
	const handler = subprocessToolRegistry.getHandler(YIELD_TOOL_NAME);
	assert.ok(handler);
	assert.equal(handler!.shouldTerminate?.({ toolName: YIELD_TOOL_NAME, toolCallId: "test" } as any), true);
	const extracted = handler!.extractData?.({
		toolName: YIELD_TOOL_NAME,
		toolCallId: "call-789",
		args: { summary: "Extracted result", artifacts: { "a.txt": "content" } },
	} as any);
	assert.ok(extracted);
	assert.equal((extracted as any).summary, "Extracted result");
	assert.deepEqual((extracted as any).artifacts, { "a.txt": "content" });
});
