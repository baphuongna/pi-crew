/**
 * RELIABILITY regression tests — run.lock contention at the scheduler's merge
 * sites must NOT kill the run (2026-10-10 incident, run
 * team_20261010100956_175c23da0a2f988a).
 *
 * Incident chain being pinned here:
 *  1. mergeUnitResult's withRunLock lost a run.lock contention race against a
 *     concurrent writer (the acquire path throws a plain
 *     "Run 'run.lock' is locked by another operation." Error for a LIVE
 *     foreign holder).
 *  2. executeTeamRun's catch converted the throw into a run failure and called
 *     rejectRunPromise — but in background-runner mode NO waitForRun waiter
 *     holds the registered promise, so the rejection was unobserved.
 *  3. Node unhandledRejection → background-runner's guard aborted the whole
 *     runner mid-run → heartbeat stopped → stale-reconciler mass-cancelled 8
 *     tasks.
 *
 * Fixes under test:
 *  - merge-loop.ts / budget-enforcement.ts: merge under withRunLockBusyRetryAsync
 *    (bounded back-off + run.lock_retry event per attempt).
 *  - run-tracker.ts registerRunPromise: a waiter-less rejection is marked
 *    handled (separate test appended to run-tracker.test.ts).
 *
 * The 2-writer fixture uses a REAL run.lock file on disk whose payload names a
 * LIVE foreign pid (a spawned sleeper process) — exactly the "never-steal,
 * throw immediately" acquire path from the incident. No mocking of locks.ts.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MERGE_LOCK_BUSY_RETRY_DELAYS_MS, withRunLockBusyRetryAsync } from "../../../src/runtime/broker/protocol/lock-busy.ts";
import type { CrewRuntimeKind } from "../../../src/runtime/crew-agent-runtime.ts";
import { __test__mergeUnitResult } from "../../../src/runtime/merge-loop.ts";
import type { SchedulerContext } from "../../../src/runtime/scheduler-context.ts";
import { buildTaskGraphIndex } from "../../../src/runtime/scheduling/task-graph-scheduler.ts";
import type { WorkflowStateMachine } from "../../../src/runtime/workflow-state.ts";
import { flushEventLogBuffer, readEvents } from "../../../src/state/event-log/event-log.ts";
import { createRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

// ─── fixtures (mirrors team-runner-extraction.test.ts) ─────────────

const team: TeamConfig = {
	name: "test-team",
	description: "",
	source: "test",
	filePath: "builtin",
	roles: [{ name: "executor", agent: "executor" }],
} as unknown as TeamConfig;

const workflow: WorkflowConfig = {
	name: "implementation",
	description: "",
	source: "test",
	filePath: "builtin",
	steps: [],
} as unknown as WorkflowConfig;

function makeRunFixture(prefix: string): { cwd: string; manifest: TeamRunManifest } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-crew-lockrace-${prefix}-`));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const created = createRunManifest({ cwd, team, workflow, goal: "lock contention regression" });
	return { cwd, manifest: created.manifest };
}

function makeTask(id: string, status: TeamTaskState["status"], runId: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: "step-1",
		role: "executor",
		agent: "executor",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/pi-crew-lockrace",
		graph: {
			taskId: id,
			children: [],
			dependencies: [],
			queue: status === "queued" ? "ready" : status === "running" ? "running" : "done",
		},
	} as unknown as TeamTaskState;
}

type PendingUnitLike = {
	taskIds: string[];
	promise: Promise<{ manifest: TeamRunManifest; tasks: TeamTaskState[] }>;
	wrapped: Promise<{
		unitKey: string;
		result: { manifest: TeamRunManifest; tasks: TeamTaskState[] } | undefined;
		error: Error | undefined;
	}>;
};

function makeSettledUnit(
	unitKey: string,
	taskIds: string[],
	result?: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
): PendingUnitLike {
	const promise = Promise.resolve(result ?? { manifest: {} as TeamRunManifest, tasks: [] });
	return {
		taskIds,
		promise,
		wrapped: Promise.resolve({ unitKey, result, error: undefined }),
	};
}

function makeMergeCtx(manifest: TeamRunManifest, tasks: TeamTaskState[]): SchedulerContext {
	return {
		input: {
			team: { maxConcurrency: undefined } as SchedulerContext["input"]["team"],
			limits: { maxConcurrentWorkers: 2 },
		} as SchedulerContext["input"],
		workflow,
		manifest,
		tasks,
		queueIndex: buildTaskGraphIndex(tasks),
		wfMachine: { phases: [], currentPhaseIndex: 0 } as WorkflowStateMachine,
		pendingUnits: new Map<string, PendingUnitLike>(),
		dispatchedTaskIds: new Set<string>(),
		runController: new AbortController(),
		runtimeKind: "child-process" as CrewRuntimeKind,
		adaptivePlanInjected: false,
		adaptivePlanMissing: false,
		settledMerge: null,
	} as unknown as SchedulerContext;
}

// ─── 2-writer lock fixtures (REAL lock file, live foreign pid) ─────

/** Spawn a live sleeper process to play the "other writer" pid. */
function spawnLiveHolder(): { pid: number; stop: () => void } {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000);"], { stdio: "ignore" });
	return {
		pid: child.pid ?? -1,
		stop: () => {
			try {
				child.kill("SIGKILL");
			} catch {
				/* already exited */
			}
		},
	};
}

