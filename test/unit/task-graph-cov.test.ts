import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildExecutionPlan,
	detectCycles,
	findBlockedTasks,
	getBlockingTasks,
	getReadyTasks,
	type TaskNode,
	topologicalSort,
} from "../../src/runtime/scheduling/task-graph.ts";

// ── buildExecutionPlan ─────────────────────────────────────────────────

describe("buildExecutionPlan", () => {
	it("returns empty waves for empty input", () => {
		const plan = buildExecutionPlan([]);
		assert.deepStrictEqual(plan.waves, []);
		assert.strictEqual(plan.hasCycle, false);
	});

	it("puts all independent tasks in wave 0", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: [] },
			{ id: "c", dependsOn: [] },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.waves.length, 1);
		assert.strictEqual(plan.waves[0].index, 0);
		assert.deepStrictEqual(new Set(plan.waves[0].taskIds), new Set(["a", "b", "c"]));
		assert.strictEqual(plan.hasCycle, false);
	});

	it("creates waves for linear chain a→b→c", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
			{ id: "c", dependsOn: ["b"] },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.waves.length, 3);
		assert.deepStrictEqual(plan.waves[0].taskIds, ["a"]);
		assert.deepStrictEqual(plan.waves[1].taskIds, ["b"]);
		assert.deepStrictEqual(plan.waves[2].taskIds, ["c"]);
	});

	it("creates diamond dependency shape", () => {
		const tasks: TaskNode[] = [
			{ id: "root", dependsOn: [] },
			{ id: "left", dependsOn: ["root"] },
			{ id: "right", dependsOn: ["root"] },
			{ id: "join", dependsOn: ["left", "right"] },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.waves.length, 3);
		assert.deepStrictEqual(new Set(plan.waves[0].taskIds), new Set(["root"]));
		assert.deepStrictEqual(new Set(plan.waves[1].taskIds), new Set(["left", "right"]));
		assert.deepStrictEqual(plan.waves[2].taskIds, ["join"]);
	});

	it("detects cycle between two nodes", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: ["b"] },
			{ id: "b", dependsOn: ["a"] },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.hasCycle, true);
		assert.ok(plan.cycleNodes);
		assert.strictEqual(plan.cycleNodes!.length, 2);
	});

	it("detects self-dependency and throws", () => {
		const tasks: TaskNode[] = [{ id: "x", dependsOn: ["x"] }];
		assert.throws(() => buildExecutionPlan(tasks), /self-dependency/);
	});

	it("ignores unknown dependencies", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a", "nonexistent"] },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.waves.length, 2);
		assert.deepStrictEqual(plan.waves[0].taskIds, ["a"]);
		assert.deepStrictEqual(plan.waves[1].taskIds, ["b"]);
		assert.strictEqual(plan.hasCycle, false);
	});

	it("sets wave label when all tasks share phase", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [], phase: "setup" },
			{ id: "b", dependsOn: [], phase: "setup" },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.waves[0].label, "setup");
	});

	it("omits wave label when tasks have mixed phases", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [], phase: "setup" },
			{ id: "b", dependsOn: [], phase: "build" },
		];
		const plan = buildExecutionPlan(tasks);
		assert.strictEqual(plan.waves[0].label, undefined);
	});
});

// ── getReadyTasks ───────────────────────────────────────────────────────

describe("getReadyTasks", () => {
	it("returns empty for plan with cycle", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: ["b"] },
			{ id: "b", dependsOn: ["a"] },
		];
		const plan = buildExecutionPlan(tasks);
		const ready = getReadyTasks(plan, new Set());
		assert.deepStrictEqual(ready, []);
	});

	it("returns wave-0 tasks when nothing completed", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		const plan = buildExecutionPlan(tasks);
		const ready = getReadyTasks(plan, new Set());
		assert.deepStrictEqual(ready, ["a"]);
	});

	it("returns wave-1 tasks after wave-0 completed", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		const plan = buildExecutionPlan(tasks);
		const ready = getReadyTasks(plan, new Set(["a"]));
		assert.deepStrictEqual(ready, ["b"]);
	});

	it("returns empty when all tasks completed", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		const plan = buildExecutionPlan(tasks);
		const ready = getReadyTasks(plan, new Set(["a", "b"]));
		assert.deepStrictEqual(ready, []);
	});

	it("returns empty for empty plan", () => {
		const plan = buildExecutionPlan([]);
		assert.deepStrictEqual(getReadyTasks(plan, new Set()), []);
	});
});

