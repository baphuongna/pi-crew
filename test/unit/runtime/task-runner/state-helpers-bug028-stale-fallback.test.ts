/**
 * bug-028 regression: persistSingleTaskUpdate must NEVER write sibling tasks
 * from the caller's (possibly dispatch-time stale) fallbackTasks snapshot.
 *
 * Timeline from the 4th ubuntu-CI failure of implementation-fanout (PR #46,
 * 2026-08-16): three parallel singleton units (05/06/07) all share ONE
 * dispatch-time snapshot (dispatch-batch.ts baseInput.tasks = ctx.tasks).
 * 06 and 07 terminal-persisted their own completions to disk. Then the
 * LAST unit (05) terminal-persisted with its stale fallback — the old
 * attempt-0 "F4 perf shortcut" (state-helpers.ts) wrote the FULL array
 * [05c, 06r, 07r] over disk [06c, 07c], resurrecting the siblings to
 * "running". The subsequent merge read the corrupt disk, finalize's
 * bug-027 heal had nothing terminal to heal (disk itself was corrupt),
 * and the run finalized as blocked "Task '06' is still running.".
 *
 * The mtime CAS cannot catch this class: it only detects writers between
 * function entry and the in-lock stat — not fallback staleness that
 * predates entry. Fix: ALWAYS load committed tasks from disk inside the
 * lock; `updated` still wins for THIS task via updateTask.
 *
 * Deterministic by construction — no timing, no child processes.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { persistSingleTaskUpdate } from "../../../../src/runtime/task-runner/state-helpers.ts";
import { flushPendingAtomicWrites } from "../../../../src/state/atomic-write.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

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
	return dir;
}

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeTempDir("pi-crew-bug028-home-");
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

function makeTask(id: string, status: TeamTaskState["status"], overrides: Partial<TeamTaskState> = {}): TeamTaskState {
	return {
		id,
		stepId: `step-${id}`,
		role: "executor",
		agent: "executor",
		status,
		createdAt: "2026-08-16T00:00:00.000Z",
		updatedAt: "2026-08-16T00:00:00.000Z",
		...overrides,
	} as TeamTaskState;
}

test("bug-028: last-settling unit's stale fallback must not resurrect disk-terminal siblings", () => {
	withIsolatedHome(() => {
		const cwd = makeTempDir("pi-crew-bug028-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "bug-028 stale fallback" });
			// Durable truth on disk BEFORE the last unit persists: A and B are
			// terminal (their own post-execution persists landed, lock-serialized),
			// C is still running from the dispatch view.
			const diskTasks = [
				makeTask("A", "completed", {
					finishedAt: "2026-08-16T00:00:01.000Z",
					resultArtifact: { path: "/tmp/a.txt", kind: "result" } as never,
				}),
				makeTask("B", "completed", {
					finishedAt: "2026-08-16T00:00:02.000Z",
					resultArtifact: { path: "/tmp/b.txt", kind: "result" } as never,
				}),
				makeTask("C", "running"),
			];
			saveRunTasks(created.manifest, diskTasks);

			// The LAST unit (C) terminal-persists with its fallback = the
			// DISPATCH-TIME snapshot + only its own update: A/B still "running"
			// there. This is exactly updateTask(staleSnapshot, C-completed).
			const staleFallback = [
				makeTask("A", "running"),
				makeTask("B", "running"),
				makeTask("C", "completed", {
					finishedAt: "2026-08-16T00:00:03.000Z",
					resultArtifact: { path: "/tmp/c.txt", kind: "result" } as never,
				}),
			];
			const updatedC = staleFallback[2]!;

			const out = persistSingleTaskUpdate(created.manifest, staleFallback, updatedC, undefined, true);
			flushPendingAtomicWrites();

			const disk = loadRunManifestById(cwd, created.manifest.runId)?.tasks;
			assert.ok(disk, "tasks.json must exist after persist");
			const byId = new Map(disk.map((t) => [t.id, t] as const));
			assert.equal(byId.get("C")?.status, "completed", "C's own terminal update must persist");
			// The assertion that FAILED pre-fix (attempt-0 wrote [Ar, Br, Cc]):
			assert.equal(byId.get("A")?.status, "completed", "disk-terminal sibling A must NOT be resurrected to running");
			assert.equal(byId.get("B")?.status, "completed", "disk-terminal sibling B must NOT be resurrected to running");
			assert.equal(byId.get("C")?.finishedAt, "2026-08-16T00:00:03.000Z", "C's finishedAt survives");
			// The returned array matches disk (no in-memory resurrection either).
			const outById = new Map(out.map((t) => [t.id, t] as const));
			assert.equal(outById.get("A")?.status, "completed", "returned array keeps disk truth for A");
			assert.equal(outById.get("B")?.status, "completed", "returned array keeps disk truth for B");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
