/**
 * Unit tests for AnchorManager.
 * @see src/runtime/anchor-manager.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import { AnchorManager, AnchorNotFoundError, createAnchorManager, NoHandoffsError } from "../../src/runtime/anchor-manager.ts";
import type { HandoffSummary } from "../../src/runtime/handoff-manager.ts";

// Test helpers
function createHandoffSummary(overrides: Partial<HandoffSummary> = {}): HandoffSummary {
	return {
		taskId: "test-task-1",
		runId: "test-run-1",
		timestamp: Date.now(),
		task: "Test task",
		outcome: "success",
		filesCreated: ["file1.ts"],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		blockers: [],
		nextSteps: [],
		metrics: {
			tokensUsed: 1000,
			duration: 5000,
			iterations: 1,
			toolsUsed: ["read", "write"],
		},
		contextSnapshot: "Test context",
		...overrides,
	};
}

function createDecision() {
	return {
		rationale: "Chose approach A",
		outcome: "Successfully implemented",
		alternativesConsidered: ["Approach B"],
	};
}

test("AnchorManager - setAnchor creates anchor with unique ID", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	assert.ok(anchorId.startsWith("anchor-"));
	assert.strictEqual(typeof anchorId, "string");
	assert.ok(anchorId.length > "anchor-".length);
});

test("AnchorManager - setAnchor for same session creates new anchor each time", () => {
	const manager = new AnchorManager();
	const anchorId1 = manager.setAnchor("session-1");
	const anchorId2 = manager.setAnchor("session-1");

	// setAnchor creates a new anchor each time (overwrites session->anchor mapping)
	assert.notStrictEqual(anchorId2, anchorId1);

	// The latest anchor is returned by getAnchor
	const anchor = manager.getAnchor("session-1");
	assert.ok(anchor !== null);
	assert.strictEqual(anchor!.id, anchorId2);
});

test("AnchorManager - setAnchor with context stores context", () => {
	const manager = new AnchorManager();
	const context = { key: "value", nested: { data: 123 } };
	const anchorId = manager.setAnchor("session-1", context);

	const anchor = manager.getAnchor("session-1");
	assert.deepEqual(anchor?.context, context);
});

test("AnchorManager - getAnchor returns anchor for session", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	const anchor = manager.getAnchor("session-1");
	assert.ok(anchor !== null);
	assert.strictEqual(anchor!.id, anchorId);
	assert.strictEqual(anchor!.sessionId, "session-1");
});

test("AnchorManager - getAnchor returns null for unknown session", () => {
	const manager = new AnchorManager();

	const anchor = manager.getAnchor("unknown-session");
	assert.strictEqual(anchor, null);
});

test("AnchorManager - getAnchorId returns anchor ID for session", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	const foundId = manager.getAnchorId("session-1");
	assert.strictEqual(foundId, anchorId);
});

test("AnchorManager - getAnchorId returns undefined for unknown session", () => {
	const manager = new AnchorManager();

	const foundId = manager.getAnchorId("unknown-session");
	assert.strictEqual(foundId, undefined);
});

test("AnchorManager - accumulateHandoff adds handoff to anchor", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");
	const handoff = createHandoffSummary({ task: "Task 1" });

	manager.accumulateHandoff(anchorId, handoff);

	const anchor = manager.getAnchor("session-1");
	assert.strictEqual(anchor?.handoffs.length, 1);
	assert.strictEqual(anchor?.handoffs[0].task, "Task 1");
});

test("AnchorManager - accumulateHandoffBySession adds handoff to session anchor", () => {
	const manager = new AnchorManager();
	manager.setAnchor("session-1");
	const handoff = createHandoffSummary({ task: "Task by session" });

	manager.accumulateHandoffBySession("session-1", handoff);

	const anchor = manager.getAnchor("session-1");
	assert.strictEqual(anchor?.handoffs.length, 1);
	assert.strictEqual(anchor?.handoffs[0].task, "Task by session");
});

test("AnchorManager - accumulateHandoff creates implicit anchor if not exists", () => {
	const manager = new AnchorManager();
	const handoff = createHandoffSummary({ runId: "run-xyz" });

	// No anchor set for this anchor ID, should create implicit one
	manager.accumulateHandoff("implicit-anchor", handoff);

	// Should be able to get the handoff
	const anchorHandoff = manager.getAnchorHandoff("implicit-anchor");
	assert.ok(anchorHandoff !== null);
	// Task is prefixed with "Accumulated:" in the accumulateHandoffs method
	assert.ok(anchorHandoff!.task.includes("Test task"));
});

test("AnchorManager - getAnchorHandoff merges handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ task: "Task 1", filesCreated: ["a.ts"] }));
	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			task: "Task 2",
			filesCreated: ["b.ts", "a.ts"],
		}),
	);

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.ok(accumulated !== null);
	assert.ok(accumulated!.task.includes("Task 1"));
	assert.ok(accumulated!.task.includes("Task 2"));
	// Files should be deduplicated
	assert.deepEqual(accumulated!.filesCreated, ["a.ts", "b.ts"]);
});

test("AnchorManager - getAnchorHandoff merges metrics correctly", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			metrics: {
				tokensUsed: 1000,
				duration: 5000,
				iterations: 1,
				toolsUsed: ["read"],
			},
		}),
	);
	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			metrics: {
				tokensUsed: 2000,
				duration: 3000,
				iterations: 2,
				toolsUsed: ["write"],
			},
		}),
	);

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.ok(accumulated !== null);
	assert.strictEqual(accumulated!.metrics.tokensUsed, 3000);
	assert.strictEqual(accumulated!.metrics.duration, 8000);
	assert.strictEqual(accumulated!.metrics.iterations, 3);
	assert.deepEqual(accumulated!.metrics.toolsUsed, ["read", "write"]);
});

test("AnchorManager - getAnchorHandoff returns null when no handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.strictEqual(accumulated, null);
});

test("AnchorManager - getAnchorHandoff returns null for unknown anchor", () => {
	const manager = new AnchorManager();

	const accumulated = manager.getAnchorHandoff("unknown-anchor");
	assert.strictEqual(accumulated, null);
});

test("AnchorManager - clearAnchor removes anchor and returns accumulated", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");
	manager.accumulateHandoff(anchorId, createHandoffSummary({ task: "Task 1" }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ task: "Task 2" }));

	const accumulated = manager.clearAnchor(anchorId);

	assert.ok(accumulated.task.includes("Task 1") && accumulated.task.includes("Task 2"));
	assert.strictEqual(manager.getAnchor("session-1"), null);
});

test("AnchorManager - clearAnchorBySession clears anchor by session ID", () => {
	const manager = new AnchorManager();
	manager.setAnchor("session-1");
	manager.accumulateHandoffBySession("session-1", createHandoffSummary({ task: "Task" }));

	const accumulated = manager.clearAnchorBySession("session-1");

	assert.ok(accumulated !== null);
	assert.strictEqual(manager.getAnchor("session-1"), null);
});

test("AnchorManager - clearAnchor throws AnchorNotFoundError for unknown anchor", () => {
	const manager = new AnchorManager();

	assert.throws(() => manager.clearAnchor("unknown-anchor"), AnchorNotFoundError);
});

test("AnchorManager - clearAnchor throws NoHandoffsError when no handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	assert.throws(() => manager.clearAnchor(anchorId), NoHandoffsError);
});

test("AnchorManager - getAnchorStatus returns correct status", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1", { initial: "context" });
	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			metrics: {
				tokensUsed: 1000,
				duration: 5000,
				iterations: 1,
				toolsUsed: ["read"],
			},
		}),
	);
	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			metrics: {
				tokensUsed: 2000,
				duration: 3000,
				iterations: 2,
				toolsUsed: ["write"],
			},
		}),
	);

	const status = manager.getAnchorStatus(anchorId);

	assert.ok(status !== null);
	assert.strictEqual(status.anchorId, anchorId);
	assert.strictEqual(status.sessionId, "session-1");
	assert.strictEqual(status.handoffCount, 2);
	assert.strictEqual(status.totalTokens, 3000);
	assert.strictEqual(status.totalDuration, 8000);
	assert.deepEqual(status.context, { initial: "context" });
});

test("AnchorManager - getAnchorStatus returns null for unknown anchor", () => {
	const manager = new AnchorManager();

	const status = manager.getAnchorStatus("unknown-anchor");
	assert.strictEqual(status, null);
});

test("AnchorManager - getAnchorStatusBySession returns correct status", () => {
	const manager = new AnchorManager();
	manager.setAnchor("session-1", { key: "value" });

	const status = manager.getAnchorStatusBySession("session-1");

	assert.ok(status !== null);
	assert.strictEqual(status.sessionId, "session-1");
	assert.deepEqual(status.context, { key: "value" });
});

test("AnchorManager - getAnchorStatusBySession returns null for unknown session", () => {
	const manager = new AnchorManager();

	const status = manager.getAnchorStatusBySession("unknown-session");
	assert.strictEqual(status, null);
});

test("AnchorManager - hasHandoffs returns true when handoffs exist", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");
	manager.accumulateHandoff(anchorId, createHandoffSummary());

	assert.strictEqual(manager.hasHandoffs(anchorId), true);
});

test("AnchorManager - hasHandoffs returns false when no handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	assert.strictEqual(manager.hasHandoffs(anchorId), false);
});

test("AnchorManager - hasHandoffs returns false for unknown anchor", () => {
	const manager = new AnchorManager();

	assert.strictEqual(manager.hasHandoffs("unknown-anchor"), false);
});

test("AnchorManager - getAllAnchors returns all anchors", () => {
	const manager = new AnchorManager();
	manager.setAnchor("session-1");
	manager.setAnchor("session-2");

	const anchors = manager.getAllAnchors();

	assert.strictEqual(anchors.length, 2);
	assert.ok(anchors.some((a) => a.sessionId === "session-1"));
	assert.ok(anchors.some((a) => a.sessionId === "session-2"));
});

test("AnchorManager - clearAll removes all anchors", () => {
	const manager = new AnchorManager();
	manager.setAnchor("session-1");
	manager.setAnchor("session-2");

	manager.clearAll();

	assert.strictEqual(manager.getAllAnchors().length, 0);
	assert.strictEqual(manager.getAnchor("session-1"), null);
	assert.strictEqual(manager.getAnchor("session-2"), null);
});

test("AnchorManager - accumulated outcome is success when all handoffs succeed", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ outcome: "success" }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ outcome: "success" }));

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.strictEqual(accumulated!.outcome, "success");
});

test("AnchorManager - accumulated outcome is failure when any handoff fails", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ outcome: "success" }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ outcome: "failure" }));

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.strictEqual(accumulated!.outcome, "failure");
});

test("AnchorManager - accumulated outcome is partial when some fail and some succeed", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ outcome: "success" }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ outcome: "partial" }));

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.strictEqual(accumulated!.outcome, "partial");
});

test("AnchorManager - accumulates decisions across handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			decisions: [createDecision()],
		}),
	);
	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			decisions: [
				{
					rationale: "Second decision",
					outcome: "Done",
					alternativesConsidered: [],
				},
			],
		}),
	);

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.strictEqual(accumulated!.decisions.length, 2);
});

test("AnchorManager - deduplicates blockers across handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ blockers: ["blocker1"] }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ blockers: ["blocker1", "blocker2"] }));

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.deepEqual(accumulated!.blockers, ["blocker1", "blocker2"]);
});

test("AnchorManager - accumulates nextSteps across handoffs", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ nextSteps: ["Step 1"] }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ nextSteps: ["Step 2", "Step 3"] }));

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.deepEqual(accumulated!.nextSteps, ["Step 1", "Step 2", "Step 3"]);
});

test("AnchorManager - contextSnapshot joins with separator", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(anchorId, createHandoffSummary({ contextSnapshot: "Context 1" }));
	manager.accumulateHandoff(anchorId, createHandoffSummary({ contextSnapshot: "Context 2" }));

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.ok(accumulated!.contextSnapshot.includes("Context 1"));
	assert.ok(accumulated!.contextSnapshot.includes("Context 2"));
	assert.ok(accumulated!.contextSnapshot.includes("---"));
});

test("AnchorManager - emits anchor:created event", () => {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	const manager = new AnchorManager({
		eventEmitter: {
			emit(event: string, data: unknown) {
				emittedEvents.push({ event, data });
			},
		},
	});

	manager.setAnchor("session-1");

	assert.ok(emittedEvents.some((e) => e.event === "anchor:created"));
});

test("AnchorManager - emits anchor:handoffAccumulated event", () => {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	const manager = new AnchorManager({
		eventEmitter: {
			emit(event: string, data: unknown) {
				emittedEvents.push({ event, data });
			},
		},
	});

	const anchorId = manager.setAnchor("session-1");
	manager.accumulateHandoff(anchorId, createHandoffSummary());

	assert.ok(emittedEvents.some((e) => e.event === "anchor:handoffAccumulated"));
});

test("AnchorManager - emits anchor:cleared event", () => {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	const manager = new AnchorManager({
		eventEmitter: {
			emit(event: string, data: unknown) {
				emittedEvents.push({ event, data });
			},
		},
	});

	const anchorId = manager.setAnchor("session-1");
	manager.accumulateHandoff(anchorId, createHandoffSummary());
	manager.clearAnchor(anchorId);

	assert.ok(emittedEvents.some((e) => e.event === "anchor:cleared"));
});

test("AnchorManager - emits anchor:cleared_all event", () => {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	const manager = new AnchorManager({
		eventEmitter: {
			emit(event: string, data: unknown) {
				emittedEvents.push({ event, data });
			},
		},
	});

	manager.setAnchor("session-1");
	manager.setAnchor("session-2");
	manager.clearAll();

	assert.ok(emittedEvents.some((e) => e.event === "anchor:cleared_all"));
});

test("createAnchorManager factory creates instance", () => {
	const manager = createAnchorManager();

	assert.ok(manager instanceof AnchorManager);
});

// Error class tests
test("AnchorNotFoundError - has correct name and message", () => {
	const error = new AnchorNotFoundError("anchor-123");

	assert.strictEqual(error.name, "AnchorNotFoundError");
	assert.strictEqual(error.message, "Anchor not found: anchor-123");
	assert.strictEqual(error.anchorId, "anchor-123");
});

test("NoHandoffsError - has correct name and message", () => {
	const error = new NoHandoffsError();

	assert.strictEqual(error.name, "NoHandoffsError");
	assert.strictEqual(error.message, "No handoffs to accumulate");
});

// Edge cases
test("AnchorManager - handles empty files array", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");

	manager.accumulateHandoff(
		anchorId,
		createHandoffSummary({
			filesCreated: [],
			filesModified: [],
			filesDeleted: [],
		}),
	);

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.deepEqual(accumulated!.filesCreated, []);
	assert.deepEqual(accumulated!.filesModified, []);
	assert.deepEqual(accumulated!.filesDeleted, []);
});

test("AnchorManager - handles single handoff", () => {
	const manager = new AnchorManager();
	const anchorId = manager.setAnchor("session-1");
	const handoff = createHandoffSummary({ task: "Single task" });

	manager.accumulateHandoff(anchorId, handoff);

	const accumulated = manager.getAnchorHandoff(anchorId);
	assert.ok(accumulated !== null);
	// Task is prefixed with "Accumulated:" in the accumulateHandoffs method
	assert.ok(accumulated!.task.includes("Single task"));
});

test("AnchorManager - multiple sessions have independent anchors", () => {
	const manager = new AnchorManager();

	const anchorId1 = manager.setAnchor("session-1");
	const anchorId2 = manager.setAnchor("session-2");

	manager.accumulateHandoff(anchorId1, createHandoffSummary({ task: "Task 1" }));
	manager.accumulateHandoff(anchorId2, createHandoffSummary({ task: "Task 2" }));

	const h1 = manager.getAnchorHandoff(anchorId1);
	const h2 = manager.getAnchorHandoff(anchorId2);

	// Task is prefixed with "Accumulated:" in the accumulateHandoffs method
	assert.ok(h1?.task.includes("Task 1"));
	assert.ok(h2?.task.includes("Task 2"));
});
