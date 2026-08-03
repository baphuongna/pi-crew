import assert from "node:assert/strict";
import test from "node:test";
import { GroupJoinManager, resolveGroupJoinMode, shouldGroupJoin } from "../../../../src/runtime/group-join.ts";

/**
 * Round 25 (test coverage gaps): `group-join.ts` provides group-join mode
 * resolution, predicate logic, and the GroupJoinManager class that batches
 * agent completions for consolidated delivery.
 *
 * Tests cover pure-function surface and the GroupJoinManager class.
 * The `deliverGroupJoin` function requires file I/O and is not tested here.
 */

// ─── resolveGroupJoinMode ──────────────────────────────────────────────────

test("resolveGroupJoinMode: returns 'smart' by default", () => {
	assert.equal(resolveGroupJoinMode(undefined), "smart");
});

test("resolveGroupJoinMode: returns configured mode", () => {
	assert.equal(resolveGroupJoinMode({ groupJoin: "off" } as any), "off");
	assert.equal(resolveGroupJoinMode({ groupJoin: "group" } as any), "group");
	assert.equal(resolveGroupJoinMode({ groupJoin: "smart" } as any), "smart");
});

// ─── shouldGroupJoin ───────────────────────────────────────────────────────

test("shouldGroupJoin: 'off' mode always returns false", () => {
	assert.equal(shouldGroupJoin("off", [{ status: "completed" } as any]), false);
	assert.equal(shouldGroupJoin("off", []), false);
});

test("shouldGroupJoin: 'group' mode returns true for any non-empty batch", () => {
	assert.equal(shouldGroupJoin("group", [{ status: "completed" } as any]), true);
	assert.equal(shouldGroupJoin("group", []), false);
});

test("shouldGroupJoin: 'smart' mode returns true only for batch size > 1", () => {
	assert.equal(shouldGroupJoin("smart", []), false);
	assert.equal(shouldGroupJoin("smart", [{ status: "completed" } as any]), false);
	assert.equal(shouldGroupJoin("smart", [{ status: "completed" } as any, { status: "completed" } as any]), true);
});

// ─── GroupJoinManager ──────────────────────────────────────────────────────

function makeRecord(taskId: string) {
	return { taskId, status: "completed" } as any;
}

test("GroupJoinManager: delivers when all agents complete", () => {
	const deliveries: { records: any[]; partial: boolean }[] = [];
	const mgr = new GroupJoinManager((records, partial) => {
		deliveries.push({ records, partial });
	});
	mgr.registerGroup("g1", ["a1", "a2"]);

	assert.equal(mgr.onAgentComplete(makeRecord("a1")), "held");
	assert.equal(deliveries.length, 0);

	assert.equal(mgr.onAgentComplete(makeRecord("a2")), "delivered");
	assert.equal(deliveries.length, 1);
	assert.equal(deliveries[0]!.records.length, 2);
	assert.equal(deliveries[0]!.partial, false);
});

test("GroupJoinManager: returns 'pass' for unknown agent", () => {
	const mgr = new GroupJoinManager(() => undefined);
	mgr.registerGroup("g1", ["a1"]);
	assert.equal(mgr.onAgentComplete(makeRecord("unknown")), "pass");
});

test("GroupJoinManager: returns 'pass' for already-delivered group", () => {
	const mgr = new GroupJoinManager(() => undefined);
	mgr.registerGroup("g1", ["a1"]);
	assert.equal(mgr.onAgentComplete(makeRecord("a1")), "delivered");
	// Second completion for same agent should return "pass" (group already delivered)
	assert.equal(mgr.onAgentComplete(makeRecord("a1")), "pass");
});

test("GroupJoinManager: isGrouped returns true for registered agent", () => {
	const mgr = new GroupJoinManager(() => undefined);
	mgr.registerGroup("g1", ["a1", "a2"]);
	assert.equal(mgr.isGrouped("a1"), true);
	assert.equal(mgr.isGrouped("a2"), true);
	assert.equal(mgr.isGrouped("a3"), false);
});

test("GroupJoinManager: isGrouped returns false after delivery", () => {
	const mgr = new GroupJoinManager(() => undefined);
	mgr.registerGroup("g1", ["a1"]);
	mgr.onAgentComplete(makeRecord("a1"));
	assert.equal(mgr.isGrouped("a1"), false);
});

test("GroupJoinManager: timeout delivers partial results", (_, done) => {
	const deliveries: { records: any[]; partial: boolean }[] = [];
	const mgr = new GroupJoinManager((records, partial) => {
		deliveries.push({ records, partial });
		// After partial delivery, cleanup happens
		assert.equal(deliveries.length, 1);
		assert.equal(deliveries[0]!.partial, true);
		assert.equal(deliveries[0]!.records.length, 1);
		mgr.dispose();
		done();
	}, 50);

	mgr.registerGroup("g1", ["a1", "a2"]);
	mgr.onAgentComplete(makeRecord("a1"));
	// a2 never completes — timeout should fire
});

test("GroupJoinManager: dispose clears timers and maps", () => {
	const mgr = new GroupJoinManager(() => undefined, 60000);
	mgr.registerGroup("g1", ["a1"]);
	assert.equal(mgr.isGrouped("a1"), true);
	mgr.dispose();
	assert.equal(mgr.isGrouped("a1"), false);
});

test("GroupJoinManager: handles multiple groups independently", () => {
	const deliveries: any[] = [];
	const mgr = new GroupJoinManager((records, partial) => {
		deliveries.push(records);
	});
	mgr.registerGroup("g1", ["a1"]);
	mgr.registerGroup("g2", ["b1", "b2"]);

	assert.equal(mgr.onAgentComplete(makeRecord("a1")), "delivered");
	assert.equal(deliveries.length, 1);

	assert.equal(mgr.onAgentComplete(makeRecord("b1")), "held");
	assert.equal(mgr.onAgentComplete(makeRecord("b2")), "delivered");
	assert.equal(deliveries.length, 2);

	mgr.dispose();
});
