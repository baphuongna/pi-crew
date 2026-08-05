/**
 * CROSS-SESSION REGRESSION TESTS for crash-recovery session-awareness.
 *
 * These tests verify that the `currentSessionId?` parameter added in Phase 1
 * of the cross-session-leak fix prevents a LIVE session B from cleaning up
 * session A's still-running run, while a genuinely DEAD session's run is STILL
 * cleaned up.
 *
 * Key invariant under test:
 *   - `currentSessionId === ownerSessionId` → SKIP (the run belongs to the
 *     current live session, so it must not be touched).
 *   - `currentSessionId !== ownerSessionId` → process normally (dead PID +
 *     stale heartbeat → cleaned; alive PID / fresh heartbeat → kept).
 *   - `currentSessionId === undefined` → back-compat (no session filtering,
 *     same behavior as before the fix).
 *
 * Mirrors fixtures from crash-recovery-characterization.test.ts.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ManifestCache } from "../../../../src/runtime/manifest-cache.ts";
import { detectInterruptedRuns, purgeStaleActiveRunIndex, reconcileAllStaleRuns } from "../../../../src/runtime/recovery/crash-recovery.ts";
import { registerActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

// ─── Shared fixtures (mirrored from characterization test) ─────────────────

const team: TeamConfig = {
	name: "xses",
	description: "xses",
	source: "builtin",
	filePath: "xses.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "xses",
	description: "xses",
	source: "builtin",
	filePath: "xses.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

const STALE = 5 * 60 * 1000; // 5 min, matching purgeStaleActiveRunIndex default

/** Isolate PI_TEAMS_HOME so the global active-run registry is sandboxed. */
async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-xses-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
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

/** A long-lived child whose PID is alive for registration, then reaped dead. */
class AliveWorker {
	readonly pid: number;
	private readonly child: ChildProcess;
	constructor() {
		this.child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 60000)"], { stdio: "ignore" });
		this.pid = this.child.pid ?? -1;
	}
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

/** Build a minimal ManifestCache stub backed by an in-memory array. */
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

/**
 * Create and persist a run with the given ownerSessionId, status, async block,
 * and task heartbeat. Returns the saved manifest + tasks.
 */
function setupRun(
	cwd: string,
	opts: {
		ownerSessionId: string;
		status?: TeamRunManifest["status"];
		asyncBlock?: TeamRunManifest["async"];
		heartbeat: TeamTaskState["heartbeat"];
	},
): { manifest: TeamRunManifest; tasks: TeamTaskState[] } {
	const created = createRunManifest({ cwd, team, workflow, goal: "cross-session test" });
	const manifest: TeamRunManifest = {
		...created.manifest,
		status: opts.status ?? "running",
		ownerSessionId: opts.ownerSessionId,
		async: opts.asyncBlock,
	};
	saveRunManifest(manifest);

	const tasks: TeamTaskState[] = created.tasks.map((task) => ({
		...task,
		status: "running",
		heartbeat: opts.heartbeat,
	}));
	saveRunTasks(manifest, tasks);

	return { manifest, tasks };
}

// ════════════════════════════════════════════════════════════════════════════
// reconcileAllStaleRuns
// ════════════════════════════════════════════════════════════════════════════

