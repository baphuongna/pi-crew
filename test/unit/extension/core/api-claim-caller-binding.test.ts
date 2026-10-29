/**
 * Regression tests for the W1b security fix
 * `team-tool/api.claim-task.missing-caller-role-ownership-binding`.
 *
 * Before the fix, the claim-task api operation bound nothing about the CALLER:
 * a read_only-tier role could claim any queued task with a self-declared owner
 * and mint the token that release-task-claim / transition-task-status then
 * trust (queued→failed lifecycle poisoning), and a worker caller could claim a
 * foreign task. The fix adds
 *   1. a role-tier gate (canApprovePlan pattern) on claim/release/transition —
 *      read_only roles are denied, role-less root-session callers stay allowed;
 *   2. caller-identity binding on claim — a caller WITH a worker task identity
 *      (PI_CREW_TASK_ID) may only claim its OWN task, the declared owner must
 *      match it, and the effective owner becomes the verified identity.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import type { ApiHandlerContext, ApiLoadedRun } from "../../../../src/extension/team-tool/api/handler-context.ts";
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
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

/** Run an assertion body under a scoped PI_CREW_* env (restored afterwards).
 *  The handlers read caller identity from process.env at call time. */
async function withCallerEnv(values: Record<string, string | undefined>, body: () => Promise<void>): Promise<void> {
	const saved: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(values)) {
		saved[key] = process.env[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		await body();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** Two queued tasks (task-1, task-2) in a seeded run — cross-task claim target. */
function seedRun(cwd: string, taskCount = 2): { runId: string } {
	const team = {
		name: "claim-binding-test",
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
	const created = createRunManifest({ cwd, team, workflow, goal: "claim binding test" });
	const tasks: TeamTaskState[] = Array.from({ length: taskCount }, (_, i) => ({
		id: `task-${i + 1}`,
		runId: created.manifest.runId,
		role: "worker",
		agent: "worker",
		title: `task ${i + 1}`,
		status: "queued",
		dependsOn: [],
		cwd,
	}));
	saveRunTasks(created.manifest, tasks);
	return { runId: created.manifest.runId };
}

function apiCtx(cwd: string, loaded: ApiLoadedRun, cfg: Record<string, unknown>): ApiHandlerContext {
	return {
		cfg,
		loaded,
		result,
		paramRequired,
		params: {} as TeamToolParamsValue,
		ctx: { cwd } as TeamContext,
	};
}

function loadTask(cwd: string, runId: string): TeamTaskState {
	const fresh = loadRunManifestById(cwd, runId)!;
	return fresh.tasks[0]!;
}

/** Sanity: no ambient PI_CREW_ROLE/PI_CREW_TASK_ID leaks into the fixtures. */
test("W1b fixture hygiene: caller env is unset at module scope", (t: TestContext) => {
	assert.equal(process.env.PI_CREW_ROLE, undefined, "PI_CREW_ROLE must be unset (scrub before running)");
	assert.equal(process.env.PI_CREW_TASK_ID, undefined, "PI_CREW_TASK_ID must be unset (scrub before running)");
});

test("W1b role gate: claim-task is denied for a read_only-tier role (explorer)", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-gate-explorer-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleClaimTask(apiCtx(cwd, loaded, { operation: "claim-task", taskId: "task-1", owner: "ghost-explorer" }));
			assert.equal(res.isError, true, "read_only role must be denied");
			assert.match(firstText(res), /read-only and cannot claim, release, or transition tasks/);
			assert.match(firstText(res), /explorer/);
		});
		// Disk state unchanged: still queued, no claim minted.
		const task = loadTask(cwd, runId);
		assert.equal(task.status, "queued");
		assert.equal(task.claim, undefined);
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b role gate: read_only-tier role cannot transition-task-status even with a valid pre-minted token", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-gate-transition-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd, 1);
		// Claim is minted by a role-less (root-session) caller first.
		const before = loadRunManifestById(cwd, runId)!;
		const claimed = claimTask(before.tasks[0]!, "tester");
		saveRunTasks(before.manifest, [claimed]);
		await withCallerEnv({ PI_CREW_ROLE: "analyst" }, async () => {
			const stale = loadRunManifestById(cwd, runId)!;
			const res = await handleTransitionTaskStatus(
				apiCtx(cwd, stale, {
					operation: "transition-task-status",
					taskId: "task-1",
					owner: "tester",
					token: claimed.claim!.token,
					status: "failed",
				}),
			);
			assert.equal(res.isError, true, "the PoC queued→failed poisoning must now be denied");
			assert.match(firstText(res), /analyst.*read-only/);
		});
		const task = loadTask(cwd, runId);
		assert.equal(task.status, "queued", "status must stay queued (no poisoning)");
		assert.equal(task.claim?.owner, "tester", "claim must stay intact");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b role gate: read_only-tier role cannot release-task-claim", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-gate-release-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd, 1);
		const before = loadRunManifestById(cwd, runId)!;
		const claimed = claimTask(before.tasks[0]!, "tester");
		saveRunTasks(before.manifest, [claimed]);
		await withCallerEnv({ PI_CREW_ROLE: "reviewer" }, async () => {
			const stale = loadRunManifestById(cwd, runId)!;
			const res = await handleReleaseTaskClaim(
				apiCtx(cwd, stale, { operation: "release-task-claim", taskId: "task-1", owner: "tester", token: claimed.claim!.token }),
			);
			assert.equal(res.isError, true);
			assert.match(firstText(res), /reviewer.*read-only/);
		});
		assert.equal(loadTask(cwd, runId).claim?.owner, "tester", "claim must stay intact");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b role gate: write-tier role (executor) and role-less root session remain allowed", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-gate-allowed-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd, 1);
		// Root session (no role): unchanged behavior.
		const rootLoaded = loadRunManifestById(cwd, runId)!;
		const rootRes = await handleClaimTask(apiCtx(cwd, rootLoaded, { operation: "claim-task", taskId: "task-1", owner: "tester" }));
		assert.equal(rootRes.isError, false, "role-less root session stays allowed");
		// Write-tier role: allowed.
		await withCallerEnv({ PI_CREW_ROLE: "executor" }, async () => {
			const stale = loadRunManifestById(cwd, runId)!;
			const res = await handleReleaseTaskClaim(
				apiCtx(cwd, stale, {
					operation: "release-task-claim",
					taskId: "task-1",
					owner: "tester",
					token: JSON.parse(firstText(rootRes)!).token,
				}),
			);
			assert.equal(res.isError, false, "write-tier role stays allowed");
		});
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b identity binding: worker caller cannot claim a foreign task (cross-task claim rejected)", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-bind-foreign-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd, 2);
		await withCallerEnv({ PI_CREW_TASK_ID: "task-1" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleClaimTask(apiCtx(cwd, loaded, { operation: "claim-task", taskId: "task-2", owner: "task-1" }));
			assert.equal(res.isError, true, "cross-task claim must be rejected");
			assert.match(firstText(res), /may only claim its own task/);
			assert.match(firstText(res), /task-2/);
		});
		const fresh = loadRunManifestById(cwd, runId)!;
		const task2 = fresh.tasks.find((item) => item.id === "task-2")!;
		assert.equal(task2.status, "queued");
		assert.equal(task2.claim, undefined, "foreign task must stay unclaimed");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b identity binding: worker caller claims its own task; owner is bound to the caller identity", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-bind-own-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd, 1);
		await withCallerEnv({ PI_CREW_TASK_ID: "task-1" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			// No cfg.owner at all — owner is derived from the verified identity.
			const res = await handleClaimTask(apiCtx(cwd, loaded, { operation: "claim-task", taskId: "task-1" }));
			assert.equal(res.isError, false, "own-task claim works");
		});
		const task = loadTask(cwd, runId);
		assert.equal(task.claim?.owner, "task-1", "claim owner must equal the caller's own task identity");
		assert.ok(task.claim?.token, "a claim token is still minted for the legitimate claimant");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b identity binding: worker caller cannot forge a foreign owner on its own task", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-bind-owner-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const { runId } = seedRun(cwd, 1);
		await withCallerEnv({ PI_CREW_TASK_ID: "task-1" }, async () => {
			const loaded = loadRunManifestById(cwd, runId)!;
			const res = await handleClaimTask(apiCtx(cwd, loaded, { operation: "claim-task", taskId: "task-1", owner: "ghost-explorer" }));
			assert.equal(res.isError, true, "declared owner must match the caller identity");
			assert.match(firstText(res), /does not match the caller's own task identity/);
		});
		assert.equal(loadTask(cwd, runId).claim, undefined, "rejected claim must not mint a token");
	} finally {
		await removeDirWithRetry(cwd);
	}
});

test("W1b end-to-end: handleTeamTool claim-task as explorer is denied (PoC replay via the real dispatcher)", async () => {
	const cwd = createTrackedTempDir("pi-crew-claim-gate-e2e-");
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "claim binding e2e",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);
		const taskId = loadRunManifestById(cwd, runId)?.tasks[0]?.id;
		assert.ok(taskId);
		await withCallerEnv({ PI_CREW_ROLE: "explorer" }, async () => {
			const claim = await handleTeamTool(
				{
					action: "api",
					runId: runId!,
					config: { operation: "claim-task", taskId: taskId!, owner: "ghost-explorer" },
				},
				{ cwd },
			);
			assert.equal(claim.isError, true, "the PoC crossing (explorer claim-task) must be denied end-to-end");
			assert.match(firstText(claim), /read-only/);
		});
		const task = loadRunManifestById(cwd, runId)?.tasks[0];
		assert.ok(task);
		// Scaffold-mode runs may auto-complete their task; the denial assertions
		// above are the PoC replay — here we only verify no claim was minted.
		assert.equal(task.claim, undefined);
	} finally {
		await removeDirWithRetry(cwd);
	}
});
