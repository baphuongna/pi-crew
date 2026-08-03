import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	checkProcessLiveness,
	hasStaleAsyncProcess,
	isActiveRunStatus,
	isDisplayActiveRun,
	isFinishedRunStatus,
	isLikelyOrphanedActiveRun,
} from "../../../../src/runtime/process-status.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

function makeManifest(overrides: Partial<TeamRunManifest> = {}): TeamRunManifest {
	return {
		schemaVersion: 1,
		runId: "run-test",
		team: "test",
		goal: "test goal",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: "/tmp",
		stateRoot: "/tmp/state",
		artifactsRoot: "/tmp/artifacts",
		tasksPath: "/tmp/tasks",
		eventsPath: "/tmp/events",
		artifacts: [],
		...overrides,
	};
}

describe("checkProcessLiveness", () => {
	it("returns not alive for undefined pid", () => {
		const result = checkProcessLiveness(undefined);
		assert.equal(result.alive, false);
		assert.equal(result.pid, undefined);
		assert.equal(result.detail, "no pid recorded");
	});

	it("returns not alive for non-integer pid", () => {
		assert.equal(checkProcessLiveness(1.5).alive, false);
		assert.equal(checkProcessLiveness(-1).alive, false);
	});

	it("returns alive for current process pid", () => {
		const result = checkProcessLiveness(process.pid);
		assert.equal(result.alive, true);
		assert.equal(result.pid, process.pid);
	});

	it("returns not alive for non-existent pid", () => {
		// Use a very high PID that almost certainly doesn't exist
		const result = checkProcessLiveness(4000000);
		assert.equal(result.alive, false);
		assert.ok(result.detail.includes("does not exist") || result.detail.length > 0);
	});
});

describe("isActiveRunStatus", () => {
	it("returns true for active statuses", () => {
		assert.equal(isActiveRunStatus("queued"), true);
		assert.equal(isActiveRunStatus("planning"), true);
		assert.equal(isActiveRunStatus("running"), true);
		assert.equal(isActiveRunStatus("waiting"), true);
	});

	it("returns false for terminal statuses", () => {
		assert.equal(isActiveRunStatus("completed"), false);
		assert.equal(isActiveRunStatus("failed"), false);
		assert.equal(isActiveRunStatus("cancelled"), false);
		assert.equal(isActiveRunStatus("blocked"), false);
	});
});

describe("isFinishedRunStatus", () => {
	it("returns true for finished statuses", () => {
		assert.equal(isFinishedRunStatus("completed"), true);
		assert.equal(isFinishedRunStatus("failed"), true);
		assert.equal(isFinishedRunStatus("cancelled"), true);
		assert.equal(isFinishedRunStatus("blocked"), true);
	});

	it("returns false for active statuses", () => {
		assert.equal(isFinishedRunStatus("running"), false);
		assert.equal(isFinishedRunStatus("queued"), false);
	});
});

