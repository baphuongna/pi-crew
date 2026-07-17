import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AnchorManager, AnchorNotFoundError, createAnchorManager, NoHandoffsError } from "../../src/runtime/anchor-manager.ts";
import type { HandoffSummary } from "../../src/runtime/handoff-manager.ts";

function makeHandoff(taskId: string, runId: string, outcome: "success" | "failure" | "partial" = "success"): HandoffSummary {
	return {
		taskId,
		runId,
		timestamp: Date.now(),
		task: `Task ${taskId}`,
		outcome,
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		blockers: [],
		nextSteps: [],
		metrics: {
			tokensUsed: 100,
			duration: 2000,
			iterations: 1,
			toolsUsed: ["bash"],
		},
		contextSnapshot: "test context",
	};
}

// ── setAnchor / getAnchor ──

describe("AnchorManager.setAnchor / getAnchor", () => {
	it("sets an anchor and retrieves it by session", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1", { key: "val" });
		assert.ok(id.startsWith("anchor-"));
		const anchor = mgr.getAnchor("sess-1");
		assert.ok(anchor !== null);
		assert.strictEqual(anchor.sessionId, "sess-1");
		assert.deepStrictEqual(anchor.context, { key: "val" });
		assert.strictEqual(anchor.handoffs.length, 0);
	});

	it("returns null for unknown session", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.getAnchor("no-such"), null);
	});

	it("replaces existing anchor when setting same session again", () => {
		const mgr = new AnchorManager();
		const id1 = mgr.setAnchor("sess-1");
		const id2 = mgr.setAnchor("sess-1", { updated: true });
		// Different anchor IDs
		assert.notStrictEqual(id1, id2);
		const anchor = mgr.getAnchor("sess-1");
		assert.ok(anchor);
		assert.deepStrictEqual(anchor.context, { updated: true });
	});

	it("emits anchor:created event", () => {
		const events: { event: string; data: unknown }[] = [];
		const mgr = new AnchorManager({
			eventEmitter: {
				emit: (event, data) => {
					events.push({ event, data });
				},
			},
		});
		mgr.setAnchor("sess-1");
		assert.strictEqual(events.length, 1);
		assert.strictEqual(events[0].event, "anchor:created");
	});
});

// ── getAnchorId ──

describe("AnchorManager.getAnchorId", () => {
	it("returns anchor ID for session", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		assert.strictEqual(mgr.getAnchorId("sess-1"), id);
	});

	it("returns undefined for unknown session", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.getAnchorId("no-such"), undefined);
	});

	it("returns undefined after clearing anchor", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		mgr.clearAnchor(id);
		assert.strictEqual(mgr.getAnchorId("sess-1"), undefined);
	});
});

// ── clearAnchor ──

describe("AnchorManager.clearAnchor", () => {
	it("returns accumulated summary and removes anchor", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		const summary = mgr.clearAnchor(id);
		assert.strictEqual(summary.taskId, "anchor-t1");
		assert.strictEqual(summary.outcome, "success");
		assert.strictEqual(mgr.getAnchor("sess-1"), null);
	});

	it("throws AnchorNotFoundError for unknown anchor", () => {
		const mgr = new AnchorManager();
		assert.throws(
			() => mgr.clearAnchor("no-such"),
			(err: unknown) => {
				assert.ok(err instanceof AnchorNotFoundError);
				assert.strictEqual(err.anchorId, "no-such");
				return true;
			},
		);
	});

	it("throws NoHandoffsError when no handoffs accumulated", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		assert.throws(() => mgr.clearAnchor(id), NoHandoffsError);
	});

	it("emits anchor:cleared event", () => {
		const events: { event: string; data: unknown }[] = [];
		const mgr = new AnchorManager({
			eventEmitter: {
				emit: (event, data) => {
					events.push({ event, data });
				},
			},
		});
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		mgr.clearAnchor(id);
		const clearedEvent = events.find((e) => e.event === "anchor:cleared");
		assert.ok(clearedEvent);
	});
});

// ── clearAnchorBySession ──

