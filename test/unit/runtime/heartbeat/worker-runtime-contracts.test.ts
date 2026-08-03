import assert from "node:assert/strict";
import test from "node:test";
import { createWorkerHeartbeat, isWorkerHeartbeatStale, touchWorkerHeartbeat } from "../../../../src/runtime/heartbeat/worker-heartbeat.ts";
import { claimTask, isTaskClaimExpired, releaseTaskClaim } from "../../../../src/state/coordination/task-claims.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

function task(): TeamTaskState {
	return {
		id: "task_1",
		runId: "run_1",
		role: "executor",
		agent: "executor",
		title: "Task",
		status: "queued",
		dependsOn: [],
		cwd: process.cwd(),
	};
}

test("task claims enforce owner token and expiry", () => {
	const now = new Date("2026-01-01T00:00:00.000Z");
	const claimed = claimTask(task(), "worker-1", 1000, now);
	assert.equal(claimed.claim?.owner, "worker-1");
	assert.equal(isTaskClaimExpired(claimed.claim, new Date("2026-01-01T00:00:00.500Z")), false);
	assert.equal(isTaskClaimExpired(claimed.claim, new Date("2026-01-01T00:00:01.001Z")), true);
	const released = releaseTaskClaim(claimed, "worker-1", claimed.claim?.token ?? "", now);
	assert.equal(released.claim, undefined);
});

test("worker heartbeat reports stale workers", () => {
	const heartbeat = createWorkerHeartbeat("worker-1", 123, new Date("2026-01-01T00:00:00.000Z"));
	const touched = touchWorkerHeartbeat(heartbeat, { turnCount: 1 }, new Date("2026-01-01T00:00:05.000Z"));
	assert.equal(touched.turnCount, 1);
	assert.equal(isWorkerHeartbeatStale(touched, 1000, new Date("2026-01-01T00:00:07.000Z")), true);
});
