import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { abortOwned, handleCancel } from "../../src/extension/team-tool/cancel.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/state-store.ts";

function createOwnedRun(ownerSessionId: string): {
	cwd: string;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cancel-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "cancel",
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
	const created = createRunManifest({
		cwd,
		team,
		workflow,
		goal: "cancel",
		ownerSessionId,
	});
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

describe("abortOwned", () => {
	it("returns missing IDs when run not found", () => {
		const result = abortOwned("nonexistent-run", ["t1", "t2"], {
			cwd: process.cwd(),
		});
		assert.deepEqual(result, {
			abortedIds: [],
			missingIds: ["t1", "t2"],
			foreignIds: [],
		});
	});

	it("returns empty when no task IDs specified and run not found", () => {
		const result = abortOwned("nonexistent-run", undefined, {
			cwd: process.cwd(),
		});
		assert.deepEqual(result, {
			abortedIds: [],
			missingIds: [],
			foreignIds: [],
		});
	});

	it("classifies tasks as foreign when session owner mismatches", () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "running",
					dependsOn: [],
					cwd: run.cwd,
				},
			]);
			const result = abortOwned(run.runId, undefined, {
				cwd: run.cwd,
				sessionId: "session-b",
			});
			assert.deepEqual(result, {
				abortedIds: [],
				missingIds: [],
				foreignIds: ["task-1"],
			});
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("requires force to be the literal boolean true for foreign tasks", () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "running",
					dependsOn: [],
					cwd: run.cwd,
				},
			]);
			const truthyResult = abortOwned(run.runId, undefined, { cwd: run.cwd, sessionId: "session-b" }, "true" as never);
			assert.deepEqual(truthyResult, {
				abortedIds: [],
				missingIds: [],
				foreignIds: ["task-1"],
			});
			const explicitResult = abortOwned(run.runId, undefined, { cwd: run.cwd, sessionId: "session-b" }, true);
			assert.deepEqual(explicitResult, {
				abortedIds: ["task-1"],
				missingIds: [],
				foreignIds: [],
			});
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("handleCancel records structured cancellation reason", async () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "running",
					dependsOn: [],
					cwd: run.cwd,
				},
			]);
			const out = await handleCancel(
				{
					action: "cancel",
					runId: run.runId,
					config: {
						reason: {
							code: "leader_interrupted",
							message: "leader stopped run",
						},
					},
				},
				{ cwd: run.cwd, sessionId: "session-a" },
			);
			assert.equal(out.isError, false);
			const loaded = loadRunManifestById(run.cwd, run.runId);
			assert.equal(loaded?.manifest.status, "cancelled");
			assert.match(loaded?.manifest.summary ?? "", /leader_interrupted/);
			assert.match(loaded?.tasks[0]?.error ?? "", /leader stopped run/);
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(
				events.some(
					(event) => event.type === "task.cancelled" && event.taskId === "task-1" && event.data?.reason === "leader_interrupted",
				),
			);
			assert.ok(events.some((event) => event.type === "run.cancelled" && event.data?.reason === "leader_interrupted"));
			assert.ok((loaded?.tasks[0]?.terminalEvidence?.length ?? 0) > 0);
			assert.equal(loaded?.tasks[0]?.terminalEvidence?.[0]?.operation, "worker");
			assert.equal(loaded?.tasks[0]?.terminalEvidence?.[0]?.status, "cancelled");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("handleCancel records audit intent on cancellation events", async () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "running",
					dependsOn: [],
					cwd: run.cwd,
				},
			]);
			const out = await handleCancel(
				{
					action: "cancel",
					runId: run.runId,
					config: {
						reason: "shutdown",
						intent: "operator is ending the session for maintenance",
					},
				},
				{ cwd: run.cwd, sessionId: "session-a" },
			);
			assert.equal(out.isError, false);
			assert.equal(out.details.intent, "operator is ending the session for maintenance");
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(
				events.some(
					(event) =>
						event.type === "task.cancelled" &&
						event.taskId === "task-1" &&
						event.data?.reason === "shutdown" &&
						event.data.intent === "operator is ending the session for maintenance",
				),
			);
			assert.ok(
				events.some(
					(event) =>
						event.type === "run.cancelled" &&
						event.data?.reason === "shutdown" &&
						event.data.intent === "operator is ending the session for maintenance",
				),
			);
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("handleCancel refuses to cancel a foreign owned run", async () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "running",
					dependsOn: [],
					cwd: run.cwd,
				},
			]);
			const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-b" });
			assert.equal(out.isError, true);
			assert.equal(loadRunManifestById(run.cwd, run.runId)?.tasks[0]?.status, "running");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("handleCancel rejects a truthy non-boolean force value for a foreign run", async () => {
		const run = createOwnedRun("session-a");
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "running",
					dependsOn: [],
					cwd: run.cwd,
				},
			]);
			const out = await handleCancel(
				{ action: "cancel", runId: run.runId, force: "true" as never },
				{ cwd: run.cwd, sessionId: "session-b" },
			);
			assert.equal(out.isError, true);
			assert.equal(loadRunManifestById(run.cwd, run.runId)?.tasks[0]?.status, "running");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});
