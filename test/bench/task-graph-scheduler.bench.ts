/**
 * Bench: task-graph scheduling throughput (HB-003 perf baseline).
 *
 * Measures the cost of the DAG scheduling path that decides which tasks are
 * ready to run next. `buildTaskGraphIndex` + `refreshTaskGraphQueues` +
 * `getReadyTasks` run on every task transition; on large fan-out runs (parallel
 * specialists, pipeline stages) the graph can have 50+ nodes, so an O(n²)
 * regression here would dominate scheduling latency.
 *
 * Scenario: build a synthetic 50-task DAG (linear chain + a 10-way parallel
 * fan-out layer), then simulate a full run by repeatedly picking ready tasks
 * and marking them done. Reports per-iteration cost.
 */
import { performance } from "node:perf_hooks";
import {
	buildTaskGraphIndex,
	refreshTaskGraphQueues,
	getReadyTasks,
	markTaskRunning,
	markTaskDone,
} from "../../src/runtime/task-graph-scheduler.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

const ITERS = Number(process.env.BENCH_ITERS ?? 50);
const now = () => new Date();

function makeTask(id: string, dependsOn: string[] = [], status: TeamTaskState["status"] = "queued"): TeamTaskState {
	return {
		id,
		runId: "bench-tg",
		role: "executor",
		agent: "executor",
		title: `task ${id}`,
		status,
		dependsOn,
		cwd: "/tmp/bench-tg",
	};
}

/** Build a synthetic DAG: linear chain [c0..c9] → fan-out [f0..f9] → merge [m0]. */
function makeDag(): TeamTaskState[] {
	const tasks: TeamTaskState[] = [];
	// Linear chain of 10.
	for (let i = 0; i < 10; i++) {
		tasks.push(makeTask(`c${i}`, i === 0 ? [] : [`c${i - 1}`]));
	}
	// Fan-out of 10, all depending on the last chain node.
	for (let i = 0; i < 10; i++) {
		tasks.push(makeTask(`f${i}`, ["c9"]));
	}
	// Merge node depending on all fan-out nodes.
	tasks.push(makeTask("m0", Array.from({ length: 10 }, (_v, i) => `f${i}`)));
	return tasks;
}

const buildIndex: number[] = [];
const refreshQueues: number[] = [];
const fullRun: number[] = [];

for (let iter = 0; iter < ITERS; iter++) {
	// 1. Cost of building the index from scratch.
	let t0 = performance.now();
	const index = buildTaskGraphIndex(makeDag());
	buildIndex.push(performance.now() - t0);

	// 2. Cost of refreshing queues once.
	let tasks = makeDag();
	t0 = performance.now();
	refreshTaskGraphQueues(tasks, index);
	refreshQueues.push(performance.now() - t0);

	// 3. Cost of simulating a full run (pick ready → run → done, until empty).
	t0 = performance.now();
	tasks = makeDag();
	let idx = buildTaskGraphIndex(tasks);
	let guard = 0;
	while (guard++ < 100) {
		const ready = getReadyTasks(tasks, 10, idx);
		if (ready.length === 0) break;
		for (const r of ready) tasks = markTaskRunning(tasks, r.id, now(), idx);
		for (const r of ready) tasks = markTaskDone(tasks, r.id, now(), idx);
		idx = buildTaskGraphIndex(tasks);
	}
	fullRun.push(performance.now() - t0);
}

buildIndex.sort((a, b) => a - b);
refreshQueues.sort((a, b) => a - b);
fullRun.sort((a, b) => a - b);

const out = {
	name: "task-graph-scheduler",
	iters: ITERS,
	tasksPerDag: makeDag().length,
	buildIndex: stats(buildIndex),
	refreshQueues: stats(refreshQueues),
	fullRun: stats(fullRun),
};
process.stdout.write(JSON.stringify(out) + "\n");

function stats(samples: number[]) {
	return {
		min: round(samples[0]),
		p50: round(percentile(samples, 0.5)),
		p95: round(percentile(samples, 0.95)),
		p99: round(percentile(samples, 0.99)),
		max: round(samples[samples.length - 1]),
	};
}
function percentile(sorted: number[], q: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q));
	return sorted[idx];
}
function round(n: number): number { return Math.round(n * 100) / 100; }
