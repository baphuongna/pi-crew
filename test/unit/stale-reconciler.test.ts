import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isPlanApprovalPending, reconcileOrphanedTempWorkspaces, reconcileStaleRun } from "../../src/runtime/stale-reconciler.ts";
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

	it("marks run failed (not completed) when all tasks failed (C2 regression)", () => {
		const manifest: TeamRunManifest = { ...baseManifest, status: "running" };
		const failedTask: TeamTaskState = {
			...runningTask,
			status: "failed",
			finishedAt: new Date().toISOString(),
		};
		const result = reconcileStaleRun(manifest, [failedTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(manifest.status, "failed");
	});

	it("marks run failed when a mix of failed + completed tasks exists (C2 regression)", () => {
		const manifest: TeamRunManifest = { ...baseManifest, status: "running" };
		const failedTask: TeamTaskState = {
			...runningTask,
			id: "task-fail",
			status: "failed",
			finishedAt: new Date().toISOString(),
		};
		const result = reconcileStaleRun(manifest, [completedTask, failedTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(manifest.status, "failed");
	});

	it("marks run cancelled when all tasks are cancelled/skipped (C2 regression)", () => {
		const manifest: TeamRunManifest = { ...baseManifest, status: "running" };
		const cancelledTask: TeamTaskState = { ...runningTask, status: "cancelled" };
		const result = reconcileStaleRun(manifest, [cancelledTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(manifest.status, "cancelled");
	});

	it("marks run completed only when tasks succeeded (C2 regression)", () => {
		const manifest: TeamRunManifest = { ...baseManifest, status: "running" };
		const result = reconcileStaleRun(manifest, [completedTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(manifest.status, "completed");
	});

	it("marks run failed (not completed) when all tasks need_attention (T1)", () => {
		const manifest: TeamRunManifest = { ...baseManifest, status: "running" };
		const attentionTask: TeamTaskState = {
			...runningTask,
			status: "needs_attention",
			finishedAt: new Date().toISOString(),
		};
		const result = reconcileStaleRun(manifest, [attentionTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(manifest.status, "failed");
	});

	it("marks run failed when mix of needs_attention + completed tasks (T1)", () => {
		const manifest: TeamRunManifest = { ...baseManifest, status: "running" };
		const attentionTask: TeamTaskState = {
			...runningTask,
			id: "task-attn",
			status: "needs_attention",
			finishedAt: new Date().toISOString(),
		};
		const result = reconcileStaleRun(manifest, [completedTask, attentionTask]);
		assert.equal(result.verdict, "result_exists");
		assert.equal(manifest.status, "failed");
	});

	// Regression: PR #32 / gustavo-pelissaro — a run blocked on human plan
	// approval must never be stale-repaired or marked failed, even if its
	// owning session died or its async PID is no longer live.
	const planApprovalNow = new Date().toISOString();
	const planApprovalManifest: TeamRunManifest = {
		...baseManifest,
		runId: "run-plan-approval",
		status: "blocked",
		async: {
			pid: 99999124,
			logPath: "/tmp/log",
			spawnedAt: planApprovalNow,
		},
		planApproval: {
			required: true,
			status: "pending",
			requestedAt: planApprovalNow,
			updatedAt: planApprovalNow,
			planTaskId: "01_plan",
		},
	};

	it("isPlanApprovalPending is true only for blocked+required+pending runs", () => {
		assert.equal(isPlanApprovalPending(planApprovalManifest), true);
		// status not blocked
		assert.equal(
			isPlanApprovalPending({
				...planApprovalManifest,
				status: "running",
			}),
			false,
		);
		// not required
		assert.equal(
			isPlanApprovalPending({
				...planApprovalManifest,
				planApproval: {
					...planApprovalManifest.planApproval!,
					required: false,
				},
			}),
			false,
		);
		// already approved
		assert.equal(
			isPlanApprovalPending({
				...planApprovalManifest,
				planApproval: {
					...planApprovalManifest.planApproval!,
					status: "approved",
				},
			}),
			false,
		);
		// no planApproval at all
		assert.equal(
			isPlanApprovalPending({
				...planApprovalManifest,
				planApproval: undefined,
			}),
			false,
		);
	});

	it("preserves plan-approval blocked runs even when async PID is dead", () => {
		// 99999124 is a PID that will not be alive → would normally be "pid_dead" + repaired.
		const result = reconcileStaleRun(planApprovalManifest, [runningTask], Date.now());
		assert.equal(result.verdict, "blocked_awaiting_approval");
		assert.equal(result.repaired, false);
		assert.equal(result.repairedTasks, undefined);
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
		const task = {
			...runningTask,
			heartbeat: {
				workerId: "task-1",
				lastSeenAt: new Date(now - 1000).toISOString(),
				alive: true,
			},
		};
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
		assert.equal(result.repairedTasks?.[0]?.status, "cancelled");
	});

	it("returns healthy for alive PID with recent update", () => {
		const manifest = {
			...baseManifest,
			async: {
				pid: process.pid,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		};
		// Use current process PID — it's alive
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "healthy");
		assert.equal(result.repaired, false);
	});

	it("repairs dead PID", () => {
		const manifest = {
			...baseManifest,
			async: {
				pid: 99999123,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		// PID 99999123 doesn't exist, so it's dead
		assert.equal(result.verdict, "pid_dead");
		assert.equal(result.repaired, true);
	});

	it("repairs dead PID immediately even with a fresh heartbeat.json (F1: 353s pid_dead lag)", () => {
		// Regression: a <5min-old heartbeat.json USED to override the authoritative
		// kill(0) ESRCH verdict (returning alive:true), delaying repair ~5min and
		// producing the observed ~353s pid_dead detection lag. Now ESRCH wins → repaired
		// on the next reconcile tick instead of ~5min later.
		const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "stale-hb-"));
		try {
			const deadPid = 99999125;
			fs.writeFileSync(
				path.join(tmpRoot, "heartbeat.json"),
				JSON.stringify({ pid: deadPid, at: Date.now() - 10_000 }), // 10s old — within the old 5min grace
			);
			const manifest = {
				...baseManifest,
				stateRoot: tmpRoot,
				async: { pid: deadPid, logPath: "/tmp/log", spawnedAt: new Date().toISOString() },
			};
			const result = reconcileStaleRun(manifest, [runningTask], Date.now());
			assert.equal(result.verdict, "pid_dead");
			assert.equal(result.repaired, true);
		} finally {
			fs.rmSync(tmpRoot, { recursive: true, force: true });
		}
	});

	it("returns healthy for alive PID with recent updatedAt even with running tasks", () => {
		const manifest = {
			...baseManifest,
			async: {
				pid: process.pid,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "healthy");
	});

	it("repairs alive but stale PID (>24h since update)", () => {
		const staleTime = Date.now() - 25 * 60 * 60 * 1000;
		const manifest = {
			...baseManifest,
			updatedAt: new Date(staleTime).toISOString(),
			async: {
				pid: process.pid,
				logPath: "/tmp/log",
				spawnedAt: new Date().toISOString(),
			},
		};
		const result = reconcileStaleRun(manifest, [runningTask], Date.now());
		assert.equal(result.verdict, "pid_alive_stale");
		assert.equal(result.repaired, true);
	});

	// New: no-PID with stale heartbeats should auto-repair
	it("repairs no-PID run when all running tasks have stale heartbeats (>5min)", () => {
		const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
		const manifest: TeamRunManifest = {
			...baseManifest,
			updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
		};
		const task: TeamTaskState = {
			...runningTask,
			heartbeat: {
				workerId: "task-1",
				lastSeenAt: tenMinutesAgo,
				alive: true,
			},
		};

		const result = reconcileStaleRun(manifest, [task], Date.now());

		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, true);
		assert.ok(result.repairedTasks);
		assert.equal(result.repairedTasks[0].status, "cancelled");
		assert.match(result.repairedTasks[0].error ?? "", /no_pid_heartbeat_stale/);
	});

	// New: no-PID with recent heartbeats should NOT repair
	it("preserves no-PID run when heartbeat is recent (<5min)", () => {
		const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();
		const manifest: TeamRunManifest = {
			...baseManifest,
			updatedAt: new Date(Date.now() - 60 * 1000).toISOString(),
		};
		const task: TeamTaskState = {
			...runningTask,
			heartbeat: {
				workerId: "task-1",
				lastSeenAt: oneMinuteAgo,
				alive: true,
			},
		};

		const result = reconcileStaleRun(manifest, [task], Date.now());

		assert.equal(result.verdict, "no_status");
		assert.equal(result.repaired, false);
	});
});

// ---------------------------------------------------------------------------
// reconcileOrphanedTempWorkspaces — orphaned /tmp cleanup tests
// ---------------------------------------------------------------------------

describe("reconcileOrphanedTempWorkspaces", () => {
	const tempDirs: string[] = [];
	// Round 19: per-test ISOLATED tmp dir. reconcileOrphanedTempWorkspaces
	// scans os.tmpdir() for 'pi-crew-*' dirs but caps the scan at
	// ORPHAN_TEMP_SCAN_BATCH_SIZE=50 (sorted alphabetically). Leftover dirs
	// from other tests/runs pushed our workspace past the cap → repaired=0.
	// Fix: create a fresh isolated dir per test (simulating /tmp but containing
	// ONLY this test's workspaces) and inject it via the tmpDir option.
	let isolatedTmp: string;

	beforeEach(() => {
		isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-isotmp-"));
		tempDirs.push(isolatedTmp);
	});

	afterEach(() => {
		// Clean up any temp dirs created during tests
		for (const dir of tempDirs.splice(0)) {
			try {
				fs.rmSync(dir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	function createTempWorkspace(options: {
		/** Status for the manifest. Default: "running" */
		manifestStatus?: TeamRunManifest["status"];
		/** If true, set the dir mtime to 2 hours ago. Default: true. */
		old?: boolean;
	}): string {
		const wsDir = fs.mkdtempSync(path.join(isolatedTmp, "pi-crew-test-"));
		tempDirs.push(wsDir);
		const runId = `test_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
		const runDir = path.join(wsDir, ".crew", "state", "runs", runId);
		fs.mkdirSync(runDir, { recursive: true });

		const manifest: TeamRunManifest = {
			schemaVersion: 1,
			runId,
			cwd: wsDir,
			team: "test",
			goal: "test",
			status: options.manifestStatus ?? "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stateRoot: path.join(wsDir, ".crew", "state"),
			artifactsRoot: path.join(wsDir, ".crew", "artifacts"),
			tasksPath: path.join(runDir, "tasks.json"),
			eventsPath: path.join(runDir, "events.jsonl"),
			workspaceMode: "single",
			artifacts: [],
		};

		// Write manifest with a dead PID so reconcileStaleRun repairs it
		if (manifest.status === "running") {
			(manifest as unknown as Record<string, unknown>).async = {
				pid: 99999456,
				logPath: "/dev/null",
				spawnedAt: new Date().toISOString(),
			};
		}

		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2));

		const tasks: TeamTaskState[] = [
			{
				id: "task-1",
				runId,
				role: "executor",
				agent: "test-agent",
				title: "Test task",
				status: "running",
				dependsOn: [],
				cwd: wsDir,
			},
		];
		fs.writeFileSync(path.join(runDir, "tasks.json"), JSON.stringify(tasks, null, 2));

		// Set directory mtime to simulate age
		if (options.old !== false) {
			const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
			fs.utimesSync(wsDir, new Date(twoHoursAgo), new Date(twoHoursAgo));
		}

		return wsDir;
	}

	it("reconciles and cleans old dir when cleanup enabled", () => {
		const wsDir = createTempWorkspace({
			manifestStatus: "running",
			old: true,
		});
		const now = Date.now();

		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
			cleanupOrphanedTempDirs: true,
		});

		assert.ok(result.repaired >= 1, `expected repaired >= 1, got ${result.repaired}`);
		assert.ok(result.cleanedDirs >= 1, `expected cleanedDirs >= 1, got ${result.cleanedDirs}`);
		assert.ok(!fs.existsSync(wsDir), "temp dir should be deleted");
	});

	it("reconciles but does NOT clean recent dir", () => {
		const wsDir = createTempWorkspace({
			manifestStatus: "running",
			old: false,
		});
		const now = Date.now();

		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
			cleanupOrphanedTempDirs: true,
		});

		assert.ok(result.repaired >= 1, `expected repaired >= 1, got ${result.repaired}`);
		assert.equal(result.cleanedDirs, 0);
		assert.ok(fs.existsSync(wsDir), "temp dir should still exist (too recent)");
	});

	it("respects cleanupOrphanedTempDirs: false", () => {
		const wsDir = createTempWorkspace({
			manifestStatus: "running",
			old: true,
		});
		const now = Date.now();

		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
			cleanupOrphanedTempDirs: false,
		});

		assert.ok(result.repaired >= 1, `expected repaired >= 1, got ${result.repaired}`);
		assert.equal(result.cleanedDirs, 0);
		assert.ok(fs.existsSync(wsDir), "temp dir should still exist (cleanup disabled)");
	});

	it("cleans dir with no running runs (already cancelled)", () => {
		const wsDir = createTempWorkspace({
			manifestStatus: "cancelled",
			old: true,
		});
		const now = Date.now();

		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
			cleanupOrphanedTempDirs: true,
		});

		assert.equal(result.repaired, 0);
		assert.ok(result.cleanedDirs >= 1, `expected cleanedDirs >= 1, got ${result.cleanedDirs}`);
		assert.ok(!fs.existsSync(wsDir), "temp dir should be deleted");
	});

	it("does NOT clean dir with active running run (alive PID)", () => {
		const wsDir = createTempWorkspace({
			manifestStatus: "running",
			old: true,
		});

		// Override the manifest to use the current process PID (alive)
		const stateRunsDir = path.join(wsDir, ".crew", "state", "runs");
		const runDir = fs.readdirSync(stateRunsDir)[0]!;
		const manifestPath = path.join(stateRunsDir, runDir, "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.async = {
			pid: process.pid,
			logPath: "/dev/null",
			spawnedAt: new Date().toISOString(),
		};
		manifest.updatedAt = new Date().toISOString();
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

		const now = Date.now();
		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
			cleanupOrphanedTempDirs: true,
		});

		// The run was NOT repaired (PID is alive and recent)
		assert.equal(result.repaired, 0);
		assert.equal(result.cleanedDirs, 0);
		assert.ok(fs.existsSync(wsDir), "dir should be preserved (active run)");
	});

	it("defaults to cleanup enabled when options omitted", () => {
		const wsDir = createTempWorkspace({
			manifestStatus: "cancelled",
			old: true,
		});
		const now = Date.now();

		const result = reconcileOrphanedTempWorkspaces(now, {
			tmpDir: isolatedTmp,
		});

		assert.equal(result.repaired, 0);
		assert.ok(result.cleanedDirs >= 1, `expected cleanedDirs >= 1, got ${result.cleanedDirs}`);
		assert.ok(!fs.existsSync(wsDir), "temp dir should be deleted (default cleanup)");
	});
});
