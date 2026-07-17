import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleCancel } from "../../src/extension/team-tool/cancel.ts";
import { handleCleanup, handleForget } from "../../src/extension/team-tool/lifecycle-actions.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";
import { clearHooks, registerHook } from "../../src/hooks/registry.ts";
import { readEvents } from "../../src/state/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../src/state/state-store.ts";

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
	beforeEach(() => clearHooks());
	afterEach(() => clearHooks());

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
	beforeEach(() => clearHooks());
	afterEach(() => clearHooks());

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

describe("before_cleanup hook", () => {
	beforeEach(() => clearHooks());
	afterEach(() => clearHooks());

	it("allows cleanup when hook outcome is allow", async () => {
		const run = createRun();
		try {
			registerHook({
				name: "before_cleanup",
				mode: "blocking",
				handler: async () => ({ outcome: "allow" as const }),
			});
			const out = await handleCleanup({ action: "cleanup", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
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
			const out = await handleCleanup({ action: "cleanup", runId: run.runId }, { cwd: run.cwd, sessionId: "session-a" });
			assert.equal(out.isError, true);
			assert.match(textFromToolResult(out), /Active worktrees/);
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});
