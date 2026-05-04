import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reconcileStaleRun } from "../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

const baseManifest: TeamRunManifest = {
	schemaVersion: 1,
	runId: "run-stale-1",
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
};

const runningTask: TeamTaskState = {
	id: "task-1",
	runId: "run-stale-1",
	role: "executor",
	agent: "test-agent",
	title: "Test task",
	status: "running",
	dependsOn: [],
	cwd: "/tmp",
};

const completedTask: TeamTaskState = {
	...runningTask,
	status: "completed",
	finishedAt: new Date().toISOString(),
};

describe("reconcileStaleRun", () => {
	it("returns result_exists when all tasks are terminal", () => {
		const result = reconcileStaleRun(baseManifest, [completedTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(result.repaired, false);
	});

	it("returns healthy for recent non-async run", () => {
		const result = reconcileStaleRun(baseManifest, [runningTask], Date.now());
		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, false);
	});

	it("preserves stale non-async run when fresh heartbeat exists", () => {
		const now = Date.now();
		const staleTime = now - 25 * 60 * 60 * 1000;
		const manifest = {
			...baseManifest,
			updatedAt: new Date(staleTime).toISOString(),
		};
		const task = { ...runningTask, heartbeat: { workerId: "task-1", lastSeenAt: new Date(now - 1000).toISOString(), alive: true } };
		const result = reconcileStaleRun(manifest, [task], now);
		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, false);
	});

	it("repairs stale non-async run (>24h old)", () => {
		const staleTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
		const manifest = {
			...baseManifest,
			updatedAt: new Date(staleTime).toISOString(),
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, true);
	});

	it("returns healthy for alive PID with recent update", () => {
		const manifest = {
			...baseManifest,
			async: { pid: process.pid, logPath: "/tmp/log", spawnedAt: new Date().toISOString() },
		};
		// Use current process PID — it's alive
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "healthy");
		assert.equal(result.repaired, false);
	});

	it("repairs dead PID", () => {
		const manifest = {
			...baseManifest,
			async: { pid: 99999123, logPath: "/tmp/log", spawnedAt: new Date().toISOString() },
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		// PID 99999123 doesn't exist, so it's dead
		assert.equal(result.verdict, "pid_dead");
		assert.equal(result.repaired, true);
	});

	it("returns healthy for alive PID with recent updatedAt even with running tasks", () => {
		const manifest = {
			...baseManifest,
			async: { pid: process.pid, logPath: "/tmp/log", spawnedAt: new Date().toISOString() },
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "healthy");
	});

	it("repairs alive but stale PID (>24h since update)", () => {
		const staleTime = Date.now() - 25 * 60 * 60 * 1000;
		const manifest = {
			...baseManifest,
			updatedAt: new Date(staleTime).toISOString(),
			async: { pid: process.pid, logPath: "/tmp/log", spawnedAt: new Date().toISOString() },
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "pid_alive_stale");
		assert.equal(result.repaired, true);
	});
});
