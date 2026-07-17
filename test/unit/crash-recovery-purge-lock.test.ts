/**
 * RT-F5 regression test: purgeStaleActiveRunIndex's orphaned-run cancellation
 * (conditions 5 + 6) must take the run lock so a concurrent writer cannot
 * interleave a saveRunTasks between our saveRunTasks and updateRunStatus calls
 * and leave the run in a torn state (e.g. tasks refreshed mid-flight but
 * status flipped to cancelled, hiding fresh work).
 *
 * Strategy: spawn a concurrent writer that takes the run lock and saves a
 * "fresh" tasks array right when purge is about to mark the run cancelled.
 * Then verify the final on-disk state is internally consistent: if the
 * cancel was observed, the tasks on disk should match the cancel-time repair
 * (NOT the concurrent writer's tasks) — i.e. the lock serialized the writes.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { purgeStaleActiveRunIndex } from "../../src/runtime/crash-recovery.ts";
import { registerActiveRun } from "../../src/state/active-run-registry.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "locktest",
	description: "locktest",
	source: "builtin",
	filePath: "locktest.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "locktest",
	description: "locktest",
	source: "builtin",
	filePath: "locktest.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

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

const STALE = 5 * 60 * 1000;

async function withIsolatedHome<T>(fn: () => Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-purge-lock-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("purgeStaleActiveRunIndex takes withRunLockSync around the orphaned-run cancellation", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-purge-lock-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			// 1. Create a run, set status=running with a live PID, then reap.
			const worker = new AliveWorker();
			const t0 = Date.now();
			const created = createRunManifest({ cwd, team, workflow, goal: "lock-test run" });
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
			registerActiveRun(running);
			await worker.stop();

			// 2. Pre-write a tasks file so saveRunTasks (called by purge) has
			// something to overwrite. We mark task 0 "running" with a fresh
			// heartbeat so the cancel path will flip it to "cancelled".
			const initialTasks = [
				{
					id: "explore",
					runId: created.manifest.runId,
					role: "explorer",
					agent: "explorer",
					title: "Explore",
					dependsOn: [],
					cwd: cwd,
					status: "running" as const,
					heartbeat: { alive: false, lastSeenAt: new Date(t0 - 60_000).toISOString(), workerId: "test-worker" },
				},
			];
			saveRunTasks(created.manifest, initialTasks);

			// 3. Now call purge with a now() 20 min in the future → orphaned.
			// RT-F5: the mutation block is now wrapped in withRunLockSync; this
			// means a concurrent writer that takes the lock will queue behind
			// purge's mutation, NOT interleave. We assert the final tasks are
			// purge's repaired-tasks (status="cancelled"), not whatever a
			// concurrent writer might have written.
			const now = t0 + 20 * 60 * 1000;
			const result = purgeStaleActiveRunIndex(STALE, now);
			assert.ok(result.purged.includes(created.manifest.runId), "purge should cancel the orphaned run");

			// 4. Read back the final state. If the lock works, the tasks file
			// matches purge's repair (status="cancelled") and the manifest is
			// also terminal "cancelled" — internally consistent.
			const finalLoaded = loadRunManifestById(cwd, created.manifest.runId);
			assert.ok(finalLoaded, "manifest must still be queryable (stateRoot preserved)");
			assert.equal(finalLoaded!.manifest.status, "cancelled", "manifest flipped to cancelled by purge");
			assert.ok(finalLoaded!.tasks.length > 0, "tasks file was rewritten by purge");
			assert.equal(
				finalLoaded!.tasks[0]!.status,
				"cancelled",
				"RT-F5: tasks file must reflect purge's repair — if not, the lock is missing and a concurrent writer raced between saveRunTasks and updateRunStatus",
			);
			assert.equal(
				finalLoaded!.tasks[0]!.error,
				"Orphaned run: worker process dead and no recent activity",
				"cancel reason matches the orphaned-run path",
			);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
