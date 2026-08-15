import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCancel, handleRetry } from "../../../../src/extension/team-tool/cancel.ts";
import { handleCleanup, handleForget } from "../../../../src/extension/team-tool/lifecycle-actions.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { clearHooksScoped, registerHook } from "../../../../src/hooks/registry.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunTasks, updateRunStatus } from "../../../../src/state/stores/state-store.ts";

function createRun(ownerSessionId = "session-a"): {
	cwd: string;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-hooks-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "hooks",
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
		goal: "hooks-test",
		ownerSessionId,
	});
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

describe("before_cancel hook", () => {
	beforeEach(() => clearHooksScoped());
	afterEach(() => clearHooksScoped());

	it("allows cancel when hook outcome is allow", async () => {
		const run = createRun();
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
			registerHook({
				name: "before_cancel",
				mode: "blocking",
				handler: async () => ({ outcome: "allow" as const }),
			});
			const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, false);
			assert.equal(loadRunManifestById(run.cwd, run.runId)?.manifest.status, "cancelled");
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(
				events.some((e) => e.type === "hook.executed" && e.data?.hookName === "before_cancel" && e.data?.outcome === "allow"),
			);
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("does NOT flip to cancelled when the run completed on disk during the before_cancel hook gap (R13-2)", async () => {
		const run = createRun();
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
			// Put the run in a cancellable (non-terminal) state before cancel is invoked.
			updateRunStatus(run.manifest, "running", "started");
			registerHook({
				name: "before_cancel",
				mode: "blocking",
				handler: async () => {
					// Concurrent writer: complete the run + task on disk while handleCancel
					// is inside the (unbounded) hook gap. A stale-snapshot cancel would
					// then flip the terminal status back to "cancelled".
					updateRunStatus(loadRunManifestById(run.cwd, run.runId)!.manifest, "completed", "completed by concurrent writer");
					saveRunTasks(
						loadRunManifestById(run.cwd, run.runId)!.manifest,
						loadRunManifestById(run.cwd, run.runId)!.tasks.map((t) => ({ ...t, status: "completed" as const })),
					);
					return { outcome: "allow" as const };
				},
			});
			const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, false);
			assert.match(textFromToolResult(out), /already completed/);
			// Disk must still be "completed" — NOT flipped back to "cancelled", and the
			// completed task must NOT be resurrected.
			const after = loadRunManifestById(run.cwd, run.runId)!;
			assert.equal(after.manifest.status, "completed");
			assert.equal(after.tasks[0].status, "completed");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("aborts cancel when ownership moves to another session on disk during the before_cancel hook gap (in-lock re-check)", async () => {
		const run = createRun();
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
			updateRunStatus(run.manifest, "running", "started");
			registerHook({
				name: "before_cancel",
				mode: "blocking",
				handler: async () => {
					// Concurrent writer: ownership moves to another session on disk
					// while handleCancel is inside the (unbounded) hook gap. The
					// PRE-lock check (abortOwned on the stale `loaded` snapshot) passed;
					// only the IN-lock abortOwned on the fresh manifest can catch it.
					const current = loadRunManifestById(run.cwd, run.runId)!;
					saveRunManifest({ ...current.manifest, ownerSessionId: "session-b" });
					return { outcome: "allow" as const };
				},
			});
			const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /belongs to another session/);
			// The foreign-session cancel must NOT have cancelled the task or flipped the run.
			const after = loadRunManifestById(run.cwd, run.runId)!;
			assert.equal(after.tasks[0].status, "running");
			assert.equal(after.manifest.status, "running");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("blocks cancel when hook outcome is block", async () => {
		const run = createRun();
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
			registerHook({
				name: "before_cancel",
				mode: "blocking",
				handler: async () => ({
					outcome: "block" as const,
					reason: "Maintenance window",
				}),
			});
			const out = await handleCancel({ action: "cancel", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /Maintenance window/);
			assert.equal(loadRunManifestById(run.cwd, run.runId)?.manifest.status, "queued");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("before_forget hook", () => {
	beforeEach(() => clearHooksScoped());
	afterEach(() => clearHooksScoped());

	it("allows forget when hook outcome is allow", async () => {
		const run = createRun();
		const stateRoot = run.manifest.stateRoot;
		const artifactsRoot = run.manifest.artifactsRoot;
		try {
			registerHook({
				name: "before_forget",
				mode: "blocking",
				handler: async () => ({ outcome: "allow" as const }),
			});
			const out = await handleForget({ action: "forget", runId: run.runId, confirm: true }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, false);
			assert.ok(!fs.existsSync(stateRoot));
			assert.ok(!fs.existsSync(artifactsRoot));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("blocks forget when hook outcome is block", async () => {
		const run = createRun();
		try {
			registerHook({
				name: "before_forget",
				mode: "blocking",
				handler: async () => ({
					outcome: "block" as const,
					reason: "Audit hold",
				}),
			});
			const out = await handleForget({ action: "forget", runId: run.runId, confirm: true }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /Audit hold/);
			assert.ok(fs.existsSync(run.manifest.stateRoot));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("before_retry hook gap regression (R13-1)", () => {
	beforeEach(() => clearHooksScoped());
	afterEach(() => clearHooksScoped());

	it("does NOT clobber a run completed on disk during the before_retry hook gap", async () => {
		const run = createRun();
		try {
			saveRunTasks(run.manifest, [
				{
					id: "task-1",
					runId: run.runId,
					role: "worker",
					agent: "worker",
					title: "task",
					status: "failed",
					dependsOn: [],
					cwd: run.cwd,
					finishedAt: "2026-08-13T00:00:00.000Z",
					error: "original failure",
					terminalEvidence: [
						{
							operation: "worker" as const,
							status: "failed" as const,
							finishedAt: "2026-08-13T00:00:00.000Z",
							reason: { code: "exec_failed", message: "original failure" },
						},
					],
				},
			]);
			updateRunStatus(run.manifest, "running", "started");
			registerHook({
				name: "before_retry",
				mode: "blocking",
				handler: async () => {
					// Concurrent writer: complete the run + task on disk while handleRetry
					// is inside the (unbounded) hook gap. A stale-snapshot retry would
					// rewrite the completed task back to "queued" and destroy terminal
					// evidence (R13-1 clobber).
					updateRunStatus(loadRunManifestById(run.cwd, run.runId)!.manifest, "completed", "completed by concurrent writer");
					saveRunTasks(
						loadRunManifestById(run.cwd, run.runId)!.manifest,
						loadRunManifestById(run.cwd, run.runId)!.tasks.map((t) => ({
							...t,
							status: "completed" as const,
							finishedAt: "2026-08-13T00:01:00.000Z",
							terminalEvidence: [
								...(t.terminalEvidence ?? []),
								{
									operation: "worker" as const,
									status: "completed" as const,
									finishedAt: "2026-08-13T00:01:00.000Z",
									reason: { code: "concurrent", message: "completed by concurrent writer" },
								},
							],
						})),
					);
					return { outcome: "allow" as const };
				},
			});
			const out = await handleRetry({ action: "retry", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /already completed/);
			// Disk must preserve the terminal state: run completed + task completed
			// with its terminal evidence — NOT resurrected to "queued".
			const after = loadRunManifestById(run.cwd, run.runId)!;
			assert.equal(after.manifest.status, "completed");
			assert.equal(after.tasks[0].status, "completed");
			assert.equal(after.tasks[0].finishedAt, "2026-08-13T00:01:00.000Z");
			assert.ok(after.tasks[0].terminalEvidence?.some((e) => e.status === "completed"));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("before_retry ownership re-check (Security S1)", () => {
	beforeEach(() => clearHooksScoped());
	afterEach(() => clearHooksScoped());

	function createFailedRun(): ReturnType<typeof createRun> {
		const run = createRun("session-a");
		saveRunTasks(run.manifest, [
			{
				id: "task-1",
				runId: run.runId,
				role: "worker",
				agent: "worker",
				title: "task",
				status: "failed",
				dependsOn: [],
				cwd: run.cwd,
				finishedAt: "2026-08-13T00:00:00.000Z",
				error: "original failure",
			},
		]);
		updateRunStatus(run.manifest, "running", "started");
		return run;
	}

	it("aborts retry when ownership moves to another session on disk during the hook gap (in-lock re-check is authoritative)", async () => {
		const run = createFailedRun();
		try {
			registerHook({
				name: "before_retry",
				mode: "blocking",
				handler: async () => {
					// Concurrent writer: ownership moves to another session on disk
					// while handleRetry is inside the (unbounded) hook gap. The
					// PRE-lock check ran on the stale `loaded` snapshot (still
					// session-a) and passed; only the IN-lock re-check on the fresh
					// manifest can catch the ownership change (Security S1).
					const current = loadRunManifestById(run.cwd, run.runId)!;
					saveRunManifest({ ...current.manifest, ownerSessionId: "session-b" });
					return { outcome: "allow" as const };
				},
			});
			const out = await handleRetry({ action: "retry", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /belongs to another session/);
			// The foreign-session retry must NOT have re-queued the task.
			const after = loadRunManifestById(run.cwd, run.runId)!;
			assert.equal(after.tasks[0].status, "failed");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("proceeds with force:true even when ownership moved during the hook gap", async () => {
		const run = createFailedRun();
		try {
			registerHook({
				name: "before_retry",
				mode: "blocking",
				handler: async () => {
					const current = loadRunManifestById(run.cwd, run.runId)!;
					saveRunManifest({ ...current.manifest, ownerSessionId: "session-b" });
					return { outcome: "allow" as const };
				},
			});
			const out = await handleRetry(
				{ action: "retry", runId: run.runId, force: true },
				{ cwd: run.cwd, sessionId: "session-a" },
			);
			assert.equal(out.isError, false);
			// force:true bypasses the ownership gate; the retry re-queues the task.
			const after = loadRunManifestById(run.cwd, run.runId)!;
			assert.equal(after.tasks[0].status, "queued");
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("before_cleanup hook", () => {
	beforeEach(() => clearHooksScoped());
	afterEach(() => clearHooksScoped());

	it("allows cleanup when hook outcome is allow", async () => {
		const run = createRun();
		try {
			registerHook({
				name: "before_cleanup",
				mode: "blocking",
				handler: async () => ({ outcome: "allow" as const }),
			});
			const out = await handleCleanup(
				{ action: "cleanup", runId: run.runId, confirm: true },
				{ cwd: run.cwd, sessionId: "session-a" },
			);
			assert.equal(out.isError, false);
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(
				events.some((e) => e.type === "hook.executed" && e.data?.hookName === "before_cleanup" && e.data?.outcome === "allow"),
			);
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("blocks cleanup when hook outcome is block", async () => {
		const run = createRun();
		try {
			registerHook({
				name: "before_cleanup",
				mode: "blocking",
				handler: async () => ({
					outcome: "block" as const,
					reason: "Active worktrees",
				}),
			});
			const out = await handleCleanup(
				{ action: "cleanup", runId: run.runId, confirm: true },
				{ cwd: run.cwd, sessionId: "session-a" },
			);
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /Active worktrees/);
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});
