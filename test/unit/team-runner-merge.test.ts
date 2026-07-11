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
