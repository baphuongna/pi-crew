/**
 * Regression test — extension/team-tool.ts:adoptSpecialKindRunForResume
 * (no in-lock liveness re-check on the goal-loop / dynamic-workflow resume
 * arms).
 *
 * BUG: handleResume enforces G12 (liveness before ownership; force bypasses
 * ownership only) with a pre-lock resumeLivenessRefusal gate and — on the
 * STATIC team-run path only — an in-lock re-check against fresh locked state
 * (the F1 2026-10-01 fix for exactly this race). The goal-loop and
 * dynamic-workflow arms branch BEFORE the static LOCK-2 block and adopt via
 * adoptSpecialKindRunForResume, which re-reads fresh state under the run lock
 * but never re-checked liveness on it. A concurrent session's adoption +
 * registerActiveRun landing between the pre-lock gate and the lock acquisition
 * was silently STOLEN: the first session flipped status to running, adopted
 * ownerSessionId, re-registered the shared registry entry, and started a
 * SECOND engine execution (duplicate worker turns / duplicate spend /
 * interleaved manifest writers) — unaudited beyond the generic
 * run.resume_requested.
 *
 * FIX: adoptSpecialKindRunForResume re-runs resumeLivenessRefusal against the
 * LOCKED fresh state BEFORE any adoption mutation (the F1 mirror) and throws
 * ResumeLivenessRefusedError; both arms surface it as a typed error result
 * with no manifest write, no ownership flip, no registry write, no dispatch.
 * force:true still never bypasses liveness (G12).
 *
 * Race harness mirrors team-tool-resume-liveness.test.ts's deterministic F1
 * shape: the test holds the run lock BEFORE the resume exists, so the resume
 * parks BETWEEN its pre-lock check and the lock acquisition; the concurrent
 * live state is written while it is parked.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { GoalStore } from "../../../../src/runtime/goal-workflow/goal-state-store.ts";
import { withRunLock } from "../../../../src/state/coordination/locks.ts";
import { activeRunEntries, registerActiveRun, unregisterActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunManifestAsync } from "../../../../src/state/stores/state-store.ts";
import type { GoalLoopState, TeamRunManifest } from "../../../../src/state/types.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const realTmp = fs.realpathSync(os.tmpdir());

// Project-sourced .dwf.ts scripts are denied by the F-01 trust gate unless
// PI_CREW_TRUST_PROJECT_DWF=1 (mirrors team-tool-resume-runkind.test.ts).
const prevTrust = process.env.PI_CREW_TRUST_PROJECT_DWF;
process.env.PI_CREW_TRUST_PROJECT_DWF = "1";
test.after(() => {
	if (prevTrust === undefined) delete process.env.PI_CREW_TRUST_PROJECT_DWF;
	else process.env.PI_CREW_TRUST_PROJECT_DWF = prevTrust;
});

/** Isolate PI_TEAMS_HOME (TEAMS??CREW mirror winner) so the resume path's
 * registerActiveRun/unregisterActiveRun never touch the real user registry. */
