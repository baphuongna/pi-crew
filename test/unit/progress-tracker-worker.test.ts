import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globalProgressTracker } from "../../src/runtime/progress-tracker.ts";

describe("ProgressTracker worker event bridge", () => {
	it("handleWorkerEvent creates progress on first event", () => {
		const taskId = "test-task-create";
		const runId = "test-run-create";
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "agent_start",
		});
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.equal(progress!.status, "running");
		globalProgressTracker.untrackWorker(taskId);
	});

	it("processes tool_execution_start", () => {
		const taskId = "test-task-tool-start";
		const runId = "test-run-tool-start";
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "tool_execution_start",
			toolName: "grep",
			args: { pattern: "security" },
		});
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.equal(progress!.currentTool, "grep");
		assert.equal(progress!.toolCalls, 1);
		assert.ok(progress!.toolStartTime !== null);
		globalProgressTracker.untrackWorker(taskId);
	});

	it("processes tool_execution_end", () => {
		const taskId = "test-task-tool-end";
		const runId = "test-run-tool-end";
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "tool_execution_start",
			toolName: "read",
		});
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "tool_execution_end",
			toolName: "read",
			isError: false,
		});
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.equal(progress!.currentTool, null);
		assert.equal(progress!.toolStartTime, null);
		globalProgressTracker.untrackWorker(taskId);
	});

	it("tracks errors from tool_execution_end", () => {
		const taskId = "test-task-error";
		const runId = "test-run-error";
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "tool_execution_end",
			isError: true,
			result: "Command failed: exit code 1",
		});
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.ok(progress!.errors.length > 0);
		assert.ok(progress!.errors[0].includes("Command failed"));
		globalProgressTracker.untrackWorker(taskId);
	});

	it("extracts assistant text from message events", () => {
		const taskId = "test-task-text";
		const runId = "test-run-text";
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "message",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Found 3 security issues in auth module." }],
			},
		});
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.ok(progress!.partialText);
		assert.ok(progress!.partialText!.includes("Found 3 security issues"));
		globalProgressTracker.untrackWorker(taskId);
	});

	it("tracks token usage from message_end", () => {
		const taskId = "test-task-usage";
		const runId = "test-run-usage";
		globalProgressTracker.handleWorkerEvent(taskId, runId, {
			type: "message_end",
			message: { role: "assistant", content: [] },
			usage: { input: 1500, output: 800 },
		});
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.equal(progress!.tokens.input, 1500);
		assert.equal(progress!.tokens.output, 800);
		globalProgressTracker.untrackWorker(taskId);
	});

	it("marks completed on agent_settled", () => {
		const taskId = "test-task-settled";
		const runId = "test-run-settled";
		globalProgressTracker.handleWorkerEvent(taskId, runId, { type: "agent_start" });
		globalProgressTracker.handleWorkerEvent(taskId, runId, { type: "agent_settled" });
		const progress = globalProgressTracker.getWorkerProgress(taskId);
		assert.ok(progress);
		assert.equal(progress!.status, "completed");
		globalProgressTracker.untrackWorker(taskId);
	});

	it("untrackWorker removes progress", () => {
		const taskId = "test-task-untrack";
		const runId = "test-run-untrack";
		globalProgressTracker.handleWorkerEvent(taskId, runId, { type: "agent_start" });
		assert.ok(globalProgressTracker.getWorkerProgress(taskId));
		globalProgressTracker.untrackWorker(taskId);
		assert.equal(globalProgressTracker.getWorkerProgress(taskId), undefined);
	});
});