test("reconcileAllStaleRuns: self-own stale run is SKIPPED when currentSessionId === ownerSessionId", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-rec-self-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			heartbeat: { workerId: "w1", pid: deadPid, lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(), alive: false },
		});

		// currentSessionId = "A" === ownerSessionId → skip-own → NOT reconciled
		const cache = makeStubCache([manifest]);
		const results = reconcileAllStaleRuns(dir, cache, Date.now(), "A");

		assert.equal(results.length, 0, "self-own stale run must NOT be reconciled when currentSessionId matches");

		const reloaded = loadRunManifestById(dir, manifest.runId);
		assert.equal(reloaded?.manifest.status, "running", "manifest status must stay 'running' (not reconciled)");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("reconcileAllStaleRuns: cross-session stale run IS reconciled when currentSessionId !== ownerSessionId (A!==B)", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-rec-cross-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			heartbeat: { workerId: "w1", pid: deadPid, lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(), alive: false },
		});

		// currentSessionId = "B" !== ownerSessionId "A" → NOT skipped → IS reconciled
		const cache = makeStubCache([manifest]);
		const results = reconcileAllStaleRuns(dir, cache, Date.now(), "B");

		assert.ok(results.length > 0, "cross-session stale run must be reconciled");
		assert.ok(
			results.some((r) => r.runId === manifest.runId && r.repaired),
			"run must be marked repaired",
		);

		const reloaded = loadRunManifestById(dir, manifest.runId);
		assert.equal(reloaded?.manifest.status, "failed", "stale run must be marked failed after reconciliation");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("reconcileAllStaleRuns: back-compat (no currentSessionId) → stale run IS reconciled", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-rec-bc-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			heartbeat: { workerId: "w1", pid: deadPid, lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(), alive: false },
		});

		// No currentSessionId → back-compat → IS reconciled
		const cache = makeStubCache([manifest]);
		const results = reconcileAllStaleRuns(dir, cache, Date.now());

		assert.ok(results.length > 0, "back-compat: stale run must be reconciled");
		assert.ok(
			results.some((r) => r.runId === manifest.runId && r.repaired),
			"run must be marked repaired",
		);
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("reconcileAllStaleRuns: cross-session alive run (fresh heartbeat) is NOT repaired", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-rec-alive-");
	try {
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: undefined, // foreground / no PID
			heartbeat: { workerId: "w1", pid: undefined, lastSeenAt: new Date(t0).toISOString(), alive: true },
		});

		// currentSessionId = "B" — alive run should NOT be repaired
		const cache = makeStubCache([manifest]);
		const results = reconcileAllStaleRuns(dir, cache, Date.now(), "B");

		// The run may appear in results with a non-repaired verdict (diagnostic),
		// but it must NOT be repaired (no status change, no task cancellation).
		const repaired = results.filter((r) => r.repaired);
		assert.equal(repaired.length, 0, "alive run with fresh heartbeat must NOT be repaired");

		const reloaded = loadRunManifestById(dir, manifest.runId);
		assert.equal(reloaded?.manifest.status, "running", "manifest status must stay 'running' (not repaired)");
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ════════════════════════════════════════════════════════════════════════════
// detectInterruptedRuns
// ════════════════════════════════════════════════════════════════════════════

test("detectInterruptedRuns: self-own stale run is SKIPPED when currentSessionId === ownerSessionId", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-det-self-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			heartbeat: { workerId: "w1", pid: deadPid, lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(), alive: false },
		});

		const cache = makeStubCache([manifest]);
		// currentSessionId = "A" === ownerSessionId → skip-own → NOT detected
		const plans = detectInterruptedRuns(dir, cache, 300_000, "A");
		assert.deepStrictEqual(plans, [], "self-own stale run must NOT be detected as interrupted");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("detectInterruptedRuns: cross-session stale run IS detected when currentSessionId !== ownerSessionId (A!==B)", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-det-cross-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			heartbeat: { workerId: "w1", pid: deadPid, lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(), alive: false },
		});

		const cache = makeStubCache([manifest]);
		// currentSessionId = "B" !== ownerSessionId "A" → NOT skipped → IS detected
		const plans = detectInterruptedRuns(dir, cache, 300_000, "B");
		assert.equal(plans.length, 1, "cross-session stale run must be detected");
		assert.equal(plans[0].runId, manifest.runId);
		assert.ok(plans[0].resumableTasks.length > 0, "plan must have resumable tasks");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("detectInterruptedRuns: back-compat (no currentSessionId) → stale run IS detected", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-det-bc-");
	try {
		const deadPid = await reapDeadPid();
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: { pid: deadPid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			heartbeat: { workerId: "w1", pid: deadPid, lastSeenAt: new Date(t0 - 10 * 60 * 1000).toISOString(), alive: false },
		});

		const cache = makeStubCache([manifest]);
		const plans = detectInterruptedRuns(dir, cache, 300_000);
		assert.equal(plans.length, 1, "back-compat: stale run must be detected");
	} finally {
		removeTrackedTempDir(dir);
	}
});

