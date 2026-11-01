/**
 * R4-A1 (deep-review wave-1): respond-path agent-record retention pin.
 *
 * `handleRespond` requeues a waiting task whose worker is dead and rewrites
 * agents.json for the requeued task. The pre-fix code persisted only the
 * requeued subset (full-index overwrite ⇒ sibling agent records wiped,
 * team-runner.ts:525 subset-save bug twin). The fix merges the requeued
 * records into the existing index. This test pins the merged contract:
 * 2 sibling records + 1 requeued waiting task ⇒ agents.json retains ALL.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleRespond } from "../../../../src/extension/team-tool/respond.ts";
import { readCrewAgents, recordFromTask, saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { clearLiveAgentsForTest } from "../../../../src/runtime/live-session/live-agent-manager.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

function createRun() {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-r4a1-respond-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "respond",
		description: "",
		roles: [{ name: "worker", agent: "worker" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const created = createRunManifest({ cwd, team, goal: "r4a1 respond retention" });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

function makeTask(id: string, status: TeamTaskState["status"], runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd,
	} as unknown as TeamTaskState;
}

test("R4-A1 respond path: requeueing a dead-worker waiting task retains ALL sibling agent records", async () => {
	clearLiveAgentsForTest();
	const run = createRun();
	try {
		const wait = makeTask("wait", "waiting", run.runId, run.cwd);
		const runningSibling = makeTask("sib_running", "running", run.runId, run.cwd);
		const doneSibling = makeTask("sib_done", "completed", run.runId, run.cwd);
		saveRunTasks(run.manifest, [wait, runningSibling, doneSibling]);

		// Seed agents.json with the two sibling records (the pre-wipe state).
		saveCrewAgents(run.manifest, [
			recordFromTask(run.manifest, runningSibling, "child-process"),
			recordFromTask(run.manifest, doneSibling, "child-process"),
		]);
		assert.equal(readCrewAgents(run.manifest).length, 2, "seed: exactly 2 sibling records on disk");

		// No pid + no live handle ⇒ worker dead ⇒ respond rides the requeue path.
		const out = await handleRespond({ action: "respond", runId: run.runId, taskId: "wait", message: "continue" }, { cwd: run.cwd });
		assert.equal(out.isError, false);

		const loaded = loadRunManifestById(run.cwd, run.runId);
		assert.ok(loaded);
		assert.equal(loaded.tasks.find((t) => t.id === "wait")?.status, "queued");

		// R4-A1 pin: agents.json retains ALL records after the respond requeue.
		const records = readCrewAgents(loaded.manifest);
		const byTaskId = new Map(records.map((r) => [r.taskId, r]));
		assert.equal(records.length, 3, "ALL 3 records must be retained (2 siblings + 1 requeued)");
		assert.equal(byTaskId.get("sib_running")?.status, "running", "running sibling record survives");
		assert.equal(byTaskId.get("sib_done")?.status, "completed", "completed sibling record survives");
		assert.equal(byTaskId.get("wait")?.status, "queued", "requeued task gets a fresh record");
	} finally {
		await removeDirWithRetry(run.cwd);
	}
});