async function withIsolatedHome<T>(fn: () => T): Promise<T> {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-skl-home-"));
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

/** Craft a crashed special-kind run (mirrors the runKind resume test): a
 * goal-loop or dynamic-workflow manifest with its synthetic team. Ownerless
 * (the adoption is what assigns ownership). */
function seedSpecialKindRun(cwd: string, runKind: "goal-loop" | "dynamic-workflow"): { runId: string; manifest: TeamRunManifest } {
	const created = createRunManifest({
		cwd,
		team: {
			name: "placeholder",
			description: "",
			source: "project",
			filePath: "<test>",
			roles: [{ name: "worker", agent: "executor" }],
		},
		goal: "special-kind adopt liveness",
		runKind,
	});
	const syntheticTeam =
		runKind === "dynamic-workflow" ? `dwf-${created.manifest.runId.slice(-12)}` : `goal-${created.manifest.runId.slice(-12)}`;
	const manifest: TeamRunManifest = {
		...created.manifest,
		team: syntheticTeam,
		workflow: runKind === "dynamic-workflow" ? "skl-echo" : "goal-loop",
		status: "failed",
		summary: "simulated crash for adopt-liveness test",
		updatedAt: new Date().toISOString(),
	};
	saveRunManifest(manifest);
	return { runId: manifest.runId, manifest };
}

/** Persist a loadable PAUSED GoalLoopState so the goal-loop arm reaches the
 * adoption step (a missing state errors out BEFORE adoption). Paused also
 * makes the CONTROL cheap: runGoalLoop exits the loop immediately (no worker
 * dispatch) and maps paused → blocked. */
function seedPausedGoalState(cwd: string, runId: string, sessionId: string): void {
	const store = new GoalStore(cwd);
	const state: GoalLoopState = {
		goalId: runId,
		ownerSessionId: sessionId,
		objective: "adopt-liveness fixture",
		state: "paused",
		maxTurns: 3,
		turnsUsed: 1,
		budgetUsed: 0,
		evaluatorModel: "test",
		verdicts: [],
		history: [],
		cwd,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
	store.save(state);
}

/** Write a project dynamic workflow (runtime=dynamic) so the DWF arm reaches
 * the adoption step; its script must never run in the RACE test (refusal
 * happens before dispatch). */
function writeProjectDwfWorkflow(cwd: string): void {
	fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
	const artifactPath = path.join(cwd, "skl-echo-result.txt");
	fs.writeFileSync(
		path.join(cwd, ".crew", "workflows", "skl-echo.dwf.ts"),
		`export default async function run(ctx) {\n\tctx.setResult(${JSON.stringify(artifactPath)});\n}\n`,
		"utf-8",
	);
}

/** The deterministic F1 race: hold the run lock FIRST (so the resume cannot
 * win acquisition), start the resume while the lock is held (it parks between
 * its pre-lock gate and the lock body), have a "concurrent session" adopt +
 * register the run inside that window, then release and surface the parked
 * resume. */
async function raceLiveAdoptionDuringLockHold<T>(cwd: string, manifest: TeamRunManifest, startResumer: () => Promise<T>): Promise<T> {
	let lockEntered!: () => void;
	let releaseTestLock!: () => void;
	const entered = new Promise<void>((resolve) => {
		lockEntered = resolve;
	});
	const release = new Promise<void>((resolve) => {
		releaseTestLock = resolve;
	});
	const testLock = withRunLock(manifest, async () => {
		lockEntered();
		await release;
	});
	await entered; // lock is HELD before the resume exists

	const resumerPromise = startResumer(); // parks on lock acquisition

	// Concurrent session B adopts + registers the run in the TOCTOU window:
	// status running + owner flip + active-run registry entry (fresh heartbeat).
	const liveManifest: TeamRunManifest = {
		...manifest,
		status: "running",
		ownerSessionId: "session-b",
		updatedAt: new Date().toISOString(),
	};
	await saveRunManifestAsync(liveManifest, { allowTerminalExit: true });
	registerActiveRun(liveManifest);

	releaseTestLock();
	await testLock;
	return resumerPromise;
}

test("goal-loop adopt: concurrently-registered live run is REFUSED in-lock (no adoption, no double dispatch)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-skl-goal-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		let runId = "";
		try {
			const seeded = seedSpecialKindRun(cwd, "goal-loop");
			runId = seeded.runId;
			seedPausedGoalState(cwd, runId, "session-original");

			const resumed = await raceLiveAdoptionDuringLockHold(cwd, seeded.manifest, () =>
				handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-resumer" }),
			);

			assert.equal(resumed.isError, true, `in-lock liveness re-check must refuse the live run: ${textFromToolResult(resumed)}`);
			assert.match(textFromToolResult(resumed), /live/i);
			assert.match(textFromToolResult(resumed), new RegExp(runId), "refusal must name the run");

			// The live run must be untouched: session B's adoption stands (no steal),
			// no status flip, no registry churn, and the goal engine NEVER started
			// (pre-fix this session re-adopted + dispatched runGoalLoop).
			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			assert.equal(after.manifest.status, "running", "the live run's status must not be mutated");
			assert.equal(after.manifest.ownerSessionId, "session-b", "the concurrent session's ownership must stand");
			const events = fs.readFileSync(after.manifest.eventsPath, "utf-8");
			assert.doesNotMatch(events, /"type":"goal\.loop_start"/, "the goal engine must not have been dispatched");
			assert.ok(
				activeRunEntries().some((entry) => entry.runId === runId),
				"the live registry entry must survive",
			);
		} finally {
			if (runId) unregisterActiveRun(runId);
			await removeDirWithRetry(cwd);
		}
	});
});

test("dynamic-workflow adopt: concurrently-registered live run is REFUSED in-lock (no adoption, no DWF dispatch)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-skl-dwf-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		let runId = "";
		try {
			writeProjectDwfWorkflow(cwd);
			const seeded = seedSpecialKindRun(cwd, "dynamic-workflow");
			runId = seeded.runId;

			const resumed = await raceLiveAdoptionDuringLockHold(cwd, seeded.manifest, () =>
				handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-resumer" }),
			);

			assert.equal(resumed.isError, true, `in-lock liveness re-check must refuse the live run: ${textFromToolResult(resumed)}`);
			assert.match(textFromToolResult(resumed), /live/i);

			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			assert.equal(after.manifest.status, "running", "the live run's status must not be mutated");
			assert.equal(after.manifest.ownerSessionId, "session-b", "the concurrent session's ownership must stand");
			const events = fs.readFileSync(after.manifest.eventsPath, "utf-8");
			assert.doesNotMatch(events, /"type":"dwf\.started"/, "the DWF engine must not have been dispatched");
			assert.ok(
				activeRunEntries().some((entry) => entry.runId === runId),
				"the live registry entry must survive",
			);
		} finally {
			if (runId) unregisterActiveRun(runId);
			await removeDirWithRetry(cwd);
		}
	});
});

test("goal-loop adopt control: DEAD run still resumes normally (no over-refusal)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-skl-goal-ctrl-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		let runId = "";
		try {
			const seeded = seedSpecialKindRun(cwd, "goal-loop");
			runId = seeded.runId;
			seedPausedGoalState(cwd, runId, "session-original");

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-resumer" });
			assert.equal(resumed.isError, false, `dead goal-loop run must still resume: ${textFromToolResult(resumed)}`);
			assert.match(textFromToolResult(resumed), /Resumed goal-loop run/, "control must reach the engine");
			assert.match(
				textFromToolResult(resumed),
				/blocked \(goal state: paused\)/,
				"paused goal maps to blocked, loop exits without dispatch",
			);

			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			assert.equal(after.manifest.ownerSessionId, "session-resumer", "adoption flipped ownership to the resumer");
		} finally {
			if (runId) unregisterActiveRun(runId);
			await removeDirWithRetry(cwd);
		}
	});
});
