/**
 * Regression test — pi-crew/resume-skips-maxtasks-admission.
 *
 * BUG: limits.maxTasksPerRun (default hard ceiling 10,000) was enforced in
 * exactly two places — an admission throw in createRunManifest (before any
 * dispatch) and a post-hoc block decision in evaluateCrewPolicy (finalize-run
 * only). handleResume loaded tasks.json via loadTasksWithRecovery (returns the
 * on-disk array verbatim, no count cap, no per-entry validation) and re-queued
 * + dispatched the full set with NO admission re-check. In single-workspace
 * project-state mode the state root lives inside the tree the workers share,
 * so a WRITE-role worker (or a prompt-injected executor) can inflate
 * tasks.json past the ceiling and the next team resume admitted it (PoC:
 * creation refused 10,001 steps; resume admitted them and was actively
 * dispatching wave after wave).
 *
 * FIX: handleResume re-runs the SAME admission invariant inside the resume
 * lock (resolveMaxTasksPerRunAdmissionCap, now exported from state-store) —
 * after the in-lock liveness re-check, BEFORE any recovery/reset mutation,
 * status flip, or dispatch — refusing with the same contract as
 * createRunManifest when the disk-loaded cardinality exceeds the cap.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { activeRunEntries, unregisterActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const realTmp = fs.realpathSync(os.tmpdir());

async function withIsolatedHome<T>(fn: () => T): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-admit-home-"));
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

/** Temp cwd with a 3-task-cap config, a project team, and a 3-step workflow —
 * creation passes at exactly the cap, so any extra task in tasks.json is
 * attacker-inflated persisted state. */
function makeAdmissionCwd(): string {
	const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-admit-"));
	fs.mkdirSync(path.join(cwd, ".crew", "teams"), { recursive: true });
	fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".crew", "config.json"), `${JSON.stringify({ limits: { maxTasksPerRun: 3 } }, null, 2)}\n`, "utf-8");
	fs.writeFileSync(
		path.join(cwd, ".crew", "teams", "admit-team.team.md"),
		[
			"---",
			"name: admit-team",
			"description: maxTasks admission fixture",
			"defaultWorkflow: admit-flow",
			"workspaceMode: single",
			"---",
			"",
			"- executor: agent=executor do the work",
			"",
		].join("\n"),
		"utf-8",
	);
	fs.writeFileSync(
		path.join(cwd, ".crew", "workflows", "admit-flow.workflow.md"),
		[
			"---",
			"name: admit-flow",
			"description: three steps at the cap",
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
	return cwd;
}

/** Seed a completed scaffold run (hermetic — no child Pi spawns). */
async function seedRun(cwd: string, sessionId: string): Promise<string> {
	const run = await handleTeamTool(
		{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "admit-team", goal: "maxTasks admission fixture" },
		{ cwd, sessionId },
	);
	const runId = run.details.runId;
	assert.ok(runId, "seed run must produce a runId");
	assert.equal(run.isError, false, `seed run must succeed: ${textFromToolResult(run)}`);
	return runId;
}

/** Poison tasks.json the way a worker-writable state file would be inflated:
 * flip every entry to a resumable (failed) status — the attacker-chosen
 * statuses resume re-queues — and append entries beyond the cap. */
async function inflateTasks(cwd: string, runId: string, extraCount: number): Promise<void> {
	const loaded = loadRunManifestById(cwd, runId);
	assert.ok(loaded, "run must be loadable before inflation");
	const failed = loaded.tasks.map((task) => ({
		...task,
		status: "failed" as const,
		error: "attacker-poisoned entry",
		claim: undefined,
	}));
	const extras: TeamTaskState[] = Array.from({ length: extraCount }, (_, index) => ({
		...loaded.tasks[0]!,
		id: `99_poison_${index + 1}`,
		title: `poison-${index + 1}`,
		stepId: loaded.tasks[0]!.stepId,
		status: "failed" as const,
		error: "attacker-inflated entry",
	}));
	await saveRunManifestAsync(
		{ ...loaded.manifest, status: "failed", summary: "simulated crash", updatedAt: new Date().toISOString() },
		{ allowTerminalExit: true },
	);
	saveRunTasks(loaded.manifest, [...failed, ...extras]);
}

test("resume refuses an inflated tasks.json past limits.maxTasksPerRun — same contract as createRunManifest", async () => {
	await withIsolatedHome(async () => {
		const cwd = makeAdmissionCwd();
		let runId = "";
		try {
			runId = await seedRun(cwd, "session-owner");
			await inflateTasks(cwd, runId, 1); // 3 on-disk tasks → 4 (cap 3)

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(resumed.isError, true, `resume of an inflated tasks.json must be REFUSED: ${textFromToolResult(resumed)}`);
			const text = textFromToolResult(resumed);
			assert.match(text, /Refusing to resume run/, "refusal must use the admission contract");
			assert.match(text, /limits\.maxTasksPerRun=3/, "refusal must name the cap");
			assert.match(text, /4 tasks/, "refusal must state the actual count");

			// Nothing may have been admitted: no re-queue, no status flip, no
			// dispatch adoption, no registry entry.
			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			assert.equal(after.manifest.status, "failed", "refused resume must not flip the status to running");
			assert.equal(after.tasks.length, 4, "tasks.json must be untouched");
			assert.equal(
				after.tasks.filter((task) => task.status === "failed").length,
				4,
				"refused resume must not re-queue the poisoned entries",
			);
			assert.equal(
				activeRunEntries().some((entry) => entry.runId === runId),
				false,
				"refused resume must not register the run",
			);
			const events = fs.readFileSync(after.manifest.eventsPath, "utf-8");
			assert.doesNotMatch(events, /"type":"run\.resume_requested"/, "refusal must precede any resume event");
		} finally {
			if (runId) unregisterActiveRun(runId);
			await removeDirWithRetry(cwd);
		}
	});
});

test("resume control: tasks.json at exactly the cap passes admission", async () => {
	await withIsolatedHome(async () => {
		const cwd = makeAdmissionCwd();
		let runId = "";
		try {
			runId = await seedRun(cwd, "session-owner");
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded);
			assert.equal(loaded.tasks.length, 3, "seed workflow produces exactly cap-sized tasks");

			// Terminal-but-failed with all tasks completed: admission passes (3 ≤ 3)
			// and nothing is re-queued — resume completes instantly and hermetically.
			await saveRunManifestAsync(
				{ ...loaded.manifest, status: "failed", summary: "simulated crash", updatedAt: new Date().toISOString() },
				{ allowTerminalExit: true },
			);

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(resumed.isError, false, `resume at the cap must pass admission: ${textFromToolResult(resumed)}`);
			const text = textFromToolResult(resumed);
			assert.match(text, /Resumed work: 0 task\(s\) re-queued/, `expected zero re-queue in: ${text}`);
		} finally {
			if (runId) unregisterActiveRun(runId);
			await removeDirWithRetry(cwd);
		}
	});
});
