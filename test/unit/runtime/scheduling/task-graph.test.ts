import assert from "node:assert/strict";
import test from "node:test";
import { buildExecutionPlan, detectCycles, getReadyTasks, type TaskNode } from "../../../../src/runtime/scheduling/task-graph.ts";

// Helper factories
function node(id: string, dependsOn: string[] = [], phase?: string): TaskNode {
	return { id, dependsOn, ...(phase !== undefined ? { phase } : {}) };
}

// ── buildExecutionPlan ──────────────────────────────────────────────────────

test("buildExecutionPlan: empty input returns empty plan", () => {
	const plan = buildExecutionPlan([]);
	assert.equal(plan.waves.length, 0);
	assert.equal(plan.hasCycle, false);
	assert.equal(plan.cycleNodes, undefined);
});

test("buildExecutionPlan: single task goes into wave 0", () => {
	const plan = buildExecutionPlan([node("A")]);
	assert.equal(plan.waves.length, 1);
	assert.deepEqual(plan.waves[0].taskIds, ["A"]);
	assert.equal(plan.waves[0].index, 0);
	assert.equal(plan.hasCycle, false);
});

test("buildExecutionPlan: linear chain A→B→C produces 3 waves", () => {
	const plan = buildExecutionPlan([node("A"), node("B", ["A"]), node("C", ["B"])]);
	assert.equal(plan.waves.length, 3);
	assert.deepEqual(plan.waves[0].taskIds, ["A"]);
	assert.deepEqual(plan.waves[1].taskIds, ["B"]);
	assert.deepEqual(plan.waves[2].taskIds, ["C"]);
	assert.equal(plan.hasCycle, false);
});

test("buildExecutionPlan: diamond A→B, A→C, B→D, C→D produces 3 waves", () => {
	const plan = buildExecutionPlan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]);
	assert.equal(plan.waves.length, 3);
	assert.deepEqual(plan.waves[0].taskIds, ["A"]);
	// B and C should be in the same wave
	assert.equal(plan.waves[1].taskIds.length, 2);
	assert.ok(plan.waves[1].taskIds.includes("B"));
	assert.ok(plan.waves[1].taskIds.includes("C"));
	assert.deepEqual(plan.waves[2].taskIds, ["D"]);
	assert.equal(plan.hasCycle, false);
});

test("buildExecutionPlan: independent tasks all go into wave 0", () => {
	const plan = buildExecutionPlan([node("X"), node("Y"), node("Z")]);
	assert.equal(plan.waves.length, 1);
	assert.equal(plan.waves[0].taskIds.length, 3);
	assert.ok(plan.waves[0].taskIds.includes("X"));
	assert.ok(plan.waves[0].taskIds.includes("Y"));
	assert.ok(plan.waves[0].taskIds.includes("Z"));
	assert.equal(plan.hasCycle, false);
});

test("buildExecutionPlan: backward compat — no dependsOn = all wave 0", () => {
	const tasks = [node("a"), node("b"), node("c")];
	const plan = buildExecutionPlan(tasks);
	assert.equal(plan.waves.length, 1);
	assert.equal(plan.waves[0].taskIds.length, 3);
});

test("buildExecutionPlan: detects cycle and reports cycle nodes", () => {
	const plan = buildExecutionPlan([node("A", ["B"]), node("B", ["C"]), node("C", ["A"])]);
	assert.equal(plan.hasCycle, true);
	assert.ok(plan.cycleNodes !== undefined);
	assert.equal(plan.cycleNodes!.length, 3);
	// The waves should be empty since no node has in-degree 0
	assert.equal(plan.waves.length, 0);
});

test("buildExecutionPlan: cycle with partial DAG still produces waves for acyclic portion", () => {
	const plan = buildExecutionPlan([node("root"), node("child", ["root"]), node("X", ["Y"]), node("Y", ["X"])]);
	assert.equal(plan.hasCycle, true);
	assert.ok(plan.cycleNodes!.includes("X"));
	assert.ok(plan.cycleNodes!.includes("Y"));
	// The acyclic portion (root → child) should still have waves
	assert.ok(plan.waves.length >= 1);
	const allWaveIds = plan.waves.flatMap((w) => w.taskIds);
	assert.ok(allWaveIds.includes("root"));
	assert.ok(allWaveIds.includes("child"));
});