describe("AnchorManager.clearAnchorBySession", () => {
	it("clears anchor by session and returns summary", () => {
		const mgr = new AnchorManager();
		mgr.setAnchor("sess-1");
		const id = mgr.getAnchorId("sess-1")!;
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		const summary = mgr.clearAnchorBySession("sess-1");
		assert.ok(summary);
		assert.strictEqual(summary.outcome, "success");
	});

	it("returns null for unknown session", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.clearAnchorBySession("no-such"), null);
	});
});

// ── accumulateHandoff ──

describe("AnchorManager.accumulateHandoff", () => {
	it("accumulates handoff to existing anchor", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		mgr.accumulateHandoff(id, makeHandoff("t2", "r1"));
		const anchor = mgr.getAnchor("sess-1");
		assert.ok(anchor);
		assert.strictEqual(anchor.handoffs.length, 2);
	});

	it("creates implicit anchor if not exists", () => {
		const mgr = new AnchorManager();
		mgr.accumulateHandoff("anchor-implicit", makeHandoff("t1", "r1"));
		const anchor = mgr.getAllAnchors().find((a) => a.id === "anchor-implicit");
		assert.ok(anchor);
		assert.strictEqual(anchor.handoffs.length, 1);
	});

	it("enforces MAX_HANDOFFS_PER_ANCHOR by dropping oldest", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		// Add 101 handoffs (> MAX_HANDOFFS_PER_ANCHOR = 100)
		for (let i = 0; i < 101; i++) {
			mgr.accumulateHandoff(id, makeHandoff(`t${i}`, "r1"));
		}
		const anchor = mgr.getAnchor("sess-1");
		assert.ok(anchor);
		assert.strictEqual(anchor.handoffs.length, 100);
		// First handoff should have been evicted
		assert.strictEqual(anchor.handoffs[0].taskId, "t1");
	});
});

// ── accumulateHandoffBySession ──

describe("AnchorManager.accumulateHandoffBySession", () => {
	it("accumulates to existing session anchor", () => {
		const mgr = new AnchorManager();
		mgr.setAnchor("sess-1");
		mgr.accumulateHandoffBySession("sess-1", makeHandoff("t1", "r1"));
		assert.strictEqual(mgr.hasHandoffs(mgr.getAnchorId("sess-1")!), true);
	});

	it("creates new anchor if session has none", () => {
		const mgr = new AnchorManager();
		mgr.accumulateHandoffBySession("new-sess", makeHandoff("t1", "r1"));
		const id = mgr.getAnchorId("new-sess");
		assert.ok(id);
		assert.strictEqual(mgr.hasHandoffs(id!), true);
	});
});

// ── getAnchorHandoff ──

describe("AnchorManager.getAnchorHandoff", () => {
	it("returns merged summary without clearing", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		mgr.accumulateHandoff(id, makeHandoff("t2", "r1"));
		const summary = mgr.getAnchorHandoff(id);
		assert.ok(summary);
		assert.ok(summary.taskId.startsWith("anchor-"));
		// Anchor still exists
		assert.ok(mgr.getAnchor("sess-1"));
	});

	it("returns null for unknown anchor", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.getAnchorHandoff("no-such"), null);
	});

	it("returns null when anchor has no handoffs", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		assert.strictEqual(mgr.getAnchorHandoff(id), null);
	});
});

// ── getAnchorHandoffBySession ──

describe("AnchorManager.getAnchorHandoffBySession", () => {
	it("returns summary for session with handoffs", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		const summary = mgr.getAnchorHandoffBySession("sess-1");
		assert.ok(summary);
	});

	it("returns null for unknown session", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.getAnchorHandoffBySession("no-such"), null);
	});
});

// ── getAnchorStatus ──

describe("AnchorManager.getAnchorStatus", () => {
	it("returns status for existing anchor", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1", { env: "test" });
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		const status = mgr.getAnchorStatus(id);
		assert.ok(status);
		assert.strictEqual(status.anchorId, id);
		assert.strictEqual(status.sessionId, "sess-1");
		assert.strictEqual(status.handoffCount, 1);
		assert.strictEqual(status.totalTokens, 100);
		assert.strictEqual(status.totalDuration, 2000);
	});

	it("returns null for unknown anchor", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.getAnchorStatus("no-such"), null);
	});
});

// ── getAnchorStatusBySession ──