/** Forge a run.lock held by a LIVE FOREIGN process (the never-steal,
 *  immediate-throw acquire path — exactly the incident's contention shape). */
function writeForeignRunLock(manifest: TeamRunManifest, pid: number): string {
	const lockPath = path.join(manifest.stateRoot, "run.lock");
	fs.mkdirSync(manifest.stateRoot, { recursive: true });
	fs.writeFileSync(
		lockPath,
		JSON.stringify({
			kind: "run",
			pid,
			createdAt: new Date().toISOString(),
			token: `foreign-live-holder-${pid}-${Date.now()}`,
		}),
	);
	return lockPath;
}

async function readRetryEvents(eventsPath: string): Promise<number> {
	await flushEventLogBuffer();
	const events = readEvents(eventsPath);
	return events.filter((e) => e.type === "run.lock_retry").length;
}

// ─── mergeUnitResult under 2-writer contention ─────────────────────

test("lock-contention: mergeUnitResult survives TRANSIENT run.lock contention (retry + run.lock_retry events)", async () => {
	const { cwd, manifest } = makeRunFixture("transient");
	const holder = spawnLiveHolder();
	try {
		const baseTasks = [makeTask("a", "queued", manifest.runId)];
		saveRunTasks(manifest, baseTasks);
		const workerTasks = [makeTask("a", "completed", manifest.runId)].map((t) => ({
			...t,
			finishedAt: "2026-01-01T00:00:01.000Z",
		}));
		const ctx = makeMergeCtx(manifest, baseTasks);
		ctx.manifest = manifest;
		ctx.tasks = baseTasks;
		ctx.pendingUnits = new Map<string, PendingUnitLike>([["u1", makeSettledUnit("u1", ["a"], { manifest, tasks: workerTasks })]]);

		// Writer #2 holds run.lock now; releases it shortly after the first
		// busy attempts (schedule: 100ms, 250ms, … — release inside attempt 2's
		// back-off so attempt 3 acquires cleanly).
		const lockPath = writeForeignRunLock(manifest, holder.pid);
		setTimeout(() => fs.rmSync(lockPath, { force: true }), 120);

		const decision = await __test__mergeUnitResult(ctx);

		assert.equal(decision, null, "merge path returns null (continue) — run survived the contention");
		assert.equal(ctx.pendingUnits.size, 0, "settled unit still leaves pendingUnits");
		assert.equal(ctx.tasks.find((t) => t.id === "a")?.status, "completed", "worker result merged");
		assert.deepEqual(ctx.settledMerge?.taskIds, ["a"], "settledMerge recorded");
		const retries = await readRetryEvents(manifest.eventsPath);
		assert.ok(retries >= 1, `at least one run.lock_retry event logged (got ${retries})`);
	} finally {
		holder.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("lock-contention: PERSISTENT contention exhausts the bounded schedule and propagates the busy error (classified upstream, never an infinite loop)", async () => {
	const { cwd, manifest } = makeRunFixture("persistent");
	const holder = spawnLiveHolder();
	try {
		const baseTasks = [makeTask("a", "queued", manifest.runId)];
		saveRunTasks(manifest, baseTasks);
		const ctx = makeMergeCtx(manifest, baseTasks);
		ctx.manifest = manifest;
		ctx.tasks = baseTasks;
		ctx.pendingUnits = new Map<string, PendingUnitLike>([
			["u1", makeSettledUnit("u1", ["a"], { manifest, tasks: [makeTask("a", "completed", manifest.runId)] })],
		]);

		// Writer #2 NEVER releases — the retry schedule must stay bounded and
		// rethrow the busy identity so executeTeamRun's catch can classify it
		// (run failure, properly persisted) instead of hanging or swallowing.
		writeForeignRunLock(manifest, holder.pid);

		await assert.rejects(
			() => __test__mergeUnitResult(ctx),
			(error: Error) => /is locked by another operation/.test(error.message),
			"bounded budget exhausted → busy error propagates",
		);
		const retries = await readRetryEvents(manifest.eventsPath);
		assert.equal(retries, MERGE_LOCK_BUSY_RETRY_DELAYS_MS.length, "one run.lock_retry event per retry attempt");
	} finally {
		holder.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ─── withRunLockBusyRetryAsync unit contract (fast schedule) ───────

test("lock-busy retry helper: retries transient holder, succeeds after release, runs fn exactly once", async () => {
	const { cwd, manifest } = makeRunFixture("helper");
	const holder = spawnLiveHolder();
	try {
		const lockPath = writeForeignRunLock(manifest, holder.pid);
		setTimeout(() => fs.rmSync(lockPath, { force: true }), 30);

		let fnRuns = 0;
		const attempts: number[] = [];
		const value = await withRunLockBusyRetryAsync(
			manifest,
			[5, 10, 20],
			async () => {
				fnRuns++;
				return "merged";
			},
			(attempt) => attempts.push(attempt),
		);
		assert.equal(value, "merged");
		assert.equal(fnRuns, 1, "fn runs exactly once (only after the lock is finally acquired)");
		assert.ok(attempts.length >= 1, "onRetry fired for each busy attempt");
		assert.deepEqual(
			attempts,
			attempts.slice().sort((a, b) => a - b),
			"attempt numbers are increasing",
		);
	} finally {
		holder.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("lock-busy retry helper: NON-busy errors propagate immediately (real faults keep the fatal path)", async () => {
	const { cwd, manifest } = makeRunFixture("helper-fatal");
	try {
		let retries = 0;
		await assert.rejects(
			() =>
				withRunLockBusyRetryAsync(
					manifest,
					[5, 5, 5],
					async () => {
						throw new Error("ENOSPC: no space left on device");
					},
					() => retries++,
				),
			/enospc/i,
		);
		assert.equal(retries, 0, "non-busy error must not be retried");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("lock-busy retry helper: exhausted schedule rethrows the busy error (bounded, not swallowed)", async () => {
	const { cwd, manifest } = makeRunFixture("helper-exhaust");
	const holder = spawnLiveHolder();
	try {
		writeForeignRunLock(manifest, holder.pid);
		await assert.rejects(
			() => withRunLockBusyRetryAsync(manifest, [5, 5], async () => "never"),
			(error: Error) => /is locked by another operation/.test(error.message),
		);
	} finally {
		holder.stop();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