test("buildExecutionPlan: wave label from shared phase", () => {
	const plan = buildExecutionPlan([node("A", [], "setup"), node("B", [], "setup"), node("C", ["A", "B"], "build")]);
	assert.equal(plan.waves[0].label, "setup");
	assert.equal(plan.waves[1].label, "build");
});

test("buildExecutionPlan: wave label undefined when phases differ", () => {
	const plan = buildExecutionPlan([node("A", [], "setup"), node("B", [], "build")]);
	assert.equal(plan.waves[0].label, undefined);
});

test("buildExecutionPlan: ignores unknown dependency IDs gracefully", () => {
	const plan = buildExecutionPlan([node("A", ["nonexistent"])]);
	// "nonexistent" is not in the task set, so it's ignored → A has no effective deps
	assert.equal(plan.waves.length, 1);
	assert.deepEqual(plan.waves[0].taskIds, ["A"]);
	assert.equal(plan.hasCycle, false);
});

// ── detectCycles ────────────────────────────────────────────────────────────

test("detectCycles: returns empty for acyclic graph", () => {
	const cycles = detectCycles([node("A"), node("B", ["A"]), node("C", ["B"])]);
	assert.equal(cycles.length, 0);
});

test("detectCycles: detects simple cycle A→B→A", () => {
	const cycles = detectCycles([node("A", ["B"]), node("B", ["A"])]);
	assert.ok(cycles.length >= 1);
	const flat = cycles.flat();
	assert.ok(flat.includes("A"));
	assert.ok(flat.includes("B"));
});

test("detectCycles: detects three-node cycle", () => {
	const cycles = detectCycles([node("A", ["C"]), node("B", ["A"]), node("C", ["B"])]);
	assert.ok(cycles.length >= 1);
});

test("detectCycles: returns empty for empty input", () => {
	const cycles = detectCycles([]);
	assert.equal(cycles.length, 0);
});

test("detectCycles: returns empty for single node with no deps", () => {
	const cycles = detectCycles([node("A")]);
	assert.equal(cycles.length, 0);
});

test("detectCycles: detects self-loop", () => {
	const cycles = detectCycles([node("A", ["A"])]);
	assert.ok(cycles.length >= 1);
	assert.ok(cycles[0].includes("A"));
});

// ── getReadyTasks ───────────────────────────────────────────────────────────

test("getReadyTasks: returns wave 0 tasks when nothing is completed", () => {
	const plan = buildExecutionPlan([node("A"), node("B", ["A"])]);
	const ready = getReadyTasks(plan, new Set());
	assert.deepEqual(ready, ["A"]);
});

test("getReadyTasks: returns next wave after completing dependencies", () => {
	const plan = buildExecutionPlan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]);
	const ready1 = getReadyTasks(plan, new Set());
	assert.deepEqual(ready1, ["A"]);

	const ready2 = getReadyTasks(plan, new Set(["A"]));
	assert.equal(ready2.length, 2);
	assert.ok(ready2.includes("B"));
	assert.ok(ready2.includes("C"));

	const ready3 = getReadyTasks(plan, new Set(["A", "B", "C"]));
	assert.deepEqual(ready3, ["D"]);
});

test("getReadyTasks: returns empty when all tasks are completed", () => {
	const plan = buildExecutionPlan([node("A"), node("B", ["A"])]);
	const ready = getReadyTasks(plan, new Set(["A", "B"]));
	assert.deepEqual(ready, []);
});

test("getReadyTasks: returns empty for plan with cycle", () => {
	const plan = buildExecutionPlan([node("A", ["B"]), node("B", ["A"])]);
	// Plan has cycle → getReadyTasks returns empty
	const ready = getReadyTasks(plan, new Set());
	assert.deepEqual(ready, []);
});

test("getReadyTasks: returns empty for empty plan", () => {
	const plan = buildExecutionPlan([]);
	const ready = getReadyTasks(plan, new Set());
	assert.deepEqual(ready, []);
});

test("getReadyTasks: partial completion in diamond skips already-done tasks", () => {
	const plan = buildExecutionPlan([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"])]);
	// After completing A and B (but not C), D should not be ready yet
	const ready = getReadyTasks(plan, new Set(["A", "B"]));
	assert.ok(!ready.includes("D"));
	// C should be in the ready set
	assert.ok(ready.includes("C"));
});

test("getReadyTasks: independent tasks all ready initially", () => {
	const plan = buildExecutionPlan([node("X"), node("Y"), node("Z")]);
	const ready = getReadyTasks(plan, new Set());
	assert.equal(ready.length, 3);
});
