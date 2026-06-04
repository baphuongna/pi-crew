import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
	HandoffManager,
	createHandoffManager,
	isValidHandoffSummary,
} from "../../src/runtime/handoff-manager.ts";
import type {
	TaskPacket,
	TaskResult,
	HandoffSummary,
	HandoffManagerOptions,
	Decision,
} from "../../src/runtime/handoff-manager.ts";

// Use a very long cleanup interval to reduce timer frequency.
const NO_TIMER_OPTS: HandoffManagerOptions = { cleanupIntervalMs: 2 ** 30 };

// Track all managers for cleanup after tests complete.
const allManagers: HandoffManager[] = [];

function makeManager(opts?: HandoffManagerOptions): HandoffManager {
	const mgr = new HandoffManager({ ...NO_TIMER_OPTS, ...opts });
	allManagers.push(mgr);
	return mgr;
}

const factoryManagers: HandoffManager[] = [];
after(() => {
	for (const mgr of [...allManagers, ...factoryManagers]) mgr.dispose();
});

function makePacket(overrides: Partial<TaskPacket> = {}): TaskPacket {
	return {
		taskId: "task-01",
		runId: "run-01",
		goal: "Test task",
		sessionId: "sess-01",
		...overrides,
	};
}

function makeResult(overrides: Partial<TaskResult> = {}): TaskResult {
	return {
		outcome: "success",
		usage: { totalTokens: 100 },
		duration: 5000,
		iterations: 1,
		toolsUsed: ["bash", "edit", "read"],
		...overrides,
	};
}

function makeHandoffSummary(overrides: Partial<HandoffSummary> = {}): HandoffSummary {
	return {
		taskId: "task-01",
		runId: "run-01",
		timestamp: Date.now(),
		task: "Test task",
		outcome: "success",
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		blockers: [],
		nextSteps: [],
		metrics: { tokensUsed: 100, duration: 5000, iterations: 1, toolsUsed: ["bash"] },
		contextSnapshot: "snapshot",
		...overrides,
	};
}

// ── isValidHandoffSummary ──

describe("isValidHandoffSummary", () => {
	it("returns true for valid summary", () => {
		const summary = makeHandoffSummary();
		assert.strictEqual(isValidHandoffSummary(summary), true);
	});

	it("returns false for null", () => {
		assert.strictEqual(isValidHandoffSummary(null), false);
	});

	it("returns false for undefined", () => {
		assert.strictEqual(isValidHandoffSummary(undefined), false);
	});

	it("returns false when taskId is missing", () => {
		const summary = makeHandoffSummary();
		const bad = { ...summary, taskId: "" };
		assert.strictEqual(isValidHandoffSummary(bad), false);
	});

	it("returns false when outcome is invalid", () => {
		const summary = makeHandoffSummary();
		const bad = { ...summary, outcome: "unknown" };
		assert.strictEqual(isValidHandoffSummary(bad), false);
	});

	it("returns false when metrics is missing", () => {
		const summary = makeHandoffSummary();
		const bad = { ...summary, metrics: undefined };
		assert.strictEqual(isValidHandoffSummary(bad), false);
	});

	it("returns false when filesCreated is not array", () => {
		const summary = makeHandoffSummary() as any;
		summary.filesCreated = "not-array";
		assert.strictEqual(isValidHandoffSummary(summary), false);
	});
});

// ── shouldSummarize ──

describe("HandoffManager.shouldSummarize", () => {
	it("returns true when token count exceeds threshold", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		const result = mgr.shouldSummarize(makePacket(), makeResult({ usage: { totalTokens: 100 } }));
		assert.strictEqual(result.shouldSummarize, true);
		assert.ok(result.reason.includes("exceeds threshold"));
	});

	it("returns true when 3+ tools used", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const result = mgr.shouldSummarize(
			makePacket(),
			makeResult({ toolsUsed: ["bash", "edit", "read"], usage: { totalTokens: 10 } }),
		);
		assert.strictEqual(result.shouldSummarize, true);
	});

	it("returns true when forceSummarize is set", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const result = mgr.shouldSummarize(
			makePacket({ forceSummarize: true }),
			makeResult({ usage: { totalTokens: 10 }, toolsUsed: [] }),
		);
		assert.strictEqual(result.shouldSummarize, true);
	});

	it("returns true when outcome is failure", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const result = mgr.shouldSummarize(
			makePacket(),
			makeResult({ outcome: "failure", usage: { totalTokens: 10 }, toolsUsed: [] }),
		);
		assert.strictEqual(result.shouldSummarize, true);
	});

	it("returns true when outcome is partial", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const result = mgr.shouldSummarize(
			makePacket(),
			makeResult({ outcome: "partial", usage: { totalTokens: 10 }, toolsUsed: [] }),
		);
		assert.strictEqual(result.shouldSummarize, true);
	});

	it("returns true when files were created", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const result = mgr.shouldSummarize(
			makePacket(),
			makeResult({ usage: { totalTokens: 10 }, toolsUsed: [], filesCreated: ["a.ts"] }),
		);
		assert.strictEqual(result.shouldSummarize, true);
	});

	it("returns false when below threshold and no significant activity", () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const result = mgr.shouldSummarize(
			makePacket(),
			makeResult({ usage: { totalTokens: 10 }, toolsUsed: [] }),
		);
		assert.strictEqual(result.shouldSummarize, false);
	});

	it("returns false for invalid packet", () => {
		const mgr = makeManager();
		const result = mgr.shouldSummarize({ taskId: "" } as any, makeResult());
		assert.strictEqual(result.shouldSummarize, false);
		assert.strictEqual(result.reason, "Invalid task packet structure");
	});

	it("returns false for invalid result", () => {
		const mgr = makeManager();
		const result = mgr.shouldSummarize(makePacket(), { outcome: undefined } as any);
		assert.strictEqual(result.shouldSummarize, false);
		assert.strictEqual(result.reason, "Invalid task result structure");
	});
});

