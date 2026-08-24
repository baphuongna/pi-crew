/**
 * PERF (2026-08-24) task 4 — sweepExpiredWaitingTasks expiry-hint short-circuit.
 *
 * The sweep fires on every scheduler tick (runSchedulerSweeps, before batch
 * selection) and almost always finds nothing expired. The hint param lets the
 * scheduler pass the task view it already holds for this tick so the cheap
 * expiry predicate runs BEFORE the stat+parse of manifest.json + tasks.json.
 *
 * Discriminating fixture (test 1): disk holds an ALREADY-EXPIRED waiting park
 * while the hint view still shows the task running (the broker persists parks
 * root-side under the run lock; the scheduler's in-memory view lags until the
 * next unit merge). The pre-hint code loads the manifest every sweep and would
 * requeue that park; the hint path must return undefined WITHOUT touching disk
 * — proven by the park surviving intact and no ask.timedout event firing.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { sweepExpiredWaitingTasks } from "../../../src/runtime/dispatch-batch.ts";
import { clearLiveAgentsForTest } from "../../../src/runtime/live-session/live-agent-manager.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";

/** Real on-disk run fixture (team-runner-extraction.test.ts pattern). Caller rmSync's cwd. */
function makeRunFixture(): { cwd: string; runId: string; manifest: TeamRunManifest } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-sweep-hint-"));
	// .crew marker scopes the run state INTO the temp cwd (respond-discriminator
	// pattern). Without it scopeBaseRoot falls back to the USER crew root and
	// the run leaks into ~/.pi/agent/extensions/pi-crew/state/runs/.
	fs.mkdirSync(path.join(cwd, ".crew"));
	const team = {
		name: "test-team",
		description: "",
		roles: [{ name: "executor", agent: "executor" }],
		source: "test",
		filePath: "builtin",
	} as unknown as TeamConfig;
	// No workflow → createRunManifest persists an empty task list; the test
	// persists its own tasks via saveRunTasks (extraction-test pattern).
	const created = createRunManifest({ cwd, team, goal: "sweep hint short-circuit" });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

/** Minimal TeamTaskState — only the fields the sweep reads (status/waiting/heartbeat). */
function makeTask(id: string, status: TeamTaskState["status"], overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		runId: "hint_run",
		stepId: "s1",
		role: "executor",
		agent: "executor",
		title: id,
		status,
		dependsOn: [],
		cwd: "/tmp/pi-crew-sweep-hint",
		graph: { taskId: id, children: [], dependencies: [], queue: "done" },
		...overrides,
	} as unknown as TeamTaskState;
}

/** A waiting park whose deadline is already `ageMs` past. No heartbeat ⇒ worker DEAD. */
function expiredPark(taskId: string, ageMs = 1_000): TeamTaskState {
	return makeTask(taskId, "waiting", {
		waiting: {
			questionId: randomUUID(),
			askedAt: new Date().toISOString(),
			deadline: Date.now() - ageMs,
		},
	});
}

test("hint with no expired waiting task short-circuits before the disk load", async () => {
	clearLiveAgentsForTest();
	const { cwd, runId, manifest } = makeRunFixture();
	try {
		// DISK truth: a parked task whose deadline is ALREADY expired. The
		// pre-hint code loads this every sweep and would requeue it.
		const parked = expiredPark("t1");
		saveRunTasks(manifest, [parked]);
		// The scheduler's in-memory view for this tick still shows the task
		// running — no waiting park, so nothing can be expired in the hint.
		const hint = [makeTask("t1", "running")];
		assert.equal(await sweepExpiredWaitingTasks(cwd, runId, Date.now(), hint), undefined);
		// No disk load ⇒ no side effects: the park survives, no ask.timedout event.
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded, "run must still load after the short-circuit");
		assert.equal(loaded.tasks.find((t) => t.id === "t1")?.status, "waiting", "parked task must be untouched");
		const eventsText = fs.readFileSync(loaded.manifest.eventsPath, "utf-8");
		assert.ok(!eventsText.includes('"ask.timedout"'), "no timeout event may be emitted from a hint-only pass");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("hint with expired waiting task proceeds to the locked sweep", async () => {
	clearLiveAgentsForTest();
	const { cwd, runId, manifest } = makeRunFixture();
	try {
		const parked = expiredPark("t1");
		saveRunTasks(manifest, [parked]);
		const sweep = await sweepExpiredWaitingTasks(cwd, runId, Date.now(), [parked]);
		assert.ok(sweep, "expired park in the hint must proceed past the predicate into the locked sweep");
		assert.deepEqual(sweep.requeuedTaskIds, ["t1"], "dead worker (no heartbeat, no live handle) ⇒ requeue");
		assert.deepEqual(sweep.timedOutQuestionIds, [parked.waiting?.questionId]);
		// Durable effect: the park was cleared and the task re-queued.
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded, "run must load after the sweep");
		const task = loaded.tasks.find((t) => t.id === "t1");
		assert.equal(task?.status, "queued");
		assert.equal(task?.waiting, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("missing manifest short-circuits to undefined on both the hint and no-hint paths", async () => {
	clearLiveAgentsForTest();
	const { cwd, runId, manifest } = makeRunFixture();
	try {
		const parked = expiredPark("t1");
		saveRunTasks(manifest, [parked]);
		// Manifest gone AFTER the hint array is captured: the hint-expired path
		// proceeds to the load, which finds nothing → undefined; the no-hint
		// path loads first and returns undefined too. Behavior parity.
		fs.rmSync(path.join(path.dirname(manifest.tasksPath), "manifest.json"));
		assert.equal(await sweepExpiredWaitingTasks(cwd, runId, Date.now(), [parked]), undefined);
		assert.equal(await sweepExpiredWaitingTasks(cwd, runId, Date.now()), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
