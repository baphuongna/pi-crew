/**
 * U9 (upgrade-spec 2026-10-09) — reconcile-at-open FAST-PATH tests.
 *
 * Spec: when a run is opened after a crash and there is NO live claim
 * (dead detached async runner PID + no live active-run-registry entry), ONE
 * pass under the run lock requeues every `running` task → `queued` (attempt /
 * deps / partial state preserved) and marks the run failed-for-resume; the
 * full stale-reconciler verdict tree (healthy / waiting_answer / pid_dead /
 * ...) only remains for runs WITH a live claim. G12 (never resume/touch a
 * live run) is preserved by construction.
 *
 * Covered here:
 *   A. no-live-claim → running→queued, attempt/checkpoint/deps preserved,
 *      run marked failed, crew.run.resumed (fastPath) event appended
 *   B. idempotency — a second reconcile pass changes nothing (one-shot via
 *      the terminal status; the pure helper returns undefined with no
 *      `running` tasks left)
 *   C. live claim (alive async PID) → verdict tree as before: nothing
 *      repaired, tasks untouched, run stays running
 *   D. detectInterruptedRuns fast-path DETECTION — a just-crashed run
 *      (fresh heartbeat) is immediately actionable instead of waiting out
 *      the 300s deadMs heartbeat-staleness window (recovery-time metric)
 *   E. intentional wait (fresh ask park) is preserved — verdict tree, not
 *      the fast path
 *   F. no async PID (foreground/live-session run) never takes the fast path
 *      (its liveness evidence is the registry + heartbeat staleness, weighed
 *      by the verdict tree as before)
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import {
	applyReconcileAtOpenFastPath,
	detectInterruptedRuns,
	reconcileAllStaleRuns,
	shouldRecoverTask,
} from "../../../../src/runtime/recovery/crash-recovery.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "u9",
	description: "u9",
	source: "builtin",
	filePath: "u9.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};
const workflow: WorkflowConfig = {
	name: "u9",
	description: "u9",
	source: "builtin",
	filePath: "u9.workflow.md",
	steps: [
		{ id: "one", role: "executor", task: "One" },
		{ id: "two", role: "executor", task: "Two" },
	],
};

/** Sandbox the global active-run registry so ambient entries cannot leak in. */
function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-u9-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** Spawn then kill+reap a child, returning a PID that is genuinely dead. */
async function reapDeadPid(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore" });
	const pid = child.pid ?? -1;
	try {
		child.kill("SIGKILL");
	} catch {
		/* already gone */
	}
	await new Promise<void>((resolve) => {
		child.once("exit", () => resolve());
		setTimeout(resolve, 2000);
	});
	return pid;
}