// ── onAgentEnd ──

describe("HandoffManager.onAgentEnd", () => {
	it("generates and stores handoff summary", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		const summary = await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 100 } }),
		);
		assert.ok(summary);
		assert.strictEqual(summary.taskId, "task-01");
		assert.strictEqual(summary.outcome, "success");
		assert.strictEqual(mgr.getPendingCount(), 1);
	});

	it("returns null when should not summarize", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 99999 });
		const summary = await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 10 }, toolsUsed: [] }),
		);
		assert.strictEqual(summary, null);
	});

	it("returns null when manager is disposed", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 0 });
		mgr.dispose();
		const summary = await mgr.onAgentEnd(makePacket(), makeResult());
		assert.strictEqual(summary, null);
	});
});

// ── onBeforeTreeNavigation ──

describe("HandoffManager.onBeforeTreeNavigation", () => {
	it("returns pending handoff and clears it", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 100 } }),
		);
		const handoff = await mgr.onBeforeTreeNavigation("sess-1", "tree-node");
		assert.ok(handoff);
		assert.strictEqual(handoff.taskId, "task-01");
		// Pending should be cleared
		assert.strictEqual(mgr.getPendingCount(), 0);
	});

	it("returns null when no pending handoff", async () => {
		const mgr = makeManager();
		const handoff = await mgr.onBeforeTreeNavigation("no-sess", "node");
		assert.strictEqual(handoff, null);
	});

	it("returns null when disposed", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 100 } }),
		);
		mgr.dispose();
		const handoff = await mgr.onBeforeTreeNavigation("sess-1", "node");
		assert.strictEqual(handoff, null);
	});
});

// ── getPendingHandoff / clearPendingHandoff ──

describe("HandoffManager pending handoff management", () => {
	it("getPendingHandoff returns stored summary", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 100 } }),
		);
		const pending = mgr.getPendingHandoff("sess-1");
		assert.ok(pending);
		assert.strictEqual(pending.taskId, "task-01");
	});

	it("clearPendingHandoff removes the handoff", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 100 } }),
		);
		mgr.clearPendingHandoff("sess-1");
		assert.strictEqual(mgr.getPendingHandoff("sess-1"), undefined);
		assert.strictEqual(mgr.getPendingCount(), 0);
	});

	it("clearAllPendingHandoffs removes everything", async () => {
		const mgr = makeManager({ defaultSummarizeThreshold: 50 });
		await mgr.onAgentEnd(
			makePacket({ sessionId: "sess-1" }),
			makeResult({ usage: { totalTokens: 100 } }),
		);
		mgr.clearAllPendingHandoffs();
		assert.strictEqual(mgr.getPendingCount(), 0);
	});
});

// ── generateSummary ──

describe("HandoffManager.generateSummary", () => {
	it("includes file artifacts from result", async () => {
		const mgr = makeManager();
		const summary = await mgr.generateSummary(
			makePacket(),
			makeResult({ filesCreated: ["a.ts"], filesModified: ["b.ts"], filesDeleted: ["c.ts"] }),
		);
		assert.deepStrictEqual(summary.filesCreated, ["a.ts"]);
		assert.deepStrictEqual(summary.filesModified, ["b.ts"]);
		assert.deepStrictEqual(summary.filesDeleted, ["c.ts"]);
	});

	it("includes decisions from result", async () => {
		const decisions: Decision[] = [{ rationale: "needed X", outcome: "built X", alternativesConsidered: ["Y"] }];
		const mgr = makeManager();
		const summary = await mgr.generateSummary(makePacket(), makeResult({ decisions }));
		assert.strictEqual(summary.decisions.length, 1);
		assert.strictEqual(summary.decisions[0].rationale, "needed X");
	});

	it("generates default decision for failure", async () => {
		const mgr = makeManager();
		const summary = await mgr.generateSummary(
			makePacket(),
			makeResult({ outcome: "failure", error: "something broke" }),
		);
		assert.strictEqual(summary.decisions.length, 1);
		assert.strictEqual(summary.decisions[0].outcome, "something broke");
	});
});

// ── dispose / isDisposed ──

describe("HandoffManager.dispose", () => {
	it("marks manager as disposed", () => {
		const mgr = makeManager();
		assert.strictEqual(mgr.isDisposed(), false);
		mgr.dispose();
		assert.strictEqual(mgr.isDisposed(), true);
	});

	it("can be called multiple times safely", () => {
		const mgr = makeManager();
		mgr.dispose();
		mgr.dispose(); // should not throw
		assert.strictEqual(mgr.isDisposed(), true);
	});
});

// ── createHandoffManager ──

describe("createHandoffManager", () => {
	it("creates a HandoffManager instance", () => {
		const mgr = createHandoffManager({ cleanupIntervalMs: 2 ** 30 });
		factoryManagers.push(mgr);
		assert.ok(mgr instanceof HandoffManager);
	});

	it("accepts options", () => {
		const mgr = createHandoffManager({ defaultSummarizeThreshold: 100, cleanupIntervalMs: 2 ** 30 });
		factoryManagers.push(mgr);
		assert.ok(mgr instanceof HandoffManager);
	});
});
