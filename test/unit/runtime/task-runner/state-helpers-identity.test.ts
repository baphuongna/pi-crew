/**
 * state-helpers-identity.test.ts — fix-wave 11a (F3) pins.
 *
 * Persisting the spawn-time process identity (pgid/starttime/uid) must be
 * ADDITIVE: a checkpoint or heartbeat written before this wave has none of the
 * new keys, and one written after it carries them only when they are known.
 *
 * Pinned here:
 *   1. `checkpointTask` without an identity argument keeps the pre-wave record
 *      shape exactly (no `childPgid` / `childStartTime` / `childUid` keys),
 *   2. `checkpointTask` with a `ProcIdentity` spreads the three fields and
 *      still carries the pid,
 *   3. a LEGACY record (no identity fields) stays a valid `TaskCheckpointState`
 *      and flows through the read path (`collectWorkerPidEvidence` → pid-only
 *      evidence) without error,
 *   4. `touchWorkerHeartbeat` accepts the identity fields additively and keeps
 *      a pre-wave heartbeat field-for-field unchanged when none are supplied.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../../../../src/runtime/heartbeat/worker-heartbeat.ts";
import { collectWorkerPidEvidence } from "../../../../src/runtime/process/orphan-reaper.ts";
import { checkpointTask } from "../../../../src/runtime/task-runner/state-helpers.ts";
import { flushPendingAtomicWrites } from "../../../../src/state/atomic-write.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TaskCheckpointState, TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";
import { resolveCanonicalDir } from "../../../fixtures/test-tempdir.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "s1", role: "executor", task: "Do {goal}" }],
};

function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return resolveCanonicalDir(dir);
}

async function withIsolatedHome<T>(fn: () => T | Promise<T>): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeTempDir("pi-crew-f3-home-");
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		await removeDirWithRetry(home);
	}
}

function makeTask(id: string, runId: string, overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		runId,
		title: `fixture task ${id}`,
		stepId: `step-${id}`,
		role: "executor",
		agent: "executor",
		status: "running",
		createdAt: "2026-10-24T00:00:00.000Z",
		updatedAt: "2026-10-24T00:00:00.000Z",
		...overrides,
	} as TeamTaskState;
}

test("(f3-1) checkpointTask without identity keeps the legacy record shape", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-f3-1-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "f3-1 legacy checkpoint shape" });
			const task = makeTask("T", created.manifest.runId);
			const { task: next } = checkpointTask(created.manifest, [task], task, "child-spawned", 4242);
			flushPendingAtomicWrites();
			assert.equal(next.checkpoint?.childPid, 4242);
			assert.deepEqual(
				Object.keys(next.checkpoint ?? {}).sort(),
				["childPid", "phase", "updatedAt"],
				"no identity keys may appear when the caller passes none",
			);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("(f3-2) checkpointTask spreads a known identity", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-f3-2-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "f3-2 identity spread" });
			const task = makeTask("T", created.manifest.runId);
			const { task: next } = checkpointTask(created.manifest, [task], task, "child-spawned", 4242, {
				pid: 4242,
				pgid: 4242,
				starttime: "998877",
				uid: 1000,
			});
			flushPendingAtomicWrites();
			assert.equal(next.checkpoint?.childPid, 4242);
			assert.equal(next.checkpoint?.childPgid, 4242);
			assert.equal(next.checkpoint?.childStartTime, "998877");
			assert.equal(next.checkpoint?.childUid, 1000);
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("(f3-3) a legacy checkpoint/heartbeat record stays valid and yields pid-only evidence", () => {
	// Exactly what a pre-wave tasks.json carries — no identity keys at all.
	const legacyCheckpoint: TaskCheckpointState = {
		phase: "child-spawned",
		updatedAt: "2026-01-01T00:00:00.000Z",
		childPid: 5151,
	};
	const legacyHeartbeat = { workerId: "T2", pid: 6161, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true };
	const evidence = collectWorkerPidEvidence([
		makeTask("T1", "team_fixture_run", { checkpoint: legacyCheckpoint }),
		makeTask("T2", "team_fixture_run", { heartbeat: legacyHeartbeat }),
	]);
	assert.deepEqual(evidence, [
		{ taskId: "T1", pid: 5151 },
		{ taskId: "T2", pid: 6161 },
	]);
});

test("(f3-4) touchWorkerHeartbeat carries the identity fields additively", () => {
	const created = createWorkerHeartbeat("T3", 7171);
	const stamped = touchWorkerHeartbeat(created, { pgid: 7171, starttime: "1234", uid: 1000 });
	assert.equal(stamped.pid, 7171, "pid must survive the touch");
	assert.equal(stamped.pgid, 7171);
	assert.equal(stamped.starttime, "1234");
	assert.equal(stamped.uid, 1000);
	// A pre-wave heartbeat (no identity fields) still round-trips unchanged.
	const plain = touchWorkerHeartbeat(createWorkerHeartbeat("T4", 8181), { alive: false });
	assert.deepEqual(Object.keys(plain).sort(), ["alive", "lastSeenAt", "pid", "workerId"]);
});

test("(f3-5) MAJOR #4: a later phase transition CARRIES the spawn-time identity over", () => {
	// checkpointTask is called again for "child-stdout-final" / "artifact-written"
	// with NO identity argument. Pre-fix those calls rebuilt the checkpoint from
	// scratch and silently dropped childPgid/childStartTime/childUid, so the
	// pid-proof F3 persists was gone exactly when a reaper needs it.
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-f3-5-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "f3-5 identity carry-over" });
			const task = makeTask("T", created.manifest.runId);
			const spawned = checkpointTask(created.manifest, [task], task, "child-spawned", 4242, {
				pid: 4242,
				pgid: 4242,
				starttime: "998877",
				uid: 1000,
			});
			const later = checkpointTask(created.manifest, spawned.tasks, spawned.task, "child-stdout-final");
			flushPendingAtomicWrites();
			assert.equal(later.task.checkpoint?.phase, "child-stdout-final");
			assert.equal(later.task.checkpoint?.childPid, 4242, "childPid must still carry over");
			assert.equal(later.task.checkpoint?.childPgid, 4242, "childPgid must carry over (was erased)");
			assert.equal(later.task.checkpoint?.childStartTime, "998877", "childStartTime must carry over (was erased)");
			assert.equal(later.task.checkpoint?.childUid, 1000, "childUid must carry over (was erased)");
			// An explicit new identity still overrides the carried one field-by-field.
			const overridden = checkpointTask(created.manifest, later.tasks, later.task, "child-spawned", 5252, {
				pid: 5252,
				pgid: 5252,
				starttime: "123123",
				uid: undefined,
			});
			assert.equal(overridden.task.checkpoint?.childPid, 5252);
			assert.equal(overridden.task.checkpoint?.childPgid, 5252);
			assert.equal(overridden.task.checkpoint?.childStartTime, "123123");
			// MINOR #6: a DIFFERENT child pid must never inherit the previous
			// incarnation's identity — an old starttime paired with a new pid is a
			// false pid proof (it would refuse the real child, or match a stranger).
			assert.equal(overridden.task.checkpoint?.childUid, undefined, "a new child pid must not carry the old child's uid over");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});

test("(f3-6) MINOR #6: identity is carried over ONLY while childPid is unchanged", () => {
	withIsolatedHome(async () => {
		const cwd = makeTempDir("pi-crew-f3-6-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "f3-6 identity carry-over scope" });
			const task = makeTask("T", created.manifest.runId);
			const spawned = checkpointTask(created.manifest, [task], task, "child-spawned", 4242, {
				pid: 4242,
				pgid: 4242,
				starttime: "998877",
				uid: 1000,
			});
			// Same child, later phase, no arguments ⇒ everything carries over.
			const sameChild = checkpointTask(created.manifest, spawned.tasks, spawned.task, "artifact-written");
			assert.equal(sameChild.task.checkpoint?.childPid, 4242);
			assert.equal(sameChild.task.checkpoint?.childStartTime, "998877");
			assert.equal(sameChild.task.checkpoint?.childUid, 1000);

			// Re-spawn: a NEW pid with no identity argument ⇒ the stale identity is
			// DROPPED (never paired with the new pid).
			const respawned = checkpointTask(created.manifest, sameChild.tasks, sameChild.task, "started", 5252);
			flushPendingAtomicWrites();
			assert.equal(respawned.task.checkpoint?.childPid, 5252);
			assert.equal(respawned.task.checkpoint?.childPgid, undefined, "old pgid must not survive a new child pid");
			assert.equal(respawned.task.checkpoint?.childStartTime, undefined, "old starttime must not survive a new child pid");
			assert.equal(respawned.task.checkpoint?.childUid, undefined, "old uid must not survive a new child pid");
		} finally {
			await removeDirWithRetry(cwd);
		}
	});
});
