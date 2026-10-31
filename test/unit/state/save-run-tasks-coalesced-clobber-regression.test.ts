/**
 * ASK-PARK CLOBBER FIX (2026-10-31) — state-store regression (incident shape).
 *
 * Mirrors the live race end-to-end through the real store seams:
 *  1. HOST: saveRunTasksCoalesced (persistSingleTaskUpdate's non-terminal
 *     checkpoint path) buffers a `running` snapshot for 50ms — in the HOST
 *     process's per-process pendingAtomicWrites map.
 *  2. BROKER (external process): run-locked fresh load + sync saveRunTasks
 *     parks the task `waiting` + questionId marker. Its atomicWriteFile
 *     cancels pending coalesced writes only in ITS OWN process.
 *  3. HOST flush: previously a blind overwrite — tasks.json flipped back to
 *     `running` with the marker gone. With the flush-time staleness CAS the
 *     buffered snapshot is dropped and the park survives.
 *
 * The broker write is simulated with raw fs temp+rename (a same-process
 * atomicWriteJson would cancel the host buffer through the normal
 * same-process supersession path, bypassing the cross-process race).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { flushPendingAtomicWrites } from "../../../src/state/atomic-write.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks, saveRunTasksCoalesced } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";
import { removeDirWithRetry } from "../../helpers/rm-retry.ts";

function createRun(): { cwd: string; runId: string; manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-clobber-reg-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "clobber",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "wf",
		description: "",
		steps: [{ id: "one", role: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "clobber regression" });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

function runningTask(runId: string, cwd: string, phase: "started" | "child-spawned"): TeamTaskState {
	return {
		id: "asker",
		runId,
		role: "worker",
		agent: "worker",
		title: "asker",
		status: "running",
		dependsOn: [],
		cwd,
		checkpoint: { phase, updatedAt: new Date().toISOString() },
	};
}

/** Raw cross-process-style atomic write to the store's tasks.json. */
function externalTasksWrite(tasksPath: string, tasks: TeamTaskState[]): void {
	const tempPath = `${tasksPath}.external-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(tempPath, `${JSON.stringify(tasks)}\n`);
	fs.renameSync(tempPath, tasksPath);
}

test("coalesced running snapshot does not clobber an external waiting park (regression)", async (t) => {
	const run = createRun();
	t.after(async () => {
		flushPendingAtomicWrites();
		await removeDirWithRetry(run.cwd);
	});

	// Pre-park state on disk (this is the file identity the queue captures).
	saveRunTasks(run.manifest, [runningTask(run.runId, run.cwd, "started")]);

	// HOST: non-terminal checkpoint — buffered for the 50ms window.
	saveRunTasksCoalesced(run.manifest, [runningTask(run.runId, run.cwd, "child-spawned")]);

	// BROKER: external sync park — status waiting + questionId marker.
	externalTasksWrite(run.manifest.tasksPath, [
		{
			...runningTask(run.runId, run.cwd, "started"),
			status: "waiting",
			waiting: { questionId: "q-park", askedAt: new Date().toISOString(), deadline: Date.now() + 300_000 },
		},
	]);

	// HOST flush fires inside the coalesce window.
	flushPendingAtomicWrites(run.manifest.tasksPath);

	const loaded = loadRunManifestById(run.cwd, run.runId);
	assert.ok(loaded, "manifest must load after the race");
	const task = loaded.tasks.find((tk) => tk.id === "asker");
	assert.ok(task, "parked task must survive");
	assert.equal(task.status, "waiting", "external waiting park must survive the host coalesced flush");
	assert.equal(task.waiting?.questionId, "q-park", "questionId marker must survive");
});

test("control: without an external write the coalesced checkpoint still lands", async (t) => {
	const run = createRun();
	t.after(async () => {
		flushPendingAtomicWrites();
		await removeDirWithRetry(run.cwd);
	});

	saveRunTasks(run.manifest, [runningTask(run.runId, run.cwd, "started")]);
	saveRunTasksCoalesced(run.manifest, [runningTask(run.runId, run.cwd, "child-spawned")]);
	flushPendingAtomicWrites(run.manifest.tasksPath);

	const loaded = loadRunManifestById(run.cwd, run.runId);
	assert.ok(loaded, "manifest must load");
	const task = loaded.tasks.find((tk) => tk.id === "asker");
	assert.ok(task, "task must load");
	assert.equal(task.status, "running");
	assert.equal(task.checkpoint?.phase, "child-spawned", "coalesced latest checkpoint lands on flush");
});
