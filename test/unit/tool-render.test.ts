/**
 * Tool Render Tests
 * Tests for renderTeamToolResult and renderAgentToolResult functions.
 */

import test from "node:test";
import assert from "node:assert";
import {
	renderTeamToolResult,
	renderAgentToolResult,
	type Theme,
	type Component,
} from "../../src/ui/tool-render.ts";
import { Container, Text } from "@earendil-works/pi-tui";

// Mock theme for testing
const mockTheme: Theme = {
	fg(color: any, text: string): string { return text; },
	bold(text: string): string { return text; },
};

test("renderTeamToolResult handles details with action run and agentRecords", () => {
	// Arrange: result with details that has action="run" and agentRecords
	const result = {
		details: {
			action: "run",
			runId: "run-123",
			status: "running",
			agentRecords: [
				{
					agent: "executor",
					status: "completed",
					startedAt: "2026-01-01T00:00:00.000Z",
					completedAt: "2026-01-01T00:01:00.000Z",
					progress: { toolCount: 5, durationMs: 60000 },
				},
			],
		},
	};

	// Act
	const component = renderTeamToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Container, not Text fallback
	assert.ok(component instanceof Container, "Expected Container for run action with agentRecords");
});

test("renderTeamToolResult handles details without details property (flattened)", () => {
	// Arrange: result where details are at root level (flattened shape)
	const result = {
		action: "run",
		runId: "run-456",
		status: "running",
		agentRecords: [
			{
				agent: "builder",
				status: "completed",
				startedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};

	// Act
	const component = renderTeamToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should still work with flattened shape
	assert.ok(component instanceof Container, "Expected Container for flattened result shape");
});

test("renderTeamToolResult handles simple status details", () => {
	// Arrange: result with simple details (no agentRecords)
	const result = {
		details: {
			status: "completed",
			team: "my-team",
			workflow: "default",
		},
	};

	// Act
	const component = renderTeamToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Text with status info
	assert.ok(component instanceof Text, "Expected Text for simple status details");
	const text = component as Text;
	assert.ok((text as any).text?.includes("status=completed"), "Should include status");
	assert.ok((text as any).text?.includes("team=my-team"), "Should include team");
});

test("renderTeamToolResult falls back to content when no details", () => {
	// Arrange: result with only content, no details
	const result = {
		content: [{ type: "text", text: "Simple result text" }],
	};

	// Act
	const component = renderTeamToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Text with content
	assert.ok(component instanceof Text, "Expected Text fallback when no details");
	assert.ok((component as Text as any).text?.includes("Simple result text"), "Should include content text");
});

test("renderAgentToolResult handles details with results array", () => {
	// Arrange: result with details.results (from subagent)
	const result = {
		details: {
			results: [
				{ agentId: "executor", status: "completed", output: "Done successfully" },
				{ agentId: "reviewer", status: "completed", output: "All good" },
			],
		},
	};

	// Act
	const component = renderAgentToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Container with agent rows
	assert.ok(component instanceof Container, "Expected Container for results array");
	const container = component as Container;
	assert.ok(container.children.length >= 2, "Should have rows for each agent result");
});

test("renderAgentToolResult handles single agent details (agentId, status, output)", () => {
	// Arrange: result with single agent properties (not results array)
	const result = {
		details: {
			agentId: "test-agent",
			status: "completed",
			output: "Done",
		},
	};

	// Act
	const component = renderAgentToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Container with single agent row
	assert.ok(component instanceof Container, "Expected Container for single agent details");
	const container = component as Container;
	assert.ok(container.children.length >= 1, "Should have at least one row for the agent");
});

test("renderAgentToolResult handles single agent with error", () => {
	// Arrange: result with single agent that has error
	const result = {
		details: {
			agentId: "error-agent",
			status: "failed",
			error: "Something went wrong",
		},
	};

	// Act
	const component = renderAgentToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Container with error info
	assert.ok(component instanceof Container, "Expected Container for agent with error");
});

test("renderAgentToolResult falls back to content when no details", () => {
	// Arrange: result with only content, no details
	const result = {
		content: [{ type: "text", text: "Fallback text" }],
	};

	// Act
	const component = renderAgentToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Text fallback
	assert.ok(component instanceof Text, "Expected Text fallback when no agent details");
	assert.ok((component as Text as any).text?.includes("Fallback text"), "Should include content text");
});

test("renderAgentToolResult handles empty results array", () => {
	// Arrange: result with empty results array
	const result = {
		details: {
			results: [],
		},
	};

	// Act
	const component = renderAgentToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Text fallback when results is empty
	assert.ok(component instanceof Text, "Expected Text fallback for empty results");
});

test("renderTeamToolResult handles error status", () => {
	// Arrange: result with error details
	const result = {
		details: {
			status: "failed",
			error: "Run failed: permission denied",
		},
	};

	// Act
	const component = renderTeamToolResult(result as any, undefined, mockTheme, undefined);

	// Assert: should return Text with error info
	assert.ok(component instanceof Text, "Expected Text for error status");
	assert.ok((component as Text as any).text?.includes("status=failed"), "Should include status");
});