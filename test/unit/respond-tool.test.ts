import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleRespond } from "../../src/extension/team-tool/respond.ts";
import { readMailbox } from "../../src/state/mailbox.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/state-store.ts";

function createRun(): { cwd: string; runId: string; manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-respond-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = { name: "respond", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "respond" });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

test("handleRespond writes task mailbox and resumes only waiting task", () => {
	const run = createRun();
	try {
		saveRunTasks(run.manifest, [
			{ id: "wait", runId: run.runId, role: "worker", agent: "worker", title: "wait", status: "waiting", dependsOn: [], cwd: run.cwd },
			{ id: "done", runId: run.runId, role: "worker", agent: "worker", title: "done", status: "completed", dependsOn: [], cwd: run.cwd },
		]);
		const out = handleRespond({ action: "respond", runId: run.runId, taskId: "wait", message: "continue" }, { cwd: run.cwd });
		assert.equal(out.isError, false);
		const loaded = loadRunManifestById(run.cwd, run.runId);
		assert.equal(loaded?.tasks.find((task) => task.id === "wait")?.status, "running");
		assert.equal(loaded?.tasks.find((task) => task.id === "done")?.status, "completed");
		const mailbox = readMailbox(run.manifest, "inbox", "wait");
		assert.equal(mailbox.length, 1);
		assert.equal(mailbox[0]?.body, "continue");
		assert.equal(mailbox[0]?.taskId, "wait");
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});

test("handleRespond rejects non-waiting task", () => {
	const run = createRun();
	try {
		saveRunTasks(run.manifest, [
			{ id: "done", runId: run.runId, role: "worker", agent: "worker", title: "done", status: "completed", dependsOn: [], cwd: run.cwd },
		]);
		const out = handleRespond({ action: "respond", runId: run.runId, taskId: "done", message: "continue" }, { cwd: run.cwd });
		assert.equal(out.isError, true);
		const first = out.content[0] as { text?: string } | undefined;
		assert.match(first?.text ?? "", /not waiting/);
		assert.equal(readMailbox(run.manifest, "inbox", "done").length, 0);
	} finally {
		fs.rmSync(run.cwd, { recursive: true, force: true });
	}
});