test("detectInterruptedRuns: cross-session alive run (fresh heartbeat) is NOT detected", async () => {
	const dir = createTrackedTempDir("pi-crew-xses-det-alive-");
	try {
		const t0 = Date.now();
		const { manifest } = setupRun(dir, {
			ownerSessionId: "A",
			asyncBlock: undefined,
			heartbeat: { workerId: "w1", pid: undefined, lastSeenAt: new Date(t0).toISOString(), alive: true },
		});

		const cache = makeStubCache([manifest]);
		const plans = detectInterruptedRuns(dir, cache, 300_000, "B");
		assert.deepStrictEqual(plans, [], "alive run with fresh heartbeat must NOT be detected");
	} finally {
		removeTrackedTempDir(dir);
	}
});

// ════════════════════════════════════════════════════════════════════════════
// purgeStaleActiveRunIndex
// ════════════════════════════════════════════════════════════════════════════

test("purgeStaleActiveRunIndex: self-own dead+stale run is SKIPPED when currentSessionId === ownerSessionId", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-xses-purge-self-"));
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "self-own dead run" });
			const running: TeamRunManifest = {
				...created.manifest,
				status: "running",
				ownerSessionId: "A",
				updatedAt: new Date(t0).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(running);
			registerActiveRun(running);
			await worker.stop(); // PID now genuinely dead

			const now = t0 + 20 * 60 * 1000; // well past STALE threshold
			// currentSessionId = "A" === ownerSessionId → skip-own → NOT purged
			const result = purgeStaleActiveRunIndex(STALE, now, "A");

			assert.ok(!result.purged.includes(running.runId), "self-own dead+stale run must NOT be purged");
			assert.ok(result.kept.includes(running.runId), "self-own dead+stale run must be kept");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("purgeStaleActiveRunIndex: cross-session dead+stale run IS purged when currentSessionId !== ownerSessionId (A!==B)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-xses-purge-cross-"));
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "cross-session dead run" });
			const running: TeamRunManifest = {
				...created.manifest,
				status: "running",
				ownerSessionId: "A",
				updatedAt: new Date(t0).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(running);
			registerActiveRun(running);
			await worker.stop();

			const now = t0 + 20 * 60 * 1000;
			// currentSessionId = "B" !== ownerSessionId "A" → NOT skipped → IS purged
			const result = purgeStaleActiveRunIndex(STALE, now, "B");

			assert.ok(result.purged.includes(running.runId), "cross-session dead+stale run must be purged");
			assert.ok(fs.existsSync(running.stateRoot), "stateRoot must be preserved");
			const reloaded = loadRunManifestById(cwd, running.runId);
			assert.equal(reloaded?.manifest.status, "cancelled", "dead session's run must be cancelled");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("purgeStaleActiveRunIndex: back-compat (no currentSessionId) → dead+stale run IS purged", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-xses-purge-bc-"));
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "back-compat dead run" });
			const running: TeamRunManifest = {
				...created.manifest,
				status: "running",
				ownerSessionId: "A",
				updatedAt: new Date(t0).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(running);
			registerActiveRun(running);
			await worker.stop();

			const now = t0 + 20 * 60 * 1000;
			// No currentSessionId → back-compat → IS purged
			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(running.runId), "back-compat: dead+stale run must be purged");
			assert.ok(fs.existsSync(running.stateRoot), "stateRoot must be preserved");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("purgeStaleActiveRunIndex: cross-session alive run (fresh manifest) is NOT purged", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-xses-purge-alive-"));
		try {
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "alive run" });
			const running: TeamRunManifest = {
				...created.manifest,
				status: "running",
				ownerSessionId: "A",
				updatedAt: new Date(t0).toISOString(),
				async: { pid: worker.pid, logPath: "", spawnedAt: new Date(t0).toISOString() },
			};
			saveRunManifest(running);
			registerActiveRun(running);
			await worker.stop(); // PID dead, but manifest will be re-saved fresh

			// Re-save with a FRESH updatedAt (1 min ago in simulated time)
			const now = t0 + 20 * 60 * 1000;
			saveRunManifest({ ...running, updatedAt: new Date(now - 60_000).toISOString() });

			// currentSessionId = "B" — alive run should NOT be purged
			const result = purgeStaleActiveRunIndex(STALE, now, "B");

			assert.ok(!result.purged.includes(running.runId), "alive run with fresh manifest must NOT be purged");
			assert.ok(result.kept.includes(running.runId), "fresh run must be kept");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
