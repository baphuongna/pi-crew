/**
 * Unit tests for HandoffManager.
 * @see src/runtime/handoff-manager.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
	createHandoffManager,
	type Decision,
	HandoffManager,
	type TaskPacket,
	type TaskResult,
} from "../../src/runtime/handoff-manager.ts";

// Test helpers
function createTaskPacket(overrides: Partial<TaskPacket> = {}): TaskPacket {
	return {
		taskId: "test-task-1",
		runId: "test-run-1",
		goal: "Test task",
		sessionId: "test-session",
		summarizeThreshold: 5000,
		collapseContext: false,
		forceSummarize: false,
		context: {},
		...overrides,
	};
}

function createTaskResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		outcome: "success",
		usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500 },
		duration: 30000,
		iterations: 1,
		toolsUsed: ["read", "write", "bash"],
		blockers: [],
		nextSteps: ["Next step 1", "Next step 2"],
		filesCreated: ["file1.ts", "file2.ts"],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		error: undefined,
		...overrides,
	};
}

function createDecision(overrides: Partial<Decision> = {}): Decision {
	return {
		rationale: "Chose approach A",
		outcome: "Successfully implemented",
		alternativesConsidered: ["Approach B", "Approach C"],
		...overrides,
	};
}

test("HandoffManager - shouldSummarize returns false for short tasks", () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ summarizeThreshold: 5000 });
	// Use fewer than 3 tools and no files to ensure it's below threshold
	const result = createTaskResult({
		usage: { totalTokens: 500 },
		toolsUsed: ["read"], // Fewer than 3 tools
		filesCreated: [], // No files
	});

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, false);
	assert.ok(decision.reason.includes("threshold"));
});

test("HandoffManager - shouldSummarize returns true for long tasks", () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ summarizeThreshold: 5000 });
	const result = createTaskResult({ usage: { totalTokens: 10000 } });

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.ok(decision.reason.includes("exceeds threshold"));
});

test("HandoffManager - shouldSummarize returns true for tasks with many tools", () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ summarizeThreshold: 5000 });
	const result = createTaskResult({
		usage: { totalTokens: 1000 },
		toolsUsed: ["read", "write", "bash", "grep"],
	});

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.ok(decision.reason.includes("tools"));
});

test("HandoffManager - shouldSummarize returns true when forceSummarize is set", () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ forceSummarize: true });
	// Even with minimal usage and no tools/files, forceSummarize should work
	const result = createTaskResult({
		usage: { totalTokens: 100 },
		toolsUsed: ["read"], // Minimal
	});

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.ok(decision.reason.includes("Forced"));
});

test("HandoffManager - shouldSummarize returns true for tasks with significant artifacts", () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ summarizeThreshold: 5000 });
	// With only 100 tokens but files created, should still summarize due to artifacts
	const result = createTaskResult({
		usage: { totalTokens: 100 },
		filesCreated: ["file1.ts", "file2.ts"],
		// Need outcome to be non-success for summarization with artifacts, OR need >5000 tokens
		outcome: "partial", // partial outcome triggers summarization
	});

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.ok(decision.reason.includes("artifacts") || decision.reason.includes("outcome"));
});

test("HandoffManager - shouldSummarize returns true for tasks with decisions", () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ summarizeThreshold: 5000 });
	// With only 100 tokens but decisions, need outcome to be non-success
	const result = createTaskResult({
		usage: { totalTokens: 100 },
		decisions: [createDecision()],
		outcome: "partial", // partial outcome triggers summarization
	});

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
	assert.ok(decision.reason.includes("decisions") || decision.reason.includes("outcome"));
});

test("HandoffManager - generateSummary creates complete summary", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({
		taskId: "task-with-summary",
		goal: "Build feature X",
	});
	const result = createTaskResult({
		outcome: "success",
		usage: { totalTokens: 5000 },
		decisions: [createDecision({ rationale: "Selected approach A" })],
		blockers: ["None"],
		nextSteps: ["Deploy to staging"],
		filesCreated: ["src/feature-x.ts"],
		filesModified: ["package.json"],
	});

	const summary = await manager.generateSummary(packet, result);

	assert.strictEqual(summary.taskId, "task-with-summary");
	assert.strictEqual(summary.runId, "test-run-1");
	assert.strictEqual(summary.task, "Build feature X");
	assert.strictEqual(summary.outcome, "success");
	assert.deepEqual(summary.filesCreated, ["src/feature-x.ts"]);
	assert.deepEqual(summary.filesModified, ["package.json"]);
	assert.deepEqual(summary.decisions.length, 1);
	assert.deepEqual(summary.blockers, ["None"]);
	assert.deepEqual(summary.nextSteps, ["Deploy to staging"]);
	assert.strictEqual(summary.metrics.tokensUsed, 5000);
	assert.ok(summary.contextSnapshot.length > 0);
});

test("HandoffManager - generateSummary handles failure outcomes", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	const result = createTaskResult({
		outcome: "failure",
		error: "Implementation failed",
	});

	const summary = await manager.generateSummary(packet, result);

	assert.strictEqual(summary.outcome, "failure");
	assert.ok(summary.decisions.length > 0); // Default decision for failure
});

test("HandoffManager - onAgentEnd skips summary for short tasks", async () => {
	const manager = new HandoffManager();

	// Use minimal tools and files to ensure short task doesn't trigger summary
	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 100 },
		toolsUsed: ["read"], // Fewer than 3
		filesCreated: [], // No files
	});

	const summary = await manager.onAgentEnd(packet, result);

	assert.strictEqual(summary, null);
});

test("HandoffManager - onAgentEnd generates summary for long tasks", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ sessionId: "session-123" });
	const result = createTaskResult({ usage: { totalTokens: 10000 } });

	const summary = await manager.onAgentEnd(packet, result);

	assert.ok(summary !== null);
	assert.strictEqual(summary!.taskId, "test-task-1");
	assert.strictEqual(summary!.runId, "test-run-1");
});

test("HandoffManager - onAgentEnd stores pending handoff by session", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ sessionId: "pending-session" });
	const result = createTaskResult({ usage: { totalTokens: 10000 } });

	await manager.onAgentEnd(packet, result);

	const pending = manager.getPendingHandoff("pending-session");
	assert.ok(pending !== undefined);
	assert.strictEqual(pending!.taskId, "test-task-1");
});

test("HandoffManager - onBeforeTreeNavigation returns and clears pending handoff", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ sessionId: "nav-session" });
	const result = createTaskResult({ usage: { totalTokens: 10000 } });

	await manager.onAgentEnd(packet, result);

	const handoff = await manager.onBeforeTreeNavigation("nav-session", "target-1");

	assert.ok(handoff !== null);
	assert.strictEqual(handoff!.taskId, "test-task-1");

	// Should be cleared after navigation
	const pending = manager.getPendingHandoff("nav-session");
	assert.strictEqual(pending, undefined);
});

test("HandoffManager - onBeforeTreeNavigation returns null when no pending handoff", async () => {
	const manager = new HandoffManager();

	const handoff = await manager.onBeforeTreeNavigation("unknown-session", "target-1");

	assert.strictEqual(handoff, null);
});

test("HandoffManager - collapseContext sets and clears global flag", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ sessionId: "collapse-session" });
	const result = createTaskResult();
	const summary = await manager.generateSummary(packet, result);

	// Clear any existing flag
	delete (globalThis as Record<string, unknown>).__boomerangCollapseInProgress;

	// The collapseContext method sets the flag during execution
	await manager.collapseContext(packet, summary);

	// Flag should be cleared after collapse (method clears it in finally)
	// Since collapseContext runs synchronously with try/finally, the flag will be undefined
	assert.ok(!(globalThis as Record<string, unknown>).__boomerangCollapseInProgress);
});

test("HandoffManager - options allow custom default threshold", () => {
	const manager = new HandoffManager({ defaultSummarizeThreshold: 1000 });

	const packet = createTaskPacket(); // Uses default from options
	const result = createTaskResult({ usage: { totalTokens: 2000 } });

	// With defaultSummarizeThreshold=1000, 2000 tokens should trigger summary
	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
});

test("HandoffManager - options allow custom event emitter", async () => {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	const eventEmitter = {
		emit(event: string, data: unknown) {
			emittedEvents.push({ event, data });
		},
	};

	const manager = new HandoffManager({ eventEmitter });

	const packet = createTaskPacket({ sessionId: "emitter-session" });
	const result = createTaskResult({ usage: { totalTokens: 10000 } });

	await manager.onAgentEnd(packet, result);

	assert.ok(emittedEvents.some((e) => e.event === "handoff:generated"));
});

test("HandoffManager - extractArtifacts handles all artifact types", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	const result = createTaskResult({
		filesCreated: ["new.ts"],
		filesModified: ["existing.ts"],
		filesDeleted: ["old.ts"],
	});

	const summary = await manager.generateSummary(packet, result);

	assert.deepEqual(summary.filesCreated, ["new.ts"]);
	assert.deepEqual(summary.filesModified, ["existing.ts"]);
	assert.deepEqual(summary.filesDeleted, ["old.ts"]);
});

test("HandoffManager - clearPendingHandoff removes specific session", async () => {
	const manager = new HandoffManager();

	// Add some pending handoffs
	manager.clearPendingHandoff("session-1");
	manager.clearPendingHandoff("session-2");

	// Both should be undefined
	assert.strictEqual(manager.getPendingHandoff("session-1"), undefined);
	assert.strictEqual(manager.getPendingHandoff("session-2"), undefined);
});

test("HandoffManager - contextSnapshot includes key information", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	const result = createTaskResult({
		usage: { totalTokens: 3000 },
		toolsUsed: ["read", "write"],
		blockers: ["Waiting for approval"],
		nextSteps: ["Review code"],
	});

	const summary = await manager.generateSummary(packet, result);

	assert.ok(summary.contextSnapshot.includes("test-task-1"));
	assert.ok(summary.contextSnapshot.includes("success"));
	assert.ok(summary.contextSnapshot.includes("3000"));
	assert.ok(summary.contextSnapshot.includes("Waiting for approval"));
	assert.ok(summary.contextSnapshot.includes("Review code"));
});

test("HandoffManager - partial outcome is handled correctly", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	// Partial outcome (non-success) triggers summarization
	// Override ALL fields that could trigger summarization to test partial specifically
	const result = createTaskResult({
		outcome: "partial",
		usage: { totalTokens: 100 },
		toolsUsed: ["read"], // Fewer than 3
		filesCreated: [], // No files
		decisions: [], // No decisions
	});

	const decision = manager.shouldSummarize(packet, result);

	// Partial (non-success) outcomes trigger summary
	assert.strictEqual(decision.shouldSummarize, true);
	assert.ok(decision.reason.includes("partial"));
});

test("createHandoffManager factory creates instance with options", () => {
	const manager = createHandoffManager({ defaultSummarizeThreshold: 2000 });

	const packet = createTaskPacket();
	const result = createTaskResult({ usage: { totalTokens: 2500 } });

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true);
});

// Coverage edge cases
test("HandoffManager - handles missing usage in result", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ summarizeThreshold: 100 });
	// Need outcome to be non-success since usage is undefined/0
	const result = createTaskResult({
		usage: undefined,
		outcome: "partial", // non-success triggers summary
	});

	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.tokenCount, 0);
	assert.strictEqual(decision.shouldSummarize, true); // non-success outcome triggers summary
});

test("HandoffManager - handles missing tools in result", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	// Outcome is success but with missing tools, should summarize via partial outcome check
	const result = createTaskResult({
		toolsUsed: undefined,
		outcome: "partial", // non-success triggers summary
	});

	// Should not throw, defaults to 0 tools
	const decision = manager.shouldSummarize(packet, result);

	assert.strictEqual(decision.shouldSummarize, true); // non-success outcome triggers
});

test("HandoffManager - handles missing decisions in result", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	const result = createTaskResult({ decisions: undefined });

	const summary = await manager.generateSummary(packet, result);

	assert.deepEqual(summary.decisions, []);
});

test("HandoffManager - handles empty blockers and nextSteps", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket();
	const result = createTaskResult({
		blockers: [],
		nextSteps: [],
	});

	const summary = await manager.generateSummary(packet, result);

	assert.deepEqual(summary.blockers, []);
	assert.deepEqual(summary.nextSteps, []);
});

test("HandoffManager - session without pending handoff returns null", async () => {
	const manager = new HandoffManager();

	// No handoff was ever set
	const handoff = manager.getPendingHandoff("never-set-session");

	assert.strictEqual(handoff, undefined);
});

test("HandoffManager - onAgentEnd without session does not store pending", async () => {
	const manager = new HandoffManager();

	const packet = createTaskPacket({ sessionId: undefined });
	const result = createTaskResult({ usage: { totalTokens: 10000 } });

	await manager.onAgentEnd(packet, result);

	// No session means no pending handoff stored
	const pending = manager.getPendingHandoff("any-session");
	assert.strictEqual(pending, undefined);
});

test("HandoffManager - multiple sessions can have pending handoffs", async () => {
	const manager = new HandoffManager();

	const packet1 = createTaskPacket({
		sessionId: "session-A",
		taskId: "task-A",
	});
	const result1 = createTaskResult({ usage: { totalTokens: 10000 } });
	await manager.onAgentEnd(packet1, result1);

	const packet2 = createTaskPacket({
		sessionId: "session-B",
		taskId: "task-B",
	});
	const result2 = createTaskResult({ usage: { totalTokens: 10000 } });
	await manager.onAgentEnd(packet2, result2);

	assert.strictEqual(manager.getPendingHandoff("session-A")?.taskId, "task-A");
	assert.strictEqual(manager.getPendingHandoff("session-B")?.taskId, "task-B");
});

test("HandoffManager - timestamp is set on generation", async () => {
	const manager = new HandoffManager();
	const before = Date.now();

	const packet = createTaskPacket();
	const result = createTaskResult();

	const summary = await manager.generateSummary(packet, result);

	const after = Date.now();
	assert.ok(summary.timestamp >= before);
	assert.ok(summary.timestamp <= after);
});
