import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { clearHooksScoped, registerHook } from "../../../../src/hooks/registry.ts";
import { applyRecoveryPlan, declineRecoveryPlan } from "../../../../src/runtime/recovery/crash-recovery.ts";
import { readEvents } from "../../../../src/state/event-log/event-log.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks, updateRunStatus } from "../../../../src/state/stores/state-store.ts";

function createRecoveryRun(ownerSessionId = "session-a"): {
	cwd: string;
	runId: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
} {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-recovery-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	const team = {
		name: "recovery",
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
		goal: "recovery-test",
		ownerSessionId,
	});
	return { cwd, runId: created.manifest.runId, manifest: created.manifest };
}

describe("run_recovery hook", () => {
	beforeEach(() => clearHooksScoped());
	afterEach(() => clearHooksScoped());

	it("allows recovery when hook outcome is allow", async () => {
		const run = createRecoveryRun();
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
				name: "run_recovery",
				mode: "non_blocking",
				handler: async () => ({ outcome: "allow" as const }),
			});
			await applyRecoveryPlan(
				{
					runId: run.runId,
					resumableTasks: ["task-1"],
					preservedTasks: [],
					lastEventSeq: 0,
				},
				{ cwd: run.cwd },
			);
			const loaded = loadRunManifestById(run.cwd, run.runId);
			assert.equal(loaded?.tasks[0]?.status, "queued");
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(events.some((e) => e.type === "crew.run.resumed"));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("blocks recovery when hook outcome is block", async () => {
		const run = createRecoveryRun();
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
				name: "run_recovery",
				mode: "blocking",
				handler: async () => ({
					outcome: "block" as const,
					reason: "Maintenance window",
				}),
			});
			await applyRecoveryPlan(
				{
					runId: run.runId,
					resumableTasks: ["task-1"],
					preservedTasks: [],
					lastEventSeq: 0,
				},
				{ cwd: run.cwd },
			);
			const loaded = loadRunManifestById(run.cwd, run.runId);
			assert.equal(loaded?.tasks[0]?.status, "running");
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(events.some((e) => e.type === "crew.run.recovery_blocked"));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("records hook event in run event log", async () => {
		const run = createRecoveryRun();
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
				name: "run_recovery",
				mode: "non_blocking",
				handler: async () => ({ outcome: "allow" as const }),
			});
			await applyRecoveryPlan(
				{
					runId: run.runId,
					resumableTasks: ["task-1"],
					preservedTasks: [],
					lastEventSeq: 0,
				},
				{ cwd: run.cwd },
			);
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(events.some((e) => e.type === "hook.executed" && e.data?.hookName === "run_recovery"));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});

	it("R14-4: does not reset a run that completed concurrently during the run_recovery hook gap", async () => {
		const run = createRecoveryRun();
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
			// createRunManifest defaults to "queued" — move the run to "running" first
			// so the concurrent "completed" write during the hook gap is a legal
			// transition (running → completed).
			const runningManifest = updateRunStatus(run.manifest, "running", "run started");

			// Gate the run_recovery hook so applyRecoveryPlan suspends inside the hook
			// await — this is the arbitrary async gap R14-4 protects against.
			let hookStartedResolve!: () => void;
			let releaseHook!: () => void;
			const hookStarted = new Promise<void>((resolve) => {
				hookStartedResolve = resolve;
			});
			const hookGate = new Promise<void>((resolve) => {
				releaseHook = resolve;
			});
			registerHook({
				name: "run_recovery",
				mode: "non_blocking",
				handler: async () => {
					hookStartedResolve();
					await hookGate;
					return { outcome: "allow" as const };
				},
			});

			const plan = {
				runId: run.runId,
				resumableTasks: ["task-1"],
				preservedTasks: [],
				lastEventSeq: 0,
			};
			const recoveryPromise = applyRecoveryPlan(plan, { cwd: run.cwd });

			// Wait until the hook handler is entered (applyRecoveryPlan is now
			// suspended inside executeHook), then concurrently complete the run via a
			// direct state-store write — simulating a concurrent writer landing
			// between the pre-hook load and the post-hook save.
			await hookStarted;
			updateRunStatus(runningManifest, "completed", "concurrent completion");
			releaseHook();

			await recoveryPromise;

			const loaded = loadRunManifestById(run.cwd, run.runId);
			// Terminal run must NOT be reset: status stays terminal and the task is
			// NOT flipped back to "queued" by the stale-snapshot reset.
			assert.equal(loaded?.manifest.status, "completed");
			assert.equal(loaded?.tasks[0]?.status, "running");
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(events.some((e) => e.type === "crew.run.recovery_skipped"));
			assert.ok(!events.some((e) => e.type === "crew.run.resumed"));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});

describe("declineRecoveryPlan", () => {
	it("marks run as cancelled when declined", () => {
		const run = createRecoveryRun();
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
			declineRecoveryPlan(
				{
					runId: run.runId,
					resumableTasks: ["task-1"],
					preservedTasks: [],
					lastEventSeq: 5,
				},
				{ cwd: run.cwd },
			);
			const loaded = loadRunManifestById(run.cwd, run.runId);
			assert.equal(loaded?.manifest.status, "cancelled");
			const events = readEvents(run.manifest.eventsPath);
			assert.ok(events.some((e) => e.type === "crew.run.recovery_declined"));
		} finally {
			fs.rmSync(run.cwd, { recursive: true, force: true });
		}
	});
});