// ── detectCycles ────────────────────────────────────────────────────────

describe("detectCycles", () => {
	it("returns empty for no tasks", () => {
		assert.deepStrictEqual(detectCycles([]), []);
	});

	it("returns empty for DAG with no cycles", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		assert.deepStrictEqual(detectCycles(tasks), []);
	});

	it("detects simple two-node cycle", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: ["b"] },
			{ id: "b", dependsOn: ["a"] },
		];
		const cycles = detectCycles(tasks);
		assert.ok(cycles.length > 0, "should detect at least one cycle");
	});

	it("detects self-loop as a cycle", () => {
		const tasks: TaskNode[] = [{ id: "a", dependsOn: ["a"] }];
		const cycles = detectCycles(tasks);
		assert.ok(cycles.length > 0);
		assert.ok(cycles[0].includes("a"));
	});

	it("detects three-node cycle", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: ["c"] },
			{ id: "b", dependsOn: ["a"] },
			{ id: "c", dependsOn: ["b"] },
		];
		const cycles = detectCycles(tasks);
		assert.ok(cycles.length > 0);
	});
});

// ── findBlockedTasks ────────────────────────────────────────────────────

describe("findBlockedTasks", () => {
	it("returns empty when all completed", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		assert.deepStrictEqual(findBlockedTasks(tasks, new Set(["a", "b"])), []);
	});

	it("returns tasks with incomplete deps", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		const blocked = findBlockedTasks(tasks, new Set());
		assert.deepStrictEqual(blocked, ["b"]);
	});

	it("excludes tasks already completed", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: ["x"] },
			{ id: "b", dependsOn: [] },
		];
		const blocked = findBlockedTasks(tasks, new Set(["a"]));
		assert.deepStrictEqual(blocked, []);
	});

	it("returns multiple blocked tasks", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: ["root"] },
			{ id: "b", dependsOn: ["root"] },
			{ id: "root", dependsOn: [] },
		];
		const blocked = findBlockedTasks(tasks, new Set());
		assert.deepStrictEqual(new Set(blocked), new Set(["a", "b"]));
	});
});

// ── getBlockingTasks ────────────────────────────────────────────────────

describe("getBlockingTasks", () => {
	it("returns empty for unknown task", () => {
		const tasks: TaskNode[] = [{ id: "a", dependsOn: [] }];
		assert.deepStrictEqual(getBlockingTasks(tasks, "unknown", new Set()), []);
	});

	it("returns incomplete deps for a task", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a", "c"] },
		];
		const blocking = getBlockingTasks(tasks, "b", new Set(["a"]));
		assert.deepStrictEqual(blocking, ["c"]);
	});

	it("returns empty when all deps completed", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
		];
		assert.deepStrictEqual(getBlockingTasks(tasks, "b", new Set(["a"])), []);
	});
});

// ── topologicalSort ─────────────────────────────────────────────────────

describe("topologicalSort", () => {
	it("returns empty for empty input", () => {
		assert.deepStrictEqual(topologicalSort([]), []);
	});

	it("orders linear chain correctly", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: ["a"] },
			{ id: "c", dependsOn: ["b"] },
		];
		const order = topologicalSort(tasks);
		assert.ok(order.indexOf("a") < order.indexOf("b"));
		assert.ok(order.indexOf("b") < order.indexOf("c"));
	});

	it("includes all nodes", () => {
		const tasks: TaskNode[] = [
			{ id: "a", dependsOn: [] },
			{ id: "b", dependsOn: [] },
			{ id: "c", dependsOn: ["a", "b"] },
		];
		const order = topologicalSort(tasks);
		assert.deepStrictEqual(new Set(order), new Set(["a", "b", "c"]));
	});

	it("respects diamond dependency order", () => {
		const tasks: TaskNode[] = [
			{ id: "root", dependsOn: [] },
			{ id: "left", dependsOn: ["root"] },
			{ id: "right", dependsOn: ["root"] },
			{ id: "join", dependsOn: ["left", "right"] },
		];
		const order = topologicalSort(tasks);
		assert.ok(order.indexOf("root") < order.indexOf("left"));
		assert.ok(order.indexOf("root") < order.indexOf("right"));
		assert.ok(order.indexOf("left") < order.indexOf("join"));
		assert.ok(order.indexOf("right") < order.indexOf("join"));
	});
});
