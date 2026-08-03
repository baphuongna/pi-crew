/**
 * Tool Progress Tests
 */

import assert from "node:assert";
import test from "node:test";
import type { CrewAgentProgress } from "../../../../src/runtime/crew-agent-runtime.ts";
import type { ToolProgressEvent } from "../../../../src/runtime/output/tool-progress.ts";
import {
	filterToolEvents,
	formatCurrentToolLine,
	formatTokenUsage,
	formatToolProgress,
	getEventsForTool,
	getToolName,
	getUsage,
	hasError,
	isToolComplete,
	isToolError,
	isToolRunning,
	renderProgressBar,
} from "../../../../src/runtime/output/tool-progress.ts";

const mockProgress = (overrides: Partial<CrewAgentProgress> = {}): CrewAgentProgress =>
	({
		currentTool: "bash",
		currentToolArgs: "npm install",
		currentToolStartedAt: "2026-01-01T00:00:00.000Z",
		recentTools: [
			{
				tool: "read",
				args: "package.json",
				endedAt: "2026-01-01T00:00:01.000Z",
			},
			{
				tool: "bash",
				args: "npm install",
				startedAt: "2026-01-01T00:00:02.000Z",
			},
		],
		tokens: 45000,
		toolCount: 2,
		lastActivityAt: "2026-01-01T00:00:02.000Z",
		activityState: "active",
		turns: 3,
		...overrides,
	}) as CrewAgentProgress;

test("getToolName extracts tool name from events", () => {
	const startEvent = {
		type: "tool_execution_start" as const,
		toolName: "bash",
		toolCallId: "123",
		timestamp: Date.now(),
	};
	const endEvent = {
		type: "tool_execution_end" as const,
		toolName: "read",
		toolCallId: "456",
		timestamp: Date.now(),
	};
	const messageEvent = {
		type: "message_end" as const,
		message: { role: "assistant", usage: { input: 100, output: 50 } },
		timestamp: Date.now(),
	} as ToolProgressEvent;

	assert.equal(getToolName(startEvent), "bash");
	assert.equal(getToolName(endEvent), "read");
	assert.equal(getToolName(messageEvent), undefined);
});

test("isToolRunning detects start events", () => {
	assert.ok(
		isToolRunning({
			type: "tool_execution_start" as const,
			toolName: "bash",
			toolCallId: "123",
			timestamp: Date.now(),
		}),
	);
	assert.ok(
		!isToolRunning({
			type: "tool_execution_end" as const,
			toolName: "bash",
			toolCallId: "123",
			timestamp: Date.now(),
		}),
	);
	assert.ok(
		!isToolRunning({
			type: "message_end" as const,
			message: { role: "assistant" },
			timestamp: Date.now(),
		}),
	);
});

test("isToolComplete detects end events", () => {
	assert.ok(
		isToolComplete({
			type: "tool_execution_end" as const,
			toolName: "read",
			toolCallId: "456",
			timestamp: Date.now(),
		}),
	);
	assert.ok(
		!isToolComplete({
			type: "tool_execution_start" as const,
			toolName: "read",
			toolCallId: "456",
			timestamp: Date.now(),
		}),
	);
});

test("isToolError detects error events", () => {
	assert.ok(
		isToolError({
			type: "tool_execution_error" as const,
			toolName: "bash",
			toolCallId: "123",
			timestamp: Date.now(),
		}),
	);
	assert.ok(
		isToolError({
			type: "tool_execution_failed" as const,
			toolName: "bash",
			toolCallId: "123",
			timestamp: Date.now(),
		}),
	);
	assert.ok(
		!isToolError({
			type: "tool_execution_end" as const,
			toolName: "bash",
			toolCallId: "123",
			timestamp: Date.now(),
		}),
	);
});

