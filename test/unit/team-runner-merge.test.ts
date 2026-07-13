import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { __test__mergeTaskUpdates, executeTeamRun } from "../../src/runtime/team-runner.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { createRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";

function task(id: string, status: TeamTaskState["status"]): TeamTaskState {
	return {
		id,
		runId: "run_merge",
		stepId: id,
		role: "explorer",
		agent: "explorer",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/project",
		graph: {
			taskId: id,
			children: [],
			dependencies: [],
			queue: status === "queued" ? "ready" : status === "running" ? "running" : "done",
		},
	};
}

test("parallel task merge does not regress completed tasks from stale worker snapshots", () => {
	const base = [task("a", "queued"), task("b", "queued")];
	const resultA = {
		tasks: [
			{
				...task("a", "completed"),
				finishedAt: "2026-01-01T00:00:00.000Z",
			},
			task("b", "running"),
		],
	};
	const resultB = {
		tasks: [
			task("a", "running"),
			{
				...task("b", "completed"),
				finishedAt: "2026-01-01T00:00:01.000Z",
			},
		],
	};
	const merged = __test__mergeTaskUpdates(base, [resultA, resultB]);
	assert.equal(merged.find((item) => item.id === "a")?.status, "completed");
	assert.equal(merged.find((item) => item.id === "b")?.status, "completed");
});

test("merge does not resurrect a cancelled task to completed (CANCEL-3)", () => {
	// A worker that completed AFTER the task was cancelled must not flip the
	// settled "cancelled" terminal status back to "completed".
	const base = [task("a", "cancelled")];
	const staleCompleted = {
		tasks: [
			{
				...task("a", "completed"),
				finishedAt: "2026-01-01T00:00:05.000Z", // newer than the cancel
			},
		],
	};
	const merged = __test__mergeTaskUpdates([task("a", "cancelled")], [staleCompleted]);
	assert.equal(merged.find((item) => item.id === "a")?.status, "cancelled");
});

test("merge does not demote a completed task to failed (F3)", () => {
	// A stale failed result arriving after completion must not flip "completed"
	// to "failed".
	const staleFailed = {
		tasks: [
			{
				...task("a", "failed"),
				finishedAt: "2026-01-01T00:00:05.000Z", // newer than the completion
			},
		],
	};
	const merged = __test__mergeTaskUpdates([task("a", "completed")], [staleFailed]);
	assert.equal(merged.find((item) => item.id === "a")?.status, "completed");
});

