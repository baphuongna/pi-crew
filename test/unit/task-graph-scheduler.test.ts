import assert from "node:assert/strict";
import test from "node:test";
import {
	buildTaskGraphIndex,
	cancelTaskSubtree,
	failTaskAndBlockChildren,
	getReadyTasks,
	markTaskDone,
	markTaskRunning,
	refreshTaskGraphQueues,
	taskGraphSnapshot,
} from "../../src/runtime/task-graph-scheduler.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

function task(id: string, stepId: string, dependsOn: string[] = [], children: string[] = []): TeamTaskState {
	return {
		id,
		runId: "run_1",
		stepId,
		role: "executor",
		agent: "executor",
		title: stepId,
		status: "queued",
		dependsOn,
		cwd: "/repo",
		graph: {
			taskId: id,
			dependencies: dependsOn,
			children,
			queue: dependsOn.length ? "blocked" : "ready",
		},
	};
}

function sampleTasks(): TeamTaskState[] {
	return [
		task("01_a", "a", [], ["02_b", "03_c"]),
		task("02_b", "b", ["a"], ["04_d"]),
		task("03_c", "c", ["a"]),
		task("04_d", "d", ["b"]),
	];
}

test("task graph scheduler exposes ready queue and advances dependencies", () => {
	let tasks = refreshTaskGraphQueues(sampleTasks());
	assert.deepEqual(taskGraphSnapshot(tasks).ready, ["01_a"]);
	tasks = markTaskRunning(tasks, "01_a");
	assert.deepEqual(taskGraphSnapshot(tasks).running, ["01_a"]);
	tasks = markTaskDone(tasks, "01_a");
	assert.deepEqual(
		getReadyTasks(tasks, 10).map((item) => item.id),
		["02_b", "03_c"],
	);
	tasks = markTaskDone(tasks, "02_b");
	assert.deepEqual(
		getReadyTasks(tasks, 10).map((item) => item.id),
		["03_c", "04_d"],
	);
});

test("task graph scheduler can cancel a subtree", () => {
	const tasks = cancelTaskSubtree(sampleTasks(), "02_b", "stop branch");
	const byId = new Map(tasks.map((item) => [item.id, item]));
	assert.equal(byId.get("01_a")?.status, "queued");
	assert.equal(byId.get("02_b")?.status, "cancelled");
	assert.equal(byId.get("04_d")?.status, "cancelled");
	assert.equal(byId.get("03_c")?.status, "queued");
});

test("task graph scheduler fails parent and skips queued descendants", () => {
	const tasks = failTaskAndBlockChildren(sampleTasks(), "01_a", "boom");
	const byId = new Map(tasks.map((item) => [item.id, item]));
	assert.equal(byId.get("01_a")?.status, "failed");
	assert.equal(byId.get("02_b")?.status, "skipped");
	assert.equal(byId.get("03_c")?.status, "skipped");
	assert.equal(byId.get("04_d")?.status, "skipped");
});

// P14 (perf): buildTaskGraphIndex is identity-memoized so repeated calls on
// the same array reference share the 3 data structures. A new array (e.g.
// after markTaskRunning / markTaskDone) invalidates the cache naturally.
test("buildTaskGraphIndex caches by array reference (P14)", () => {
	const tasks = sampleTasks();
	const a = buildTaskGraphIndex(tasks);
	const b = buildTaskGraphIndex(tasks);
	assert.strictEqual(a, b, "second call with same array reference returns the same index object");
	const mutated = markTaskRunning(tasks, "01_a");
	const c = buildTaskGraphIndex(mutated);
	assert.notStrictEqual(c, a, "different array reference gets a fresh index");
});

test("markTaskRunning/markTaskDone preserve cache invalidation", () => {
	const tasks = sampleTasks();
	const t1 = markTaskRunning(tasks, "01_a");
	const t2 = markTaskDone(t1, "01_a");
	// Each step produces a new array → each gets its own index.
	const i1 = buildTaskGraphIndex(t1);
	const i2 = buildTaskGraphIndex(t2);
	assert.notStrictEqual(i1, i2);
	assert.ok(i1.doneSteps.size === 0 && i1.idMap.size === 4);
	// t2 has "01_a" status="completed"; doneSteps is keyed by stepId (not task id).
	// stepId for "01_a" in sampleTasks() is "a".
	assert.ok(i2.doneSteps.has("a") && i2.idMap.size === 4);
});