describe("AnchorManager.getAnchorStatusBySession", () => {
	it("returns status by session", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		const status = mgr.getAnchorStatusBySession("sess-1");
		assert.ok(status);
		assert.strictEqual(status!.anchorId, id);
	});

	it("returns null for unknown session", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.getAnchorStatusBySession("no-such"), null);
	});
});

// ── hasHandoffs ──

describe("AnchorManager.hasHandoffs", () => {
	it("returns false for anchor with no handoffs", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		assert.strictEqual(mgr.hasHandoffs(id), false);
	});

	it("returns true after accumulating a handoff", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		assert.strictEqual(mgr.hasHandoffs(id), true);
	});

	it("returns false for unknown anchor", () => {
		const mgr = new AnchorManager();
		assert.strictEqual(mgr.hasHandoffs("no-such"), false);
	});
});

// ── getAllAnchors ──

describe("AnchorManager.getAllAnchors", () => {
	it("returns empty array when no anchors", () => {
		const mgr = new AnchorManager();
		assert.deepStrictEqual(mgr.getAllAnchors(), []);
	});

	it("returns all anchors", () => {
		const mgr = new AnchorManager();
		mgr.setAnchor("s1");
		mgr.setAnchor("s2");
		assert.strictEqual(mgr.getAllAnchors().length, 2);
	});
});

// ── clearAll ──

describe("AnchorManager.clearAll", () => {
	it("removes all anchors and session mappings", () => {
		const mgr = new AnchorManager();
		mgr.setAnchor("s1");
		mgr.setAnchor("s2");
		mgr.clearAll();
		assert.strictEqual(mgr.getAllAnchors().length, 0);
		assert.strictEqual(mgr.getAnchorId("s1"), undefined);
	});

	it("emits anchor:cleared_all event", () => {
		const events: { event: string }[] = [];
		const mgr = new AnchorManager({
			eventEmitter: {
				emit: (event) => {
					events.push({ event });
				},
			},
		});
		mgr.clearAll();
		assert.ok(events.some((e) => e.event === "anchor:cleared_all"));
	});
});

// ── accumulation merging ──

describe("AnchorManager accumulation merging", () => {
	it("merges multiple handoffs combining metrics", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1"));
		mgr.accumulateHandoff(id, {
			...makeHandoff("t2", "r1"),
			metrics: {
				tokensUsed: 200,
				duration: 3000,
				iterations: 2,
				toolsUsed: ["edit"],
			},
		});
		const summary = mgr.getAnchorHandoff(id);
		assert.ok(summary);
		assert.strictEqual(summary.metrics.tokensUsed, 300);
		assert.strictEqual(summary.metrics.duration, 5000);
		assert.strictEqual(summary.metrics.iterations, 3);
		assert.deepStrictEqual(summary.metrics.toolsUsed, ["bash", "edit"]);
	});

	it("sets outcome to failure if any handoff failed", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1", "success"));
		mgr.accumulateHandoff(id, makeHandoff("t2", "r1", "failure"));
		const summary = mgr.getAnchorHandoff(id);
		assert.ok(summary);
		assert.strictEqual(summary.outcome, "failure");
	});

	it("sets outcome to partial if some are partial and none are failure", () => {
		const mgr = new AnchorManager();
		const id = mgr.setAnchor("sess-1");
		mgr.accumulateHandoff(id, makeHandoff("t1", "r1", "success"));
		mgr.accumulateHandoff(id, makeHandoff("t2", "r1", "partial"));
		const summary = mgr.getAnchorHandoff(id);
		assert.ok(summary);
		assert.strictEqual(summary.outcome, "partial");
	});
});

// ── createAnchorManager factory ──

describe("createAnchorManager", () => {
	it("creates an AnchorManager instance", () => {
		const mgr = createAnchorManager();
		assert.ok(mgr instanceof AnchorManager);
	});

	it("creates an AnchorManager with options", () => {
		const events: unknown[] = [];
		const mgr = createAnchorManager({
			eventEmitter: {
				emit: (_e, d) => {
					events.push(d);
				},
			},
		});
		mgr.setAnchor("s1");
		assert.strictEqual(events.length, 1);
	});
});