test("getUsage extracts usage from message_end", () => {
	const event = {
		type: "message_end" as const,
		message: {
			role: "assistant" as const,
			usage: { input: 1000, output: 500, cacheRead: 200, cacheWrite: 50 },
		},
		timestamp: Date.now(),
	} as unknown as ToolProgressEvent;

	const usage = getUsage(event);
	assert.ok(usage);
	assert.equal(usage.input, 1000);
	assert.equal(usage.output, 500);
	assert.equal(usage.cacheRead, 200);
});

test("formatToolProgress creates display object", () => {
	const progress = mockProgress();
	const display = formatToolProgress(progress);

	assert.equal(display.currentTool, "bash");
	assert.equal(display.currentToolArgs, "npm install");
	assert.equal(display.toolCount, 2);
	assert.equal(display.tokens, 45000);
	assert.equal(display.contextPercent, 35); // 45000 / 128000 = 35%
	assert.ok(display.recentTools.length >= 1);
});

test("formatCurrentToolLine formats single line", () => {
	const progress = mockProgress();
	const line = formatCurrentToolLine(progress);

	assert.ok(line.includes("bash"));
	assert.ok(line.includes("npm install"));
});

test("formatCurrentToolLine returns empty when no current tool", () => {
	const progress = mockProgress({ currentTool: undefined });
	const line = formatCurrentToolLine(progress);
	assert.equal(line, "");
});

test("formatTokenUsage shows percentage", () => {
	const progress = mockProgress({ tokens: 64000 });
	const usage = formatTokenUsage(progress, 128000);

	assert.ok(usage.includes("50%"));
	assert.ok(usage.includes("64,000"));
});

test("formatTokenUsage handles zero tokens", () => {
	const progress = mockProgress({ tokens: 0 });
	const usage = formatTokenUsage(progress, 128000);
	assert.ok(usage.includes("0%"));
});

test("renderProgressBar creates visual bar", () => {
	const progress = mockProgress();
	const bar = renderProgressBar(progress, { width: 10 });

	assert.ok(bar.startsWith("["));
	assert.ok(bar.includes("]"));
	assert.ok(bar.includes("tools"));
});

test("filterToolEvents returns only tool events", () => {
	const events = [
		{
			type: "tool_execution_start" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
		{
			type: "message_end" as const,
			message: { role: "assistant" },
			timestamp: Date.now(),
		},
		{
			type: "tool_execution_end" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
	] as unknown as ToolProgressEvent[];

	const toolEvents = filterToolEvents(events);
	assert.equal(toolEvents.length, 2);
	assert.ok(toolEvents.every((e) => "toolName" in e));
});

test("getEventsForTool filters by tool name", () => {
	const events = [
		{
			type: "tool_execution_start" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
		{
			type: "tool_execution_start" as const,
			toolName: "read",
			toolCallId: "2",
			timestamp: Date.now(),
		},
		{
			type: "tool_execution_end" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
	] as unknown as ToolProgressEvent[];

	const bashEvents = getEventsForTool(events, "bash");
	assert.equal(bashEvents.length, 2);
});

test("hasError detects error events", () => {
	const withError = [
		{
			type: "tool_execution_start" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
		{
			type: "tool_execution_error" as const,
			toolName: "bash",
			toolCallId: "1",
			error: "timeout",
			timestamp: Date.now(),
		},
	] as unknown as ToolProgressEvent[];

	const withoutError = [
		{
			type: "tool_execution_start" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
		{
			type: "tool_execution_end" as const,
			toolName: "bash",
			toolCallId: "1",
			timestamp: Date.now(),
		},
	] as unknown as ToolProgressEvent[];

	assert.ok(hasError(withError));
	assert.ok(!hasError(withoutError));
});

test("formatToolProgress handles empty progress", () => {
	// Empty progress with no tokens
	const empty: CrewAgentProgress = {
		recentTools: [],
		toolCount: 0,
		activityState: "idle",
	} as unknown as CrewAgentProgress;

	const display = formatToolProgress(empty);

	assert.equal(display.currentTool, undefined);

	assert.equal(display.toolCount, 0);
	assert.ok(Array.isArray(display.recentTools));
});
