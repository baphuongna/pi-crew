/**
 * Regression tests — pi-crew/resume-disarms-run-budget-enforcement (end-to-end
 * handleResume half: budget re-forwarding + unified deadline arming).
 *
 * BUG (budget half): the static resume re-entry called executeTeamRun with
 * manifest/tasks/limits/isResume but NO budgetTotal/budgetWarning/budgetAbort/
 * budgetUnlimited — enforceRunBudget gates solely on ctx.input.budgetTotal, and
 * the manifest copy of the operator's spend cap was never read back into the
 * enforcement input. PoC (bwrap, repo mock transport): a resume-shape execution
 * of a 15-token-budgeted manifest completed 4 workers at 60 tokens (400%) with
 * ZERO run.budget_warning/run.budget_abort events and status completed.
 *
 * BUG (deadline half): maxRunMinutes/timeoutMs bounds are applied only by
 * resolveRunDeadline, which the static resume path never called — the resumed
 * foreground execution was bounded only by the session signal.
 *
 * FIX: handleResume arms resolveRunDeadline (params.timeoutMs >
 * config.limits.maxRunMinutes > 1h default) and re-forwards the persisted
 * manifest budget; team-runner additionally re-arms missing input budget
 * fields from the manifest (defense-in-depth), so a resumed run cannot escape
 * either operator bound.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { __test_resetCap, getWorkerCapCapacity } from "../../../../src/runtime/scheduling/global-worker-cap.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const realTmp = fs.realpathSync(os.tmpdir());

/** Isolate PI_TEAMS_HOME (TEAMS??CREW mirror winner) so the resume path's
 * registerActiveRun/unregisterActiveRun never touch the real user registry. */
async function withIsolatedHome<T>(fn: () => T): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-bound-home-"));
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	process.env.PI_TEAMS_HOME = home;
	try {
		return await fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		await removeDirWithRetry(home);
	}
}

interface MockEnvState {
	mock: string | undefined;
	allow: string | undefined;
	maxWorkers: string | undefined;
}

function saveMockEnv(): MockEnvState {
	return {
		mock: process.env.PI_TEAMS_MOCK_CHILD_PI,
		allow: process.env.PI_CREW_ALLOW_MOCK,
		maxWorkers: process.env.PI_CREW_MAX_WORKERS,
	};
}

