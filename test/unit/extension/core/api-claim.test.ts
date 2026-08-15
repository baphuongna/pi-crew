import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import type { ApiHandlerContext, ApiLoadedRun } from "../../../../src/extension/team-tool/api/handler-context.ts";
import { handleWriteHeartbeat } from "../../../../src/extension/team-tool/api/heartbeat.ts";
import {
	handleClaimTask,
	handleReleaseTaskClaim,
	handleTransitionTaskStatus,
} from "../../../../src/extension/team-tool/api/task-claims.ts";
import { result, type TeamContext } from "../../../../src/extension/team-tool/context.ts";
import { paramRequired } from "../../../../src/extension/team-tool/param-error.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import type { TeamToolParamsValue } from "../../../../src/schema/team-tool-schema.ts";
import { claimTask } from "../../../../src/state/coordination/task-claims.ts";
import { createRunManifest, loadRunManifestById, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

test("api supports claim, transition, and release task claim", async () => {
	const cwd = createTrackedTempDir("pi-crew-api-claim-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "claim api",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const taskId = loadRunManifestById(cwd, runId)?.tasks[0]?.id;
		assert.ok(taskId);
		const claim = await handleTeamTool(
			{
				action: "api",
				runId,
				config: { operation: "claim-task", taskId, owner: "tester" },
			},
			{ cwd },
		);
		assert.equal(claim.isError, false);
		const token = JSON.parse(firstText(claim) || "{}").token as string;
		assert.ok(token);
		const transition = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "transition-task-status",
					taskId,
					owner: "tester",
					token,
					status: "queued",
				},
			},
			{ cwd },
		);
		assert.equal(transition.isError, false);
		const release = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "release-task-claim",
					taskId,
					owner: "tester",
					token,
				},
			},
			{ cwd },
		);
		assert.equal(release.isError, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// R13-S1 stale-snapshot regression: a task made terminal on disk AFTER the
// handler's `loaded` snapshot was captured must not be resurrected by a
// stale claim/transition/heartbeat/release write. The handler must re-read
// fresh manifest+tasks INSIDE withRunLockSync (respond.ts:43 pattern) and
// reject the write when the FRESH task is terminal.
// ---------------------------------------------------------------------------

/** Minimal run + single queued task (no claim). Mirrors team-tool-dispatch.test.ts seedRun. */
function seedRun(cwd: string): { runId: string } {
	const team = {
		name: "claim-stale-test",
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
		goal: "stale claim test",
	});
	saveRunTasks(created.manifest, [
		{
			id: "task-1",
			runId: created.manifest.runId,
			role: "worker",
			agent: "worker",
			title: "task",
			status: "queued",
			dependsOn: [],
			cwd,
		},
	]);
	return { runId: created.manifest.runId };
}

/** Build an ApiHandlerContext carrying a possibly-STALE loaded snapshot. */
function staleCtx(cwd: string, loaded: ApiLoadedRun, cfg: Record<string, unknown>): ApiHandlerContext {
	return {
		cfg,
		loaded,
		result,
		paramRequired,
		params: {} as TeamToolParamsValue,
		ctx: { cwd } as TeamContext,
	};
}

function terminalTask(task: TeamTaskState, status: "completed" | "failed" | "cancelled"): TeamTaskState {
	return { ...task, status, finishedAt: new Date().toISOString() };
}

test("R13-S1: transition-task-status rejects when task became terminal on disk (stale loaded cannot flip completed->running)", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-stale-transition-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		// Worker claims the task on disk, then we snapshot `loaded` (stale).
		const before = loadRunManifestById(cwd, runId)!;
		const claimed = claimTask(before.tasks[0]!, "tester");
		saveRunTasks(before.manifest, [claimed]);
		const stale = loadRunManifestById(cwd, runId)!; // queued + claim
		const token = claimed.claim!.token;
		// Concurrent writer completes the task on disk AFTER the stale snapshot.
		saveRunTasks(before.manifest, [terminalTask(claimed, "completed")]);
		const res = await handleTransitionTaskStatus(
			staleCtx(cwd, stale, {
				operation: "transition-task-status",
				taskId: "task-1",
				owner: "tester",
				token,
				status: "running",
			}),
		);
		assert.equal(res.isError, true);
		assert.match(firstText(res), /Invalid task status transition: completed -> running/);
		// Disk state must be preserved: still completed, claim intact.
		const after = loadRunManifestById(cwd, runId)!;
		assert.equal(after.tasks[0]!.status, "completed");
		assert.equal(after.tasks[0]!.claim?.owner, "tester");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R13-S1: claim-task derives from fresh tasks (terminal status on disk is not resurrected)", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-stale-claim-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		const stale = loadRunManifestById(cwd, runId)!; // queued, no claim
		// Concurrent writer fails the task on disk AFTER the stale snapshot.
		saveRunTasks(stale.manifest, [terminalTask(stale.tasks[0]!, "failed")]);
		const res = await handleClaimTask(
			staleCtx(cwd, stale, {
				operation: "claim-task",
				taskId: "task-1",
				owner: "api",
			}),
		);
		// Claim succeeds (task was claimable at snapshot time) but must write from
		// FRESH state: the disk status stays "failed" — never flipped back to
		// "queued" via the stale array (that was the resurrection bug).
		assert.equal(res.isError, false);
		const after = loadRunManifestById(cwd, runId)!;
		assert.equal(after.tasks[0]!.status, "failed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R13-S1: write-heartbeat does not resurrect a task that became terminal on disk", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-stale-heartbeat-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		const stale = loadRunManifestById(cwd, runId)!; // queued
		// Concurrent writer completes the task on disk AFTER the stale snapshot.
		saveRunTasks(stale.manifest, [terminalTask(stale.tasks[0]!, "completed")]);
		const res = await handleWriteHeartbeat(
			staleCtx(cwd, stale, {
				operation: "write-heartbeat",
				taskId: "task-1",
				alive: true,
			}),
		);
		assert.equal(res.isError, true);
		assert.match(firstText(res), /task is in terminal state 'completed'/);
		// Disk state unchanged: no heartbeat written, status still completed.
		const after = loadRunManifestById(cwd, runId)!;
		assert.equal(after.tasks[0]!.status, "completed");
		assert.equal(after.tasks[0]!.heartbeat, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("R13-S1: release-task-claim derives from fresh tasks (terminal status preserved, claim cleared)", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-stale-release-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		const before = loadRunManifestById(cwd, runId)!;
		const claimed = claimTask(before.tasks[0]!, "tester");
		saveRunTasks(before.manifest, [claimed]);
		const stale = loadRunManifestById(cwd, runId)!; // queued + claim
		const token = claimed.claim!.token;
		// Concurrent writer completes the task on disk AFTER the stale snapshot
		// (claim retained on disk so release is a valid operation).
		saveRunTasks(before.manifest, [terminalTask(claimed, "completed")]);
		const res = await handleReleaseTaskClaim(
			staleCtx(cwd, stale, {
				operation: "release-task-claim",
				taskId: "task-1",
				owner: "tester",
				token,
			}),
		);
		// Release succeeds (claim held) but must write from FRESH state:
		// status stays completed, only the claim is cleared.
		assert.equal(res.isError, false);
		const after = loadRunManifestById(cwd, runId)!;
		assert.equal(after.tasks[0]!.status, "completed");
		assert.equal(after.tasks[0]!.claim, undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
