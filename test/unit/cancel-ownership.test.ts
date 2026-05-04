import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { abortOwned, handleCancel } from "../../src/extension/team-tool/cancel.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/state-store.ts";

function createOwnedRun(ownerSessionId: string): { cwd: string; runId: string; manifest: ReturnType<typeof createRunManifest>["manifest"] } {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cancel-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = { name: "cancel", description: "", roles: [{ name: "worker", agent: "worker" }], source: "test", filePath: "builtin" } as never;
	const workflow = { name: "wf", description: "", steps: [{ id: "one", role: "worker" }], source: "test", filePath: "builtin" } as never;
	const created = createRunManifest({ cwd, team, workflow, goal: "cancel", ownerSessionId });
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

describe("abortOwned", () => {
	it("returns missing IDs when run not found", () => {
		const result = abortOwned("nonexistent-run", ["t1", "t2"], { cwd: process.cwd() });
		assert.deepEqual(result, { abortedIds: [], missingIds: ["t1", "t2"], foreignIds: [] });
	});

	it("returns empty when no task IDs specified and run not found", () => {
		const result = abortOwned("nonexistent-run", undefined, { cwd: process.cwd() });
		assert.deepEqual(result, { abortedIds: [], missingIds: [], foreignIds: [] });
	});

	it("classifies tasks as foreign when session owner mismatches", () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [{ id: "task-1", runId: run.runId, role: "worker", agent: "worker", title: "task", status: "running", dependsOn: [], cwd: run.cwd }]);
			const result = abortOwned(run.runId, undefined, { cwd: run.cwd, sessionId: "session-b" });
			assert.deepEqual(result, { abortedIds: [], missingIds: [], foreignIds: ["task-1"] });
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("handleCancel refuses to cancel a foreign owned run", () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [{ id: "task-1", runId: run.runId, role: "worker", agent: "worker", title: "task", status: "running", dependsOn: [], cwd: run.cwd }]);
			const out = handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-b" });
			assert.equal(out.isError, true);
			assert.equal(loadRunManifestById(run.cwd, run.runId)?.tasks[0]?.status, "running");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});
