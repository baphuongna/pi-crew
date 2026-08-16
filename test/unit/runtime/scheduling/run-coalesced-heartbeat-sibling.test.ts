/**
 * R15-3 — coalesced-group heartbeat must not persist sibling tasks.
 *
 * Regression: the heartbeat previously saved the dispatch-time closure
 * `updatedTasks` — the FULL task array including sibling tasks NOT in this
 * coalesced group. A sibling cancelled on disk after dispatch (external
 * cancel / reconciler) could be un-cancelled ("resurrected") by a late
 * heartbeat save, because the map only mutated group tasks but the SAVE wrote
 * the whole stale array. The finalWriteStarted repair path (FIND-06 P1) had
 * the same flaw.
 *
 * These tests exercise the extracted `__test__persistGroupHeartbeats` /
 * `__test__repairGroupTerminalWrite` seams directly (the 15s heartbeat timer
 * is internal and has no injection seam, per run-coalesced-heartbeat-race
 * test notes). They prove: a sibling cancelled on disk stays cancelled after
 * a heartbeat/repair save, while the group's own tasks still receive
 * heartbeats / terminal state.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__persistGroupHeartbeats,
	__test__repairGroupTerminalWrite,
} from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest, loadRunManifestById, saveRunTasksAsync } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";

const team: TeamConfig = {
	name: "coalesced-sibling",
	description: "sibling preservation test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const GROUP_ID = "group-1";
const SIBLING_ID = "sibling-1";

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-sibling-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeTask(id: string, status: TeamTaskState["status"], runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: "batch",
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd,
	};
}

test("R15-3: heartbeat save does NOT resurrect a sibling cancelled on disk; group task still gets heartbeat", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "R15-3 sibling heartbeat" });

		// Seed disk: group task + sibling, both running.
		await saveRunTasksAsync(manifest, [
			makeTask(GROUP_ID, "running", manifest.runId, cwd),
			makeTask(SIBLING_ID, "running", manifest.runId, cwd),
		]);

		// External writer cancels the sibling on disk AFTER dispatch.
		const pre = loadRunManifestById(manifest.cwd, manifest.runId)!;
		const cancelledTasks = pre.tasks.map((t) =>
			t.id === SIBLING_ID ? { ...t, status: "cancelled" as const, finishedAt: new Date().toISOString() } : t,
		);
		await saveRunTasksAsync(manifest, cancelledTasks);

		// Heartbeat tick: touch ONLY the group's tasks.
		await __test__persistGroupHeartbeats(manifest, [GROUP_ID]);

		const after = loadRunManifestById(manifest.cwd, manifest.runId)!;
		const sibling = after.tasks.find((t) => t.id === SIBLING_ID)!;
		const groupTask = after.tasks.find((t) => t.id === GROUP_ID)!;

		// Sibling MUST stay cancelled — the heartbeat must not write stale
		// dispatch-time state over the disk terminal.
		assert.equal(sibling.status, "cancelled", "sibling cancelled on disk must not be resurrected by heartbeat save");
		assert.ok(sibling.finishedAt, "sibling finishedAt preserved");

		// Group task still gets its heartbeat (alive: true) with status intact.
		assert.equal(groupTask.status, "running", "group task status must be untouched by heartbeat save");
		assert.ok(groupTask.heartbeat, "group task should have a heartbeat after persist");
		assert.equal(groupTask.heartbeat!.alive, true, "group task heartbeat must be alive: true");
		assert.ok(groupTask.heartbeat!.lastSeenAt, "group task heartbeat should have lastSeenAt");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R15-3: FIND-06 repair write re-applies group terminal state without resurrecting a cancelled sibling", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "R15-3 sibling repair" });

		// Disk state: group task left pre-terminal (late heartbeat clobber
		// scenario) + sibling cancelled on disk.
		await saveRunTasksAsync(manifest, [
			makeTask(GROUP_ID, "running", manifest.runId, cwd),
			{ ...makeTask(SIBLING_ID, "cancelled", manifest.runId, cwd), finishedAt: new Date().toISOString() },
		]);

		// In-memory updatedTasks closure: group task now terminal (worker
		// finished), sibling still holds its stale dispatch-time snapshot.
		const updatedTasks: TeamTaskState[] = [
			{ ...makeTask(GROUP_ID, "completed", manifest.runId, cwd), finishedAt: new Date().toISOString() },
			makeTask(SIBLING_ID, "running", manifest.runId, cwd),
		];

		// Repair path fires after a late heartbeat save resolves.
		await __test__repairGroupTerminalWrite(manifest, [GROUP_ID], updatedTasks);

		const after = loadRunManifestById(manifest.cwd, manifest.runId)!;
		const groupTask = after.tasks.find((t) => t.id === GROUP_ID)!;
		const sibling = after.tasks.find((t) => t.id === SIBLING_ID)!;

		// Group terminal state re-applied (fixes the clobber)…
		assert.equal(groupTask.status, "completed", "repair must re-apply the group's terminal state");
		assert.ok(groupTask.finishedAt, "group task should carry finishedAt after repair");
		// …and the sibling cancelled on disk is NOT resurrected by the repair.
		assert.equal(sibling.status, "cancelled", "repair write must not resurrect a sibling cancelled on disk");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R15-3: repair write never flips a disk-terminal group task (belt-and-suspenders guard)", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "R15-3 repair guard" });

		// External cancel already made the group task terminal on disk.
		await saveRunTasksAsync(manifest, [
			{ ...makeTask(GROUP_ID, "cancelled", manifest.runId, cwd), finishedAt: new Date().toISOString() },
		]);

		// In-memory closure believes the worker completed (stale snapshot).
		const updatedTasks: TeamTaskState[] = [
			{ ...makeTask(GROUP_ID, "completed", manifest.runId, cwd), finishedAt: new Date().toISOString() },
		];

		await __test__repairGroupTerminalWrite(manifest, [GROUP_ID], updatedTasks);

		const after = loadRunManifestById(manifest.cwd, manifest.runId)!;
		const groupTask = after.tasks.find((t) => t.id === GROUP_ID)!;
		assert.equal(groupTask.status, "cancelled", "disk-terminal group task must not be flipped by the repair write");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
