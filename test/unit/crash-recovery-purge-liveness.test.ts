/**
 * Regression tests for the "team run hangs forever at 25%" bug.
 *
 * ROOT CAUSE: `purgeStaleActiveRunIndex` (crash-recovery.ts) deleted a run's
 * stateRoot based on `entry.updatedAt`, which is frozen at registration and
 * NEVER refreshed during execution. A long-running legitimate async run whose
 * background worker had exited (e.g. after a 5–15 minute explorer) would then
 * have its entire durable state (manifest/tasks/events/heartbeat) destroyed.
 * Because `saveRunTasks()` silently no-ops once the state dir is missing, the
 * workflow could never advance past the current task → permanent INVISIBLE
 * hang ("Run not found"), with all diagnostics lost. This reproduced across
 * 4+ consecutive review/fast-fix runs.
 *
 * FIX: purge now corroborates liveness via (a) the on-disk `manifest.updatedAt`
 * and (b) the team-level `heartbeat.json`, and no longer deletes stateRoot —
 * it marks the run cancelled so it stays queryable/resumable and its
 * diagnostics survive (the finished-run pruner cleans the dir later).
 *
 * Testing strategy: we register each run with an ALIVE worker PID (so the
 * registry's own registration liveness filter accepts it — mirroring reality,
 * where the PID is alive at registration), then kill+reap the worker so the PID
 * is genuinely dead at purge time. We advance purge's `now` to simulate the
 * entry aging past the threshold, and use `fs.utimesSync` to place the heartbeat
 * mtime precisely in simulated time.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { purgeStaleActiveRunIndex } from "../../src/runtime/recovery/crash-recovery.ts";
import { registerActiveRun } from "../../src/state/stores/active-run-registry.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest } from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "ari",
	description: "ari",
	source: "builtin",
	filePath: "ari.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "ari",
	description: "ari",
	source: "builtin",
	filePath: "ari.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

async function withIsolatedHomeAsync<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-purge-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** A long-lived child whose PID is alive (for registration) and can be reaped. */
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

const STALE = 5 * 60 * 1000; // 5 min, matching purgeStaleActiveRunIndex default

/** Register a running async run with a live worker, then reap the worker. */
async function setupRunningRun(
	cwd: string,
	goal: string,
): Promise<{
	runId: string;
	stateRoot: string;
	manifestPath: string;
	worker: AliveWorker;
	t0: number;
}> {
	const worker = new AliveWorker();
	const t0 = Date.now();
	const created = createRunManifest({ cwd, team, workflow, goal });
	const running = {
		...created.manifest,
		status: "running" as const,
		updatedAt: new Date(t0).toISOString(),
		async: {
			pid: worker.pid,
			logPath: "",
			spawnedAt: new Date(t0).toISOString(),
		},
	};
	saveRunManifest(running);
	registerActiveRun(running); // PID alive here → passes the registration liveness filter
	await worker.stop(); // now the PID is genuinely dead, exactly like a finished worker
	return {
		runId: created.manifest.runId,
		stateRoot: created.paths.stateRoot,
		manifestPath: created.paths.manifestPath,
		worker,
		t0,
	};
}

// ─── Regression: a fresh on-disk manifest must NOT be purged ───
test("purgeStaleActiveRunIndex keeps a run whose on-disk manifest is fresh (regression: 25% hang)", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-purge-fresh-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const run = await setupRunningRun(cwd, "fresh manifest run");
			// Simulate 20 min elapsing. entry.updatedAt (=t0) is now 20 min old — the
			// exact bug enabler. But re-save the on-disk manifest with a FRESH updatedAt
			// (1 min ago in simulated time), as a live workflow would on each transition.
			const now = run.t0 + 20 * 60 * 1000;
			saveRunManifest({
				...loadRunManifestById(cwd, run.runId)!.manifest,
				updatedAt: new Date(now - 60_000).toISOString(),
			});

			assert.ok(fs.existsSync(run.stateRoot), "stateRoot exists before purge");
			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(!result.purged.includes(run.runId), "a fresh on-disk manifest must NOT be purged");
			assert.ok(result.kept.includes(run.runId), "fresh run must be kept");
			assert.ok(fs.existsSync(run.stateRoot), "REGRESSION: stateRoot must NOT be deleted for a fresh run");
			assert.ok(fs.existsSync(run.manifestPath), "manifest.json must survive");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── A genuinely-orphaned run is cancelled, but its state is preserved ───
test("purgeStaleActiveRunIndex cancels a genuinely-orphaned run but preserves its stateRoot", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-purge-orphan-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const run = await setupRunningRun(cwd, "orphaned run");
			// 20 min later, dead worker, on-disk manifest still at t0 (stale), no heartbeat.
			const now = run.t0 + 20 * 60 * 1000;

			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(result.purged.includes(run.runId), "an orphaned run should leave the active index");
			// REGRESSION: the stateRoot used to be hard-deleted here, making the run vanish
			// ("Run not found") and destroying all diagnostics. It must now survive.
			assert.ok(fs.existsSync(run.stateRoot), "REGRESSION: stateRoot must be preserved for diagnostics/resumability");
			assert.ok(fs.existsSync(run.manifestPath), "manifest.json must survive");
			const reloaded = loadRunManifestById(cwd, run.runId);
			assert.equal(reloaded?.manifest.status, "cancelled", "orphaned run is marked cancelled (queryable), not destroyed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── A fresh team heartbeat corroborates liveness even if the manifest is stale ───
test("purgeStaleActiveRunIndex keeps a run with a fresh team heartbeat even if the manifest is stale", async () => {
	await withIsolatedHomeAsync(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-purge-hb-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const run = await setupRunningRun(cwd, "heartbeat run");
			// 20 min later, dead worker, on-disk manifest stale (still t0), BUT a fresh
			// team heartbeat written 1 min ago in simulated time (via utimesSync).
			const now = run.t0 + 20 * 60 * 1000;
			const heartbeatPath = path.join(run.stateRoot, "heartbeat.json");
			fs.writeFileSync(
				heartbeatPath,
				JSON.stringify({
					pid: run.worker.pid,
					at: now - 60_000,
					runId: run.runId,
				}),
			);
			const freshMtime = (now - 60_000) / 1000;
			fs.utimesSync(heartbeatPath, freshMtime, freshMtime);

			const result = purgeStaleActiveRunIndex(STALE, now);

			assert.ok(!result.purged.includes(run.runId), "a run with a fresh heartbeat must NOT be purged");
			assert.ok(fs.existsSync(run.stateRoot), "stateRoot must be preserved");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
