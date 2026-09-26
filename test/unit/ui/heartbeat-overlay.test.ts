import assert from "node:assert/strict";
import test from "node:test";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import { overlayFreshTaskStatuses, summarizeHeartbeats } from "../../../src/ui/heartbeat-aggregator.ts";
import type { RunUiSnapshot } from "../../../src/ui/snapshot-types.ts";

/**
 * FINDING 5 regression (2026-09-23 battery, live: team_20260923100114):
 * a worker parked on `ask` transitions running → waiting on DISK while the
 * cached snapshot can still show `running`. Health ticks must count the DISK
 * status — the parked worker must NOT be reported dead/missing.
 */

const manifest: TeamRunManifest = {
	runId: "run_f5",
	team: "t",
	workflow: "w",
	goal: "g",
	status: "running",
	cwd: "/tmp/x",
	stateRoot: "/tmp/x/.crew/state/runs/run_f5",
	artifactsRoot: "/tmp/x/.crew/artifacts/run_f5",
	tasksPath: "/tmp/x/.crew/state/runs/run_f5/tasks.json",
	eventsPath: "/tmp/x/.crew/state/runs/run_f5/events.jsonl",
	createdAt: new Date().toISOString(),
	updatedAt: new Date().toISOString(),
} as unknown as TeamRunManifest;

function snapshotOf(tasks: TeamTaskState[]): RunUiSnapshot {
	return {
		runId: "run_f5",
		manifest,
		tasks,
	} as unknown as RunUiSnapshot;
}

const runningNoHeartbeat: TeamTaskState = {
	id: "01_explore",
	status: "running",
} as unknown as TeamTaskState;

const waitingOnDisk: TeamTaskState = {
	id: "01_explore",
	status: "waiting",
} as unknown as TeamTaskState;

test("F5: overlay skips disk-waiting task — parked-on-ask worker is NOT dead", () => {
	const snapshot = snapshotOf([runningNoHeartbeat]);
	// Cached snapshot says running (no heartbeat) — the OLD false-positive path.
	const before = summarizeHeartbeats(snapshot, { now: Date.now() });
	assert.equal(before.missing, 1, "precondition: cached view counts the worker missing");

	const overlaid = overlayFreshTaskStatuses(snapshot, [waitingOnDisk]);
	const after = summarizeHeartbeats(overlaid, { now: Date.now() });
	assert.equal(after.missing, 0, "parked (waiting) worker must not count as missing heartbeat");
	assert.equal(after.dead, 0);
});

test("F5: overlay returns the ORIGINAL object when disk agrees with cache", () => {
	const snapshot = snapshotOf([runningNoHeartbeat]);
	const same = overlayFreshTaskStatuses(snapshot, [runningNoHeartbeat]);
	assert.equal(same, snapshot, "identity preserved — no needless cache invalidation");
});

test("F5: overlay with empty fresh list is a no-op", () => {
	const snapshot = snapshotOf([runningNoHeartbeat]);
	assert.equal(overlayFreshTaskStatuses(snapshot, []), snapshot);
});

test("F5: status divergence produces a NEW object (cache-invalidation signal)", () => {
	const snapshot = snapshotOf([runningNoHeartbeat]);
	const overlaid = overlayFreshTaskStatuses(snapshot, [waitingOnDisk]);
	assert.notEqual(overlaid, snapshot, "divergence must yield a new object");
	assert.equal(overlaid.tasks[0]?.status, "waiting");
	// The cached snapshot object itself is never mutated.
	assert.equal(snapshot.tasks[0]?.status, "running");
});

test("F5: genuinely-running worker without heartbeat still fires", () => {
	// The overlay must not blanket-suppress: a task that IS running on disk
	// with no heartbeat is still a real missing-heartbeat case.
	const snapshot = snapshotOf([runningNoHeartbeat]);
	const overlaid = overlayFreshTaskStatuses(snapshot, [runningNoHeartbeat]);
	const after = summarizeHeartbeats(overlaid, { now: Date.now() });
	assert.equal(after.missing, 1, "real missing heartbeat still detected");
});

/**
 * 2026-09-26 battery follow-up (live: team_20260926033657_2b6c6d2610b26d9d):
 * guest-child tasks (agent="delegate") never write task.heartbeat — while the
 * parent run is live, summarizeHeartbeats counted every guest as a "missing
 * heartbeat" worker and fired the "N worker(s) missing heartbeat" ambient.
 */
const guestNoHeartbeat: TeamTaskState = {
	id: "gc-c7006dc3-probe",
	status: "running",
	agent: "delegate",
	depth: 2,
	title: "delegate: probe",
} as unknown as TeamTaskState;

test("guest child (agent=delegate) is NOT counted as missing heartbeat", () => {
	const snapshot = snapshotOf([guestNoHeartbeat]);
	const summary = summarizeHeartbeats(snapshot, { now: Date.now() });
	assert.equal(summary.missing, 0, "guest task has no heartbeat channel by design");
	assert.equal(summary.dead, 0);
	assert.equal(summary.gradient.dead, 0);
});

test("guest skip does NOT hide a genuinely missing real worker", () => {
	const snapshot = snapshotOf([runningNoHeartbeat, guestNoHeartbeat]);
	const summary = summarizeHeartbeats(snapshot, { now: Date.now() });
	assert.equal(summary.missing, 1, "the real worker still counts");
	assert.equal(summary.totalTasks, 2);
});