/** A long-lived child whose PID stays alive for the live-claim test. */
class AliveWorker {
	readonly pid: number;
	private readonly child: ChildProcess;
	constructor() {
		this.child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore" });
		this.pid = this.child.pid ?? -1;
	}
	stop(): void {
		try {
			this.child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
	}
}

function makeStubCache(manifests: TeamRunManifest[]): ManifestCache {
	const byId = new Map(manifests.map((m) => [m.runId, m]));
	return {
		list: () => manifests,
		listActive: (limit: number) => manifests.filter((m) => m.status === "running").slice(0, limit),
		get: (runId: string) => byId.get(runId),
		clear: () => {
			/* no-op */
		},
		dispose: () => {
			/* no-op */
		},
	};
}

interface FixtureOpts {
	asyncPid?: number;
	waitState?: TeamRunManifest["waitState"];
	heartbeatLastSeenAt?: string;
}

/** Create + persist a running run with two tasks: one running, one completed. */
function setupCrashedRun(cwd: string, opts: FixtureOpts = {}): { manifest: TeamRunManifest; tasks: TeamTaskState[] } {
	const t0 = Date.now();
	const created = createRunManifest({ cwd, team, workflow, goal: "u9 fast-path fixture" });
	const manifest: TeamRunManifest = {
		...created.manifest,
		status: "running",
		updatedAt: new Date(t0).toISOString(),
		...(opts.asyncPid !== undefined
			? { async: { pid: opts.asyncPid, logPath: "", spawnedAt: new Date(t0).toISOString() } }
			: { async: undefined }),
		...(opts.waitState ? { waitState: opts.waitState } : {}),
	};
	saveRunManifest(manifest);
	const runningTask: TeamTaskState = {
		...created.tasks[0],
		status: "running",
		startedAt: new Date(t0 - 5000).toISOString(),
		// FRESH heartbeat — the crash just happened; the worker had not gone
		// stale yet. The dead runner PID is the only (authoritative) evidence.
		heartbeat: {
			workerId: "w1",
			pid: opts.asyncPid,
			lastSeenAt: opts.heartbeatLastSeenAt ?? new Date(t0).toISOString(),
			alive: true,
		},
		// Partial state that MUST survive the fast-path requeue.
		attempts: [{ attemptId: "att-1", startedAt: new Date(t0 - 5000).toISOString(), error: "first try died" }],
		checkpoint: { phase: "child-spawned", updatedAt: new Date(t0 - 1000).toISOString(), childPid: opts.asyncPid },
	};
	const completedTask: TeamTaskState = {
		...created.tasks[1],
		status: "completed",
		startedAt: new Date(t0 - 60_000).toISOString(),
		finishedAt: new Date(t0 - 30_000).toISOString(),
	};
	const tasks = [runningTask, completedTask];
	// The running task depends on nothing, the completed one is its dep mirror —
	// pin dependsOn preservation explicitly.
	runningTask.dependsOn = [];
	saveRunTasks(manifest, tasks);
	return { manifest, tasks };
}

// ─── A: no live claim → running→queued, attempt/partial state preserved ─────

test("U9 fast-path: no live claim requeues running→queued with attempt/partial state preserved and marks run failed", async () => {
	await withIsolatedHome(async () => {
		const dir = createTrackedTempDir("pi-crew-u9-fire-");
		try {
			const deadPid = await reapDeadPid();
			const { manifest, tasks } = setupCrashedRun(dir, { asyncPid: deadPid });

			const startedAt = Date.now();
			const results = await reconcileAllStaleRuns(dir, makeStubCache([manifest]), Date.now());
			const elapsedMs = Date.now() - startedAt;
			console.log(`[U9-metric] fast-path apply pass (1 run, 2 tasks): ${elapsedMs} ms`);

			const mine = results.filter((r) => r.runId === manifest.runId);
			assert.equal(mine.length, 1, "fast-path must report exactly one result");
			assert.equal(mine[0].verdict, "requeued_no_claim");
			assert.equal(mine[0].repaired, true);

			const reloaded = loadRunManifestById(dir, manifest.runId)!;
			assert.equal(reloaded.manifest.status, "failed", "run is marked failed (failed-for-resume, shields later passes)");

			const requeued = reloaded.tasks.find((t) => t.id === tasks[0].id)!;
			assert.equal(requeued.status, "queued", "interrupted running task must be requeued, not cancelled");
			assert.equal(requeued.startedAt, undefined, "per-attempt transient startedAt cleared");
			assert.equal(requeued.heartbeat, undefined, "stale heartbeat cleared");
			assert.deepEqual(requeued.attempts, tasks[0].attempts, "attempt history preserved (byte-identical to the fixture)");
			assert.deepEqual(requeued.checkpoint, tasks[0].checkpoint, "checkpoint (partial state) preserved");
			assert.deepEqual(requeued.dependsOn, [], "deps preserved");
			assert.equal(requeued.waiting, undefined, "no parked wait state on a requeued task");

			const completed = reloaded.tasks.find((t) => t.id === tasks[1].id)!;
			assert.equal(completed.status, "completed", "terminal task untouched");

			const events = readEvents(reloaded.manifest.eventsPath);
			assert.ok(
				events.some((e) => e.type === "run.failed"),
				"run.failed recorded",
			);
			const fastPathEvents = events.filter(
				(e) => e.type === "crew.run.resumed" && (e.data as { fastPath?: boolean })?.fastPath === true,
			);
			assert.equal(fastPathEvents.length, 1, "exactly one fast-path crew.run.resumed event");
			assert.ok(
				(events.find((e) => e.type === "crew.run.resumed")?.data as { requeuedTasks?: string[] })?.requeuedTasks?.includes(
					tasks[0].id,
				),
				"event lists the requeued task id",
			);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── B: idempotency — second pass is a no-op ────────────────────────────────

test("U9 fast-path: idempotent — second reconcile pass changes nothing and appends no duplicate event", async () => {
	await withIsolatedHome(async () => {
		const dir = createTrackedTempDir("pi-crew-u9-idem-");
		try {
			const deadPid = await reapDeadPid();
			const { manifest, tasks } = setupCrashedRun(dir, { asyncPid: deadPid });
			const cache = makeStubCache([manifest]); // deliberately stale: still lists "running"

			await reconcileAllStaleRuns(dir, cache, Date.now());
			const afterFirst = loadRunManifestById(dir, manifest.runId)!;

			// Pure-helper idempotency: no `running` task left → fast path declines.
			assert.equal(applyReconcileAtOpenFastPath(afterFirst), undefined, "helper returns undefined with no running tasks");

			const results2 = await reconcileAllStaleRuns(dir, cache, Date.now());
			assert.deepEqual(
				results2.filter((r) => r.runId === manifest.runId),
				[],
				"terminal (failed) run is not revisited",
			);

			const afterSecond = loadRunManifestById(dir, manifest.runId)!;
			assert.equal(afterSecond.manifest.status, "failed");
			const requeued = afterSecond.tasks.find((t) => t.id === tasks[0].id)!;
			assert.equal(requeued.status, "queued", "task stays queued — no double repair");
			assert.deepEqual(requeued.attempts, afterFirst.tasks.find((t) => t.id === tasks[0].id)!.attempts, "attempt state stable");

			const events = readEvents(afterSecond.manifest.eventsPath);
			const fastPathEvents = events.filter(
				(e) => e.type === "crew.run.resumed" && (e.data as { fastPath?: boolean })?.fastPath === true,
			);
			assert.equal(fastPathEvents.length, 1, "still exactly one fast-path event after the second pass");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── C: live claim → verdict tree as before, nothing touched ────────────────

test("U9 fast-path: live claim (alive async PID) keeps verdict-tree semantics — run untouched", async () => {
	await withIsolatedHome(async () => {
		const dir = createTrackedTempDir("pi-crew-u9-live-");
		const worker = new AliveWorker();
		try {
			const { manifest, tasks } = setupCrashedRun(dir, { asyncPid: worker.pid });

			const results = await reconcileAllStaleRuns(dir, makeStubCache([manifest]), Date.now());

			assert.equal(
				results.filter((r) => r.runId === manifest.runId && r.repaired).length,
				0,
				"a live-claimed run must NOT be repaired by the fast path or the verdict tree",
			);

			const reloaded = loadRunManifestById(dir, manifest.runId)!;
			assert.equal(reloaded.manifest.status, "running", "live run keeps running status");
			const runningTask = reloaded.tasks.find((t) => t.id === tasks[0].id)!;
			assert.equal(runningTask.status, "running", "live run's task untouched (G12)");
			assert.ok(runningTask.heartbeat, "heartbeat untouched");
		} finally {
			worker.stop();
			removeTrackedTempDir(dir);
		}
	});
});

// ─── D: detectInterruptedRuns fast-path DETECTION (recovery-time metric) ────

test("U9 fast-path detection: just-crashed run (fresh heartbeat) is immediately actionable — no 300s deadMs wait", async () => {
	await withIsolatedHome(async () => {
		const dir = createTrackedTempDir("pi-crew-u9-detect-");
		try {
			const deadPid = await reapDeadPid();
			const { manifest, tasks } = setupCrashedRun(dir, { asyncPid: deadPid });

			// BASELINE (pre-U9 semantics): shouldRecoverTask gates on heartbeat
			// staleness — a fresh heartbeat is not recoverable until deadMs elapses.
			assert.equal(shouldRecoverTask(tasks[0], 300_000), false, "baseline predicate requires the 300s heartbeat-staleness window");

			const startedAt = Date.now();
			const plans = detectInterruptedRuns(dir, makeStubCache([manifest]), 300_000);
			const elapsedMs = Date.now() - startedAt;

			assert.equal(plans.length, 1, "fast path detects the dead-runner crash immediately");
			assert.equal(plans[0].runId, manifest.runId);
			assert.ok(plans[0].resumableTasks.includes(tasks[0].id), "the running task is resumable at heartbeat age ~0s");
			assert.ok(plans[0].lastEventSeq >= 0, "plan carries the events anchor seq");

			console.log(
				`[U9-metric] detection latency — baseline (heartbeat-staleness gate): 300000 ms (by construction, ` +
					`shouldRecoverTask=false at fresh heartbeat) vs U9 fast-path: ${elapsedMs} ms (elapsed for the detecting call)`,
			);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── E: intentional ask-wait preserved (verdict tree, not fast path) ────────

test("U9 fast-path: fresh ask-park (waitState) is preserved — verdict tree waiting_answer, tasks untouched", async () => {
	await withIsolatedHome(async () => {
		const dir = createTrackedTempDir("pi-crew-u9-wait-");
		try {
			const deadPid = await reapDeadPid();
			const { manifest, tasks } = setupCrashedRun(dir, {
				asyncPid: deadPid,
				waitState: { taskId: "t-ask", questionId: "q-1", askedAt: new Date().toISOString() },
			});

			const results = await reconcileAllStaleRuns(dir, makeStubCache([manifest]), Date.now());
			assert.ok(
				!results.some((r) => r.runId === manifest.runId && r.verdict === "requeued_no_claim"),
				"intentional wait must not take the fast path",
			);

			const reloaded = loadRunManifestById(dir, manifest.runId)!;
			assert.equal(reloaded.manifest.status, "running", "parked run stays running (preserved)");
			const runningTask = reloaded.tasks.find((t) => t.id === tasks[0].id)!;
			assert.equal(runningTask.status, "running", "parked run's tasks untouched");

			assert.deepEqual(
				detectInterruptedRuns(dir, makeStubCache([manifest]), 300_000),
				[],
				"no recovery plan offered for a parked run",
			);
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});

// ─── F: no async PID → fast path does not apply (verdict tree weighs it) ────

test("U9 fast-path: no async PID (foreground run) never takes the fast path", async () => {
	await withIsolatedHome(async () => {
		const dir = createTrackedTempDir("pi-crew-u9-nopid-");
		try {
			const { manifest, tasks } = setupCrashedRun(dir, {}); // async: undefined

			const results = await reconcileAllStaleRuns(dir, makeStubCache([manifest]), Date.now());
			assert.ok(
				!results.some((r) => r.runId === manifest.runId && r.verdict === "requeued_no_claim"),
				"no-PID run must defer to the verdict tree",
			);

			const reloaded = loadRunManifestById(dir, manifest.runId)!;
			assert.equal(reloaded.manifest.status, "running", "fresh-heartbeat no-PID run is not repaired (existing semantics)");
			const runningTask = reloaded.tasks.find((t) => t.id === tasks[0].id)!;
			assert.equal(runningTask.status, "running", "task untouched");
		} finally {
			removeTrackedTempDir(dir);
		}
	});
});