describe("isLikelyOrphanedActiveRun", () => {
	it("returns false for non-active status", () => {
		const run = makeManifest({ status: "completed" });
		assert.equal(isLikelyOrphanedActiveRun(run, []), false);
	});

	it("returns false for async runs (they have PID tracking)", () => {
		const run = makeManifest({
			status: "running",
			async: {
				pid: 123,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		});
		assert.equal(isLikelyOrphanedActiveRun(run, []), false);
	});

	it("returns true when run is stale with specific summary and no agents", () => {
		const now = Date.now();
		const stale = new Date(now - 3 * 60 * 1000).toISOString(); // 3 min ago
		const run = makeManifest({
			status: "running",
			updatedAt: stale,
			summary: "Creating workflow prompts and placeholder results.",
		});
		assert.equal(isLikelyOrphanedActiveRun(run, [], now, 2 * 60 * 1000), true);
	});

	it("returns false when stale but summary does not match", () => {
		const now = Date.now();
		const stale = new Date(now - 3 * 60 * 1000).toISOString();
		const run = makeManifest({
			status: "running",
			updatedAt: stale,
			summary: "Some other summary",
		});
		assert.equal(isLikelyOrphanedActiveRun(run, [], now, 2 * 60 * 1000), false);
	});

	it("returns false when run is fresh", () => {
		const run = makeManifest({ status: "running" });
		assert.equal(isLikelyOrphanedActiveRun(run, [], Date.now(), 2 * 60 * 1000), false);
	});

	it("returns true when agents are all queued with no progress for a long time", () => {
		const now = Date.now();
		const updatedAt = new Date(now - 6 * 60 * 1000).toISOString();
		const run = makeManifest({ status: "running", updatedAt });
		const agents = [
			{
				id: "a1",
				status: "queued" as const,
				runId: "r",
				taskId: "t",
				agent: "x",
				role: "r",
				runtime: "scaffold" as const,
				startedAt: updatedAt,
			},
		];
		assert.equal(isLikelyOrphanedActiveRun(run, agents, now, 2 * 60 * 1000), true);
	});
});

describe("hasStaleAsyncProcess", () => {
	it("returns false for non-active status", () => {
		const run = makeManifest({ status: "completed" });
		assert.equal(hasStaleAsyncProcess(run), false);
	});

	it("returns true when async process PID is dead", () => {
		const run = makeManifest({
			status: "running",
			async: {
				pid: 4000000,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		});
		assert.equal(hasStaleAsyncProcess(run), true);
	});

	it("returns false when async process is alive and fresh", () => {
		const run = makeManifest({
			status: "running",
			async: {
				pid: process.pid,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		});
		assert.equal(hasStaleAsyncProcess(run), false);
	});

	it("returns true when process alive but run is very stale", () => {
		const now = Date.now();
		const stale = new Date(now - 31 * 60 * 1000).toISOString();
		const run = makeManifest({
			status: "running",
			updatedAt: stale,
			async: { pid: process.pid, logPath: "/tmp/log", spawnedAt: stale },
		});
		assert.equal(hasStaleAsyncProcess(run, now), true);
	});
});

describe("isDisplayActiveRun", () => {
	it("returns false for stale async process", () => {
		const now = Date.now();
		const stale = new Date(now - 31 * 60 * 1000).toISOString();
		const run = makeManifest({
			status: "running",
			updatedAt: stale,
			async: { pid: 4000000, logPath: "/tmp/log", spawnedAt: stale },
		});
		assert.equal(isDisplayActiveRun(run, [], now), false);
	});

	it("returns false for orphaned active run", () => {
		const now = Date.now();
		const stale = new Date(now - 3 * 60 * 1000).toISOString();
		const run = makeManifest({ status: "running", updatedAt: stale });
		assert.equal(isDisplayActiveRun(run, [], now), false);
	});

	it("returns false for non-active status beyond grace period", () => {
		const run = makeManifest({ status: "completed" });
		assert.equal(isDisplayActiveRun(run, [], Date.now() + 10000), false);
	});

	it("returns true for completed run within grace period", () => {
		const now = Date.now();
		const run = makeManifest({
			status: "completed",
			updatedAt: new Date(now).toISOString(),
		});
		// Need an agent with completedAt within grace
		const agents = [
			{
				id: "a1",
				status: "completed" as const,
				runId: "r",
				taskId: "t",
				agent: "x",
				role: "r",
				runtime: "scaffold" as const,
				startedAt: new Date(now - 1000).toISOString(),
				completedAt: new Date(now - 1000).toISOString(),
			},
		];
		assert.equal(isDisplayActiveRun(run, agents, now), true);
	});

	it("returns false when no agents exist for active run", () => {
		const run = makeManifest({ status: "running" });
		assert.equal(isDisplayActiveRun(run, [], Date.now()), false);
	});

	it("returns true when a running agent exists", () => {
		const run = makeManifest({ status: "running" });
		const agents = [
			{
				id: "a1",
				status: "running" as const,
				runId: "r",
				taskId: "t",
				agent: "x",
				role: "r",
				runtime: "scaffold" as const,
				startedAt: new Date().toISOString(),
			},
		];
		assert.equal(isDisplayActiveRun(run, agents, Date.now()), true);
	});
});
