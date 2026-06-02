import test from "node:test";
import assert from "node:assert/strict";
import {
	shouldMaterializeAgent,
	taskById,
	waitingReason,
	formatTaskGraphLines,
} from "../../src/runtime/task-display.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

/**
 * Round 30 (test coverage gaps): `task-display.ts` provides task display
 * helpers for dashboards and status formatting.
 *
 * Tests cover the pure-function surface. recordsForMaterializedTasks is
 * skipped (requires manifest I/O).
 */

function makeTask(overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id: "task-1",
		runId: "run-1",
		stepId: "step-1",
		role: "executor",
		agent: "executor",
		title: "Test task",
		status: "queued",
		cwd: "/tmp",
		dependsOn: [],
		...overrides,
	} as TeamTaskState;
}

// ─── shouldMaterializeAgent ────────────────────────────────────────────────

test("shouldMaterializeAgent: false for queued", () => {
	assert.equal(shouldMaterializeAgent(makeTask({ status: "queued" })), false);
});

test("shouldMaterializeAgent: false for skipped", () => {
	assert.equal(shouldMaterializeAgent(makeTask({ status: "skipped" })), false);
});

test("shouldMaterializeAgent: true for running", () => {
	assert.equal(shouldMaterializeAgent(makeTask({ status: "running" })), true);
});

test("shouldMaterializeAgent: true for completed", () => {
	assert.equal(shouldMaterializeAgent(makeTask({ status: "completed" })), true);
});

test("shouldMaterializeAgent: true for failed", () => {
	assert.equal(shouldMaterializeAgent(makeTask({ status: "failed" })), true);
});

// ─── taskById ──────────────────────────────────────────────────────────────

test("taskById: creates map keyed by task id", () => {
	const tasks = [makeTask({ id: "a", stepId: "step-a" }), makeTask({ id: "b", stepId: "step-b" })];
	const map = taskById(tasks);
	assert.equal(map.size, 4); // 2 ids + 2 stepIds
	assert.equal(map.get("a")?.id, "a");
	assert.equal(map.get("b")?.id, "b");
});

test("taskById: also indexes by stepId", () => {
	const tasks = [makeTask({ id: "a", stepId: "step-a" })];
	const map = taskById(tasks);
	assert.equal(map.size, 2);
	assert.equal(map.get("step-a")?.id, "a");
});

test("taskById: returns empty map for empty array", () => {
	assert.equal(taskById([]).size, 0);
});

// ─── waitingReason ─────────────────────────────────────────────────────────

test("waitingReason: undefined for non-queued task", () => {
	const task = makeTask({ status: "running" });
	assert.equal(waitingReason(task, []), undefined);
});

test("waitingReason: 'ready' when no dependencies pending", () => {
	const dep = makeTask({ id: "dep-1", status: "completed" });
	const task = makeTask({ status: "queued", dependsOn: ["dep-1"] });
	assert.equal(waitingReason(task, [dep, task]), "ready");
});

test("waitingReason: lists pending dependencies", () => {
	const dep = makeTask({ id: "dep-1", status: "running" });
	const task = makeTask({ status: "queued", dependsOn: ["dep-1"] });
	const reason = waitingReason(task, [dep, task]);
	assert.match(reason ?? "", /waiting for dep-1/);
});

test("waitingReason: lists multiple pending dependencies", () => {
	const d1 = makeTask({ id: "d1", status: "running" });
	const d2 = makeTask({ id: "d2", status: "queued" });
	const task = makeTask({ status: "queued", dependsOn: ["d1", "d2"] });
	const reason = waitingReason(task, [d1, d2, task]);
	assert.match(reason ?? "", /d1/);
	assert.match(reason ?? "", /d2/);
});

test("waitingReason: resolves stepId dependencies", () => {
	const dep = makeTask({ id: "dep-1", stepId: "step-dep", status: "running" });
	const task = makeTask({ id: "task-2", stepId: "step-2", status: "queued", dependsOn: ["step-dep"] });
	const reason = waitingReason(task, [dep, task]);
	assert.match(reason ?? "", /dep-1/);
});

// ─── formatTaskGraphLines ──────────────────────────────────────────────────

test("formatTaskGraphLines: returns '(none)' for empty tasks", () => {
	const lines = formatTaskGraphLines([]);
	assert.deepEqual(lines, ["- (none)"]);
});

test("formatTaskGraphLines: formats tasks with status icons", () => {
	const tasks = [
		makeTask({ id: "t1", status: "completed", role: "executor", agent: "exec" }),
		makeTask({ id: "t2", status: "running", role: "explorer", agent: "exp" }),
		makeTask({ id: "t3", status: "failed", role: "reviewer", agent: "rev" }),
	];
	const lines = formatTaskGraphLines(tasks);
	assert.equal(lines.length, 3);
	assert.match(lines[0]!, /✓/);
	assert.match(lines[1]!, /⠋/);
	assert.match(lines[2]!, /✗/);
});

test("formatTaskGraphLines: includes waiting reason for queued tasks", () => {
	const dep = makeTask({ id: "dep", status: "running" });
	const task = makeTask({ id: "t1", status: "queued", dependsOn: ["dep"] });
	const lines = formatTaskGraphLines([dep, task]);
	assert.match(lines[1]!, /waiting for dep/);
});
