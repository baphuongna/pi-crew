/**
 * CHARACTERIZATION TESTS for crash-recovery cleanup functions.
 *
 * These tests capture the CURRENT behavior of `reconcileAllStaleRuns`,
 * `purgeStaleActiveRunIndex`, and `detectInterruptedRuns` BEFORE the
 * cross-session-leak fix adds an optional `currentSessionId?` parameter.
 *
 * KEY INVARIANT under test: a genuinely dead session's run (owner PID dead +
 * stale heartbeat + stale manifest.updatedAt) MUST still be cleaned up /
 * cancelled / purged. When `currentSessionId === undefined` (the back-compat
 * default), this behavior is preserved exactly.
 *
 * These tests intentionally call the functions with their CURRENT signatures
 * (no `currentSessionId`). After the fix adds the param, these tests must
 * STILL PASS because `currentSessionId === undefined` disables all session
 * filtering.
 *
 * Reference patterns:
 *   - crash-recovery-purge-liveness.test.ts (alive-then-reaped PID setup,
 *     isolated HOME, registerActiveRun, saveRunManifest)
 *   - crash-recovery-cov.test.ts (stub-cache detectInterruptedRuns testing)
 *   - crash-recovery-quarantine.test.ts (manifest corruption + stateRoot
 *     preservation)
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	detectInterruptedRuns,
	purgeStaleActiveRunIndex,
	reconcileAllStaleRuns,
} from "../../../../src/runtime/recovery/crash-recovery.ts";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { registerActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import {
	createRunManifest,
	loadRunManifestById,
	saveRunManifest,
	saveRunTasks,
} from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Shared fixtures ────────────────────────────────────────────────────────

const team: TeamConfig = {
	name: "char",
	description: "char",
	source: "builtin",
	filePath: "char.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "char",
	description: "char",
	source: "builtin",
	filePath: "char.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

const STALE = 5 * 60 * 1000; // 5 min, matching purgeStaleActiveRunIndex default

/** Isolate PI_TEAMS_HOME so the global active-run registry is sandboxed. */
async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** A long-lived child whose PID is alive for registration, then reaped dead. */
class AliveWorker {
	readonly pid: number;
	private readonly child: ChildProcess;
	constructor() {
		this.child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore" });
		this.pid = this.child.pid ?? -1;
	}
	/** Kill + fully reap so the PID is genuinely dead (ESRCH), not a zombie. */
	async stop(): Promise<void> {
		try {
			this.child.kill("SIGKILL");
		} catch {
			/* already gone */
		}
		await new Promise<void>((resolve) => {
			this.child.once("exit", () => resolve());
			setTimeout(resolve, 2000);
		});
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

/** Build a minimal ManifestCache stub backed by an in-memory array. */
function makeStubCache(manifests: TeamRunManifest[]): ManifestCache {
	const byId = new Map(manifests.map((m) => [m.runId, m]));
	return {
		list: () => manifests,
		listActive: (limit: number) => manifests.filter((m) => m.status === "running").slice(0, limit),
		get: (runId: string) => byId.get(runId),
		clear: () => {},
		dispose: () => {},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// purgeStaleActiveRunIndex
// ════════════════════════════════════════════════════════════════════════════

// ─── Test 1: orphaned run (dead PID + stale updatedAt + no heartbeat) ───────
//
// CHARACTERIZATION: a genuinely dead session's run is purged from the active
// index. Its stateRoot is PRESERVED (not hard-deleted) and the manifest is
// marked "cancelled" so diagnostics survive and the run stays queryable.
// This invariant MUST NOT break when currentSessionId filtering is added
// (currentSessionId===undefined → no filtering → same behavior).
test("purgeStaleActiveRunIndex: orphaned run (dead PID + stale updatedAt + no heartbeat) is purged, stateRoot preserved, manifest cancelled", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-orphan-"));
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "orphaned run" });
			const manifestPath = created.paths.manifestPath;
			const running: TeamRunManifest = {
				...created.manifest,
				status: "running",
				updatedAt: new Date(t0).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(running);
			registerActiveRun(running); // PID alive at registration → passes liveness filter
			await worker.stop(); // now genuinely dead

			const now = t0 + 20 * 60 * 1000; // 20 min later — well past STALE threshold

			assert.ok(fs.existsSync(running.stateRoot), "stateRoot exists before purge");
			const result = purgeStaleActiveRunIndex(STALE, now);

			// INVARIANT: the dead session's run IS purged from the active index.
			assert.ok(result.purged.includes(running.runId), "orphaned run must leave the active index");
			// stateRoot must be PRESERVED (R-01: diagnostics/resumability).
			assert.ok(fs.existsSync(running.stateRoot), "stateRoot must be preserved (not hard-deleted)");
			assert.ok(fs.existsSync(manifestPath), "manifest.json must survive");
			// The manifest must be marked cancelled (queryable), not destroyed.
			const reloaded = loadRunManifestById(cwd, running.runId);
			assert.equal(reloaded?.manifest.status, "cancelled", "orphaned run is marked cancelled");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Test 2: fresh manifest (updatedAt within threshold) ────────────────────
//
// CHARACTERIZATION: a run whose on-disk manifest.updatedAt is fresh (within
// the stale threshold) is KEPT — even if the registry entry.updatedAt is old.
// This guards against false-positive purges of legitimately long-running runs.
test("purgeStaleActiveRunIndex: fresh manifest (updatedAt within threshold) is kept", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-char-fresh-"));
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "fresh run" });
			const running: TeamRunManifest = {
				...created.manifest,
				status: "running",
				updatedAt: new Date(t0).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(running);
			registerActiveRun(running);
			await worker.stop();

			// Simulate 20 min elapsed, but re-save the manifest with a FRESH
			// updatedAt (1 min ago in simulated time) — as a live workflow would
			// on each transition.
			const now = t0 + 20 * 60 * 1000;
			saveRunManifest({
				...running,
				updatedAt: new Date(now - 60_000).toISOString(),
			});

			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(!result.purged.includes(running.runId), "a fresh on-disk manifest must NOT be purged");
			assert.ok(result.kept.includes(running.runId), "fresh run must be kept");
			assert.ok(fs.existsSync(running.stateRoot), "stateRoot must be preserved");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// reconcileAllStaleRuns
// ════════════════════════════════════════════════════════════════════════════

// ─── Test 3: running run with dead worker PID → reconciled (marked failed) ─
//
// CHARACTERIZATION: a running run whose async worker PID is genuinely dead is
// reconciled — its manifest is marked "failed" and running tasks are cancelled.
// This is the primary stale-run repair path. This behavior MUST be preserved
// when currentSessionId filtering is added (currentSessionId===undefined → no
// skip → same repair).
test("reconcileAllStaleRuns: a running run with a dead worker PID is reconciled (marked failed)", async () => {
	const dir = createTrackedTempDir("pi-crew-char-reconcile-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const created = createRunManifest({ cwd: dir, team, workflow, goal: "stale run" });

		// Set the manifest to "running" with the dead PID.
		const running: TeamRunManifest = {
			...created.manifest,
			status: "running",
			updatedAt: new Date(t0).toISOString(),
			async: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
		};
		saveRunManifest(running);

		// Set the task to "running" with a dead heartbeat so it's a repair candidate.
		const tasks: TeamTaskState[] = created.tasks.map((task) => ({
			...task,
			status: "running",
			heartbeat: {
				workerId: "w1",
				pid: deadPid,
				lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(),
				alive: false,
			},
		}));
		saveRunTasks(running, tasks);

		// Build a stub cache that returns the running manifest.
		const stubCache = makeStubCache([running]);
		const results = reconcileAllStaleRuns(dir, stubCache, Date.now());

		// The run must have been reconciled (repaired).
		assert.ok(results.length > 0, "reconcileAllStaleRuns must return a result for the stale run");
		assert.ok(
			results.some((r) => r.runId === running.runId && r.repaired),
			`the stale run must be marked repaired (got verdicts: ${results.map((r) => r.verdict).join(", ")})`,
		);

		// The manifest on disk must now be "failed".
		const reloaded = loadRunManifestById(dir, running.runId);
		assert.equal(reloaded?.manifest.status, "failed", "stale run manifest must be marked failed after reconciliation");

		// The running task must now be cancelled.
		const reloadedTask = reloaded?.tasks.find((t) => t.id === tasks[0].id);
		assert.equal(reloadedTask?.status, "cancelled", "running task must be cancelled after reconciliation");
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ════════════════════════════════════════════════════════════════════════════
// detectInterruptedRuns
// ════════════════════════════════════════════════════════════════════════════

// ─── Test 4: running run with dead PID + stale heartbeat → RecoveryPlan ────
//
// CHARACTERIZATION: a running run whose async PID is dead and whose task has a
// stale/dead heartbeat produces a RecoveryPlan with resumable task IDs.
test("detectInterruptedRuns: a running run with dead PID + stale heartbeat returns a RecoveryPlan with resumable tasks", async () => {
	const dir = createTrackedTempDir("pi-crew-char-detect-dead-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const created = createRunManifest({ cwd: dir, team, workflow, goal: "interrupted run" });

		const running: TeamRunManifest = {
			...created.manifest,
			status: "running",
			updatedAt: new Date(t0).toISOString(),
			async: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
		};
		saveRunManifest(running);

		const tasks: TeamTaskState[] = created.tasks.map((task) => ({
			...task,
			status: "running",
			heartbeat: {
				workerId: "w1",
				pid: deadPid,
				lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(),
				alive: false,
			},
		}));
		saveRunTasks(running, tasks);

		const stubCache = makeStubCache([running]);
		const plans = detectInterruptedRuns(dir, stubCache, 300_000);

		assert.equal(plans.length, 1, "must return exactly one RecoveryPlan");
		assert.equal(plans[0].runId, running.runId, "plan runId must match");
		assert.ok(plans[0].resumableTasks.length > 0, "plan must have resumable tasks");
		assert.ok(
			plans[0].resumableTasks.includes(tasks[0].id),
			`resumableTasks must include the running task (got: ${plans[0].resumableTasks.join(", ")})`,
		);
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ─── Test 5: completed run → empty plans ────────────────────────────────────
//
// CHARACTERIZATION: a completed run is never considered interrupted —
// detectInterruptedRuns returns an empty array.
test("detectInterruptedRuns: a completed run returns empty plans", () => {
	const dir = createTrackedTempDir("pi-crew-char-detect-done-");
	try {
		const cache = makeStubCache([
			{
				...createRunManifest({ cwd: dir, team, workflow, goal: "done run" }).manifest,
				status: "completed",
			},
		]);
		const plans = detectInterruptedRuns(dir, cache, 300_000);
		assert.deepStrictEqual(plans, [], "a completed run must yield no recovery plans");
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ─── Test 6: plan-approval-blocked run → empty (preserved) ──────────────────
//
// CHARACTERIZATION: a run intentionally blocked on human plan approval is
// preserved — detectInterruptedRuns returns an empty array. This is NOT a
// crash; the run is waiting for a decision (PR #32).
test("detectInterruptedRuns: a plan-approval-blocked run returns empty (preserved)", () => {
	const dir = createTrackedTempDir("pi-crew-char-detect-plan-");
	try {
		const now = new Date().toISOString();
		const base = createRunManifest({ cwd: dir, team, workflow, goal: "plan-approval run" });
		const cache = makeStubCache([
			{
				...base.manifest,
				status: "blocked",
				async: { pid: 99999125, logPath: "", spawnedAt: now },
				planApproval: {
					required: true,
					status: "pending",
					requestedAt: now,
					updatedAt: now,
				},
			},
		]);
		const plans = detectInterruptedRuns(dir, cache, 300_000);
		assert.deepStrictEqual(plans, [], "a plan-approval-blocked run must be preserved (no recovery plans)");
	} finally {
		removeTrackedTempDir(dir);
	}
});