function restoreMockEnv(state: MockEnvState): void {
	if (state.mock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	else process.env.PI_TEAMS_MOCK_CHILD_PI = state.mock;
	if (state.allow === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
	else process.env.PI_CREW_ALLOW_MOCK = state.allow;
	if (state.maxWorkers === undefined) delete process.env.PI_CREW_MAX_WORKERS;
	else process.env.PI_CREW_MAX_WORKERS = state.maxWorkers;
}

/** Project team + 3 independent executor steps (no verifier role — the
 * deterministic verify-gate pre-gate only gates verifier tasks). */
function writeProjectFixtures(cwd: string): void {
	fs.mkdirSync(path.join(cwd, ".crew", "teams"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
	fs.writeFileSync(
		path.join(cwd, ".crew", "teams", "bound-team.team.md"),
		[
			"---",
			"name: bound-team",
			"description: budget/deadline resume fixture",
			"defaultWorkflow: bound-flow",
			"workspaceMode: single",
			"---",
			"",
			"- executor: agent=executor do the work",
			"",
		].join("\n"),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(cwd, ".crew", "workflows", "bound-flow.workflow.md"),
		[
			"---",
			"name: bound-flow",
			"description: three independent steps",
			"---",
			"",
			"## alpha",
			"role: executor",
			"",
			"Do alpha: {goal}",
			"",
			"## beta",
			"role: executor",
			"",
			"Do beta: {goal}",
			"",
			"## gamma",
			"role: executor",
			"",
			"Do gamma: {goal}",
			"",
		].join("\n"),
		"utf-8",
	);
}

/** Seed a completed real dispatch (mock transport), then poison it into the
 * crash-resume shape: manifest failed + budget fields persisted (the operator
 * cap the original dispatch would have carried), every task failed with usage
 * cleared so the resumed execution's spend starts from zero. */
async function seedBudgetedCrashedRun(cwd: string, sessionId: string, withBudget = true): Promise<string> {
	const run = await handleTeamTool(
		{
			action: "run",
			team: "bound-team",
			goal: "budget/deadline resume fixture",
			// Sequential dispatch — the pre-existing mock-transport run.lock
			// contention (task fails "locked by another operation" under parallel
			// waves) must not pollute the seed.
			config: { limits: { maxConcurrentWorkers: 1 } },
		},
		{ cwd, sessionId },
	);
	const runId = run.details.runId;
	assert.ok(runId, "seed run must produce a runId");

	const loaded = loadRunManifestById(cwd, runId);
	assert.ok(loaded, "seeded run must be loadable");
	const poisoned: TeamTaskState[] = loaded.tasks.map((task) => ({
		...task,
		status: "failed" as const,
		error: "simulated crash for resume-bound test",
		usage: undefined,
		startedAt: undefined,
		finishedAt: undefined,
		claim: undefined,
	}));
	assert.ok(poisoned.length >= 2, `seeded run must have multiple tasks, got ${poisoned.length}`);
	await saveRunManifestAsync(
		{
			...loaded.manifest,
			status: "failed",
			summary: "simulated crash",
			// The operator bounds "originally declared at dispatch" (persisted
			// manifest values, exactly what team-runner writes input→manifest).
			// The deadline test seeds WITHOUT them (withBudget=false): a seeded
			// budget races the deadline for terminal authority on slow runners
			// (first task's merged usage trips budgetAbort→`failed` before the
			// deadline's `cancelled`), which is CORRECT product behavior — the
			// test isolates the deadline as the sole bound so the expected
			// terminal status is deterministic on any runner speed.
			...(withBudget ? { budgetTotal: 15, budgetWarning: 0.8, budgetAbort: 0.95 } : {}),
			updatedAt: new Date().toISOString(),
		},
		{ allowTerminalExit: true },
	);
	saveRunTasks(loaded.manifest, poisoned);
	return runId;
}

test("resume inherits the persisted budget — enforcement fires on the resumed run (disarm impossible)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-budget-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		writeProjectFixtures(cwd);
		const prevEnv = saveMockEnv();
		process.env.PI_CREW_ALLOW_MOCK = "1";
		process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success"; // 15 tokens usage per task
		const prevCap = getWorkerCapCapacity();
		__test_resetCap(8);
		let runId = "";
		try {
			runId = await seedBudgetedCrashedRun(cwd, "session-owner");

			// Resume in the exact PoC shape: budgeted manifest on disk, resume
			// params carrying NO budget fields (handleResume must re-forward them;
			// team-runner must re-arm from the manifest as defense-in-depth).
			const resumed = await handleTeamTool(
				{
					action: "resume",
					runId,
					// Sequential dispatch so the FIRST completed task's merge (15
					// tokens) deterministically trips the abort threshold (0.95 × 15)
					// without the pre-existing parallel-wave lock-busy artifact.
					config: { limits: { maxConcurrentWorkers: 1 } },
				},
				{ cwd, sessionId: "session-owner" },
			);
			assert.equal(resumed.isError, true, `resumed budgeted run must FAIL at the cap, got: ${textFromToolResult(resumed)}`);

			const after = loadRunManifestById(cwd, runId);
			assert.ok(after, "manifest must exist after resume");
			assert.equal(after.manifest.status, "failed", `run must be failed by the budget abort, got: ${after.manifest.status}`);

			// DISARM-REFUTED: the budget-abort event must be loud on the resumed run.
			const events = fs.readFileSync(after.manifest.eventsPath, "utf-8");
			const abortEvents = events.split("\n").filter((line) => line.includes('"type":"run.budget_abort"'));
			assert.equal(
				abortEvents.length,
				1,
				`exactly one run.budget_abort expected, got ${abortEvents.length}: ${abortEvents.join(" | ")}`,
			);
			assert.match(abortEvents[0] ?? "", /15/, "abort event must name the 15-token cap");

			// The tripping task completed; the persisted cap must survive the run
			// (input→manifest persistence never erases the operator's bound).
			const completed = after.tasks.filter((task) => task.status === "completed");
			assert.ok(completed.length >= 1, "at least the tripping task must be completed");
			assert.equal(after.manifest.budgetTotal, 15, "persisted budgetTotal must survive the resumed execution");
		} finally {
			if (runId) fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 3 });
			__test_resetCap(prevCap);
			restoreMockEnv(prevEnv);
		}
	});
});

test("resume arms the unified deadline — timeoutMs bounds the resumed execution (run cancelled, not completed)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-deadline-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		writeProjectFixtures(cwd);
		const prevEnv = saveMockEnv();
		const prevCap = getWorkerCapCapacity();
		__test_resetCap(8);
		let runId = "";
		try {
			// Seed under the fast mock (seed must complete), poison to the crash
			// shape, then resume under the SLOW mock with a 300ms deadline: every
			// resumed worker sleeps 1500ms before emitting, so the ONLY way this
			// resume returns is the deadline firing. Pre-fix (no resolveRunDeadline
			// on the resume path) the run completed at ~1.5s.
			process.env.PI_CREW_ALLOW_MOCK = "1";
			process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
			runId = await seedBudgetedCrashedRun(cwd, "session-owner", false);

			process.env.PI_TEAMS_MOCK_CHILD_PI = "json-slow-success";
			const resumed = await handleTeamTool({ action: "resume", runId, timeoutMs: 300 } as never, {
				cwd,
				sessionId: "session-owner",
			});
			const text = textFromToolResult(resumed);

			const after = loadRunManifestById(cwd, runId);
			assert.ok(after, "manifest must exist after resume");
			assert.notEqual(
				after.manifest.status,
				"completed",
				`deadline must bound the resumed execution — run completed anyway: ${text}`,
			);
			assert.equal(after.manifest.status, "cancelled", `run must be cancelled by the deadline, got: ${after.manifest.status}`);

			// The cancellation is loud: run.cancelled lands on the resumed run.
			const events = fs.readFileSync(after.manifest.eventsPath, "utf-8");
			assert.ok(events.includes('"type":"run.cancelled"'), "run.cancelled event must be recorded by the deadline abort");
			assert.match(text, /cancelled/, "result text must report the deadline cancellation");
		} finally {
			if (runId) await removeDirWithRetry(cwd);
			__test_resetCap(prevCap);
			restoreMockEnv(prevEnv);
		}
	});
});
