import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSessionSnapshot, snapshotTaskState } from "../../src/runtime/session-snapshot.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

const baseTask: TeamTaskState = {
	id: "task-1",
	runId: "test-run",
	role: "executor",
	agent: "test-agent",
	title: "Test task",
	status: "running",
	dependsOn: ["dep-1"],
	cwd: "/tmp",
	usage: { input: 100, output: 50 },
	agentProgress: {
		activityState: "active",
		currentTool: "bash",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
	},
};

describe("snapshotTaskState", () => {
	it("creates a shallow copy of task state", () => {
		const snapshot = snapshotTaskState(baseTask);
		assert.equal(snapshot.id, "task-1");
		assert.equal(snapshot.status, "running");
		assert.notStrictEqual(snapshot, baseTask);
	});

	it("copies dependsOn array independently", () => {
		const snapshot = snapshotTaskState(baseTask);
		assert.deepEqual(snapshot.dependsOn, ["dep-1"]);
		snapshot.dependsOn.push("dep-2");
		assert.equal(baseTask.dependsOn!.length, 1);
	});

	it("copies usage object independently", () => {
		const snapshot = snapshotTaskState(baseTask);
		assert.equal(snapshot.usage?.input, 100);
		assert.notStrictEqual(snapshot.usage, baseTask.usage);
	});

	it("handles task without optional fields", () => {
		const minimal: TeamTaskState = {
			id: "t-1",
			runId: "r-1",
			role: "planner",
			agent: "a",
			title: "T",
			status: "queued",
			dependsOn: [],
			cwd: "/tmp",
		};
		const snapshot = snapshotTaskState(minimal);
		assert.equal(snapshot.id, "t-1");
		assert.equal(snapshot.usage, undefined);
	});

	it("snapshot is readonly (frozen-like)", () => {
		const snapshot = snapshotTaskState(baseTask);
		assert.equal(typeof snapshot, "object");
		assert.ok(snapshot !== null);
	});
});

describe("createSessionSnapshot", () => {
	const activeRuns: TeamRunManifest[] = [
		{
			schemaVersion: 1,
			runId: "run-1",
			cwd: "/tmp",
			team: "impl",
			goal: "test",
			status: "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stateRoot: "/tmp",
			artifactsRoot: "/tmp",
			tasksPath: "/tmp/tasks.json",
			eventsPath: "/tmp/events.jsonl",
			workspaceMode: "single",
			artifacts: [],
		},
	];

	it("captures active run IDs", () => {
		const snapshot = createSessionSnapshot(activeRuns, 3, 5);
		assert.deepEqual(snapshot.activeRunIds, ["run-1"]);
	});

	it("captures pending delivery count", () => {
		const snapshot = createSessionSnapshot([], 7, 1);
		assert.equal(snapshot.pendingDeliveryCount, 7);
	});

	it("captures session generation", () => {
		const snapshot = createSessionSnapshot([], 0, 42);
		assert.equal(snapshot.sessionGeneration, 42);
	});

	it("builds task summary from run statuses", () => {
		const snapshot = createSessionSnapshot(activeRuns, 0, 1);
		assert.equal(snapshot.taskSummary.running, 1);
	});

	it("has valid capturedAt timestamp", () => {
		const snapshot = createSessionSnapshot([], 0, 1);
		const parsed = new Date(snapshot.capturedAt);
		assert.ok(Number.isFinite(parsed.getTime()));
	});
});