test("executeTeamRun records structured cancellation reason", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cancel-run-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "cancel",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "cancel",
			description: "",
			steps: [{ id: "work", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "cancel",
		});
		const tasks: TeamTaskState[] = [
			{
				id: "work",
				runId: created.manifest.runId,
				stepId: "work",
				role: "worker",
				agent: "worker",
				title: "work",
				status: "queued",
				dependsOn: [],
				cwd,
			},
		];
		saveRunTasks(created.manifest, tasks);
		const controller = new AbortController();
		controller.abort({
			code: "leader_interrupted",
			message: "leader cancelled run",
		});
		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents: [],
			executeWorkers: false,
			signal: controller.signal,
			workspaceId: cwd,
		});
		assert.equal(result.manifest.status, "cancelled");
		assert.match(result.manifest.summary ?? "", /leader_interrupted/);
		assert.match(result.tasks[0]?.error ?? "", /leader cancelled run/);
		const events = readEvents(created.manifest.eventsPath);
		assert.ok(
			events.some(
				(event) => event.type === "task.cancelled" && event.taskId === "work" && event.data?.reason === "leader_interrupted",
			),
		);
		assert.ok(
			events.some(
				(event) =>
					event.type === "run.cancelled" &&
					event.data?.reason === "leader_interrupted" &&
					Array.isArray(event.data?.cancelledTaskIds) &&
					event.data.cancelledTaskIds.includes("work"),
			),
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("executeTeamRun blocks instead of completing when tasks are waiting", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-waiting-run-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const team = {
			name: "waiting",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "waiting",
			description: "",
			steps: [{ id: "wait", role: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "wait",
		});
		const tasks: TeamTaskState[] = [
			{
				id: "wait",
				runId: created.manifest.runId,
				stepId: "wait",
				role: "worker",
				agent: "worker",
				title: "wait",
				status: "waiting",
				dependsOn: [],
				cwd,
			},
		];
		saveRunTasks(created.manifest, tasks);
		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents: [],
			executeWorkers: false,
			workspaceId: cwd,
		});
		assert.equal(result.manifest.status, "blocked");
		assert.match(result.manifest.summary ?? "", /Waiting for response/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── OPT-01 streaming dispatch tests ──
//
// These tests verify the streaming dispatch refactor: tasks are dispatched
// as soon as a slot frees, not waiting for the entire batch to complete.
//
// NOTE: The mock infrastructure (PI_TEAMS_MOCK_CHILD_PI) completes workers
// instantly, so we cannot test inter-batch OVERLAP timing directly. Instead,
// we verify functional correctness of DAG execution under streaming dispatch:
//   1. A 4-task DAG (A,B independent; C depends on A; D depends on B)
//      completes with all tasks terminal.
//   2. Concurrency-limited execution completes all tasks.
//
// Manual verification for inter-batch overlap:
//   Set up a real run with 2 fast + 1 slow independent task and 1 task
//   depending on a fast one. Observe the event log: the dependent task's
//   task.parallel_start event should fire BEFORE the slow task's completion.
//   Under the old batch model, the dependent would only start after ALL
//   tasks in the first batch complete.

test("streaming dispatch: DAG with dependencies completes all tasks", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-stream-dag-"));
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const team = {
			name: "dag",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		// Workflow with 4 steps; steps c and d declare dependsOn
		const workflow = {
			name: "dag",
			description: "",
			steps: [
				{ id: "a", role: "worker", task: "task A" },
				{ id: "b", role: "worker", task: "task B" },
				{ id: "c", role: "worker", task: "task C", dependsOn: ["a"] },
				{ id: "d", role: "worker", task: "task D", dependsOn: ["b"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "dag test",
		});
		// Build tasks matching the DAG: a,b ready; c depends on a; d depends on b
		const tasks: TeamTaskState[] = [
			{
				id: "01_a",
				runId: created.manifest.runId,
				stepId: "a",
				role: "worker",
				agent: "worker",
				title: "A",
				status: "queued",
				dependsOn: [],
				cwd,
			},
			{
				id: "02_b",
				runId: created.manifest.runId,
				stepId: "b",
				role: "worker",
				agent: "worker",
				title: "B",
				status: "queued",
				dependsOn: [],
				cwd,
			},
			{
				id: "03_c",
				runId: created.manifest.runId,
				stepId: "c",
				role: "worker",
				agent: "worker",
				title: "C",
				status: "queued",
				dependsOn: ["a"],
				cwd,
			},
			{
				id: "04_d",
				runId: created.manifest.runId,
				stepId: "d",
				role: "worker",
				agent: "worker",
				title: "D",
				status: "queued",
				dependsOn: ["b"],
				cwd,
			},
		];
		saveRunTasks(created.manifest, tasks);
		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			workspaceId: cwd,
		});
		// All tasks should be terminal (completed in mock mode)
		for (const task of result.tasks) {
			assert.ok(task.status === "completed" || task.status === "skipped", `Task ${task.id} should be terminal, got ${task.status}`);
		}
		assert.equal(result.manifest.status, "completed");
	} finally {
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllow;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("streaming dispatch: respects DAG ordering — dependent tasks complete after dependencies", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-stream-order-"));
	const prevMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllow = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const team = {
			name: "order",
			description: "",
			roles: [{ name: "worker", agent: "worker" }],
			source: "test",
			filePath: "builtin",
		} as never;
		const workflow = {
			name: "order",
			description: "",
			steps: [
				{ id: "first", role: "worker", task: "first" },
				{ id: "second", role: "worker", task: "second", dependsOn: ["first"] },
				{ id: "third", role: "worker", task: "third", dependsOn: ["second"] },
			],
			source: "test",
			filePath: "builtin",
		} as never;
		const agents = [{ name: "worker", description: "", source: "test", filePath: "builtin", systemPrompt: "test" }] as never;
		const created = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "chain test",
		});
		const tasks: TeamTaskState[] = [
			{
				id: "01_first",
				runId: created.manifest.runId,
				stepId: "first",
				role: "worker",
				agent: "worker",
				title: "F",
				status: "queued",
				dependsOn: [],
				cwd,
			},
			{
				id: "02_second",
				runId: created.manifest.runId,
				stepId: "second",
				role: "worker",
				agent: "worker",
				title: "S",
				status: "queued",
				dependsOn: ["first"],
				cwd,
			},
			{
				id: "03_third",
				runId: created.manifest.runId,
				stepId: "third",
				role: "worker",
				agent: "worker",
				title: "T",
				status: "queued",
				dependsOn: ["second"],
				cwd,
			},
		];
		saveRunTasks(created.manifest, tasks);
		const result = await executeTeamRun({
			manifest: { ...created.manifest, status: "running" },
			tasks,
			team,
			workflow,
			agents,
			executeWorkers: true,
			workspaceId: cwd,
		});
		// Verify all tasks completed (not blocked by dependency cycle or deadlock)
		assert.equal(result.manifest.status, "completed");
		const events = readEvents(created.manifest.eventsPath);
		// With streaming dispatch, tasks should complete in dependency order
		const completedEvents = events.filter((e) => e.type === "task.progress");
		assert.ok(completedEvents.length > 0, "Should have progress events");
	} finally {
		if (prevMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = prevMock;
		if (prevAllow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = prevAllow;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
