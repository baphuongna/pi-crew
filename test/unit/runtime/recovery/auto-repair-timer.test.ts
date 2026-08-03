import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcileStaleRun } from "../../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

const baseManifest: TeamRunManifest = {
	schemaVersion: 1,
	runId: "run-auto-repair-1",
	cwd: "/tmp",
	team: "fast-fix",
	goal: "auto-repair test",
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
	id: "01_explore",
	runId: "run-auto-repair-1",
	role: "explorer",
	agent: "explorer",
	title: "explore",
	status: "running",
	dependsOn: [],
	cwd: "/tmp",
};

describe("auto-repair: reconcileStaleRun handles zombie tasks", () => {
	it("repairs task with dead PID (worker process exited)", () => {
		// Simulate the exact scenario: agent process exited without calling submit_result
		// PID 99999123 does not exist → pid_dead → immediate repair
		const manifest: TeamRunManifest = {
			...baseManifest,
			async: {
				pid: 99999123,
				logPath: "/tmp/bg.log",
				spawnedAt: new Date().toISOString(),
			},
		};
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const task: TeamTaskState = {
			...runningTask,
			heartbeat: {
				workerId: "01_explore",
				lastSeenAt: tenMinutesAgo,
				alive: true,
			},
		};

		const result = reconcileStaleRun(manifest, [task], Date.now());

		assert.equal(result.verdict, "pid_dead");
		assert.equal(result.repaired, true);
		assert.ok(result.repairedTasks);
		assert.equal(result.repairedTasks[0].status, "cancelled");
		assert.match(result.repairedTasks[0].error ?? "", /pid_dead/);
	});

	it("does NOT repair task with alive PID and recent heartbeat", () => {
		// Current process PID is alive
		const manifest: TeamRunManifest = {
			...baseManifest,
			async: {
				pid: process.pid,
				logPath: "/tmp/bg.log",
				spawnedAt: new Date().toISOString(),
			},
		};

		const result = reconcileStaleRun(manifest, [runningTask], Date.now());

		assert.equal(result.verdict, "healthy");
		assert.equal(result.repaired, false);
	});

	it("repairs stale non-async run with no recent heartbeat evidence (>24h)", () => {
		// No PID recorded (foreground/live-session) + heartbeat dead for >24h
		const staleTime = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
		const manifest: TeamRunManifest = {
			...baseManifest,
			updatedAt: new Date(staleTime).toISOString(),
		};

		const result = reconcileStaleRun(manifest, [runningTask], Date.now());

		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, true);
		assert.ok(result.repairedTasks);
		assert.equal(result.repairedTasks[0].status, "cancelled");
	});

	it("preserves non-async run when heartbeat is recent (<5min)", () => {
		// No PID, but task has recent heartbeat → not stale enough to repair
		const staleTime = Date.now() - 30 * 60 * 1000; // 30 min ago manifest
		const now = Date.now();
		const manifest: TeamRunManifest = {
			...baseManifest,
			updatedAt: new Date(staleTime).toISOString(),
		};
		const task: TeamTaskState = {
			...runningTask,
			heartbeat: {
				workerId: "01_explore",
				lastSeenAt: new Date(now - 60 * 1000).toISOString(),
				alive: true,
			},
		};

		const result = reconcileStaleRun(manifest, [task], now);

		// hasRecentActiveEvidence returns true because heartbeat < 5min old
		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, false);
	});

	it("does not repair when all tasks already terminal", () => {
		const completedTask: TeamTaskState = {
			...runningTask,
			status: "completed",
			finishedAt: new Date().toISOString(),
		};

		const result = reconcileStaleRun(baseManifest, [completedTask], Date.now());

		assert.equal(result.verdict, "result_exists");
		assert.equal(result.repaired, false);
	});
});
