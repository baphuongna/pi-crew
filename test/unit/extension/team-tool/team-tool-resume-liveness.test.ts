/**
 * SDD-3 W-C WI-1 (G12+G4) — liveness-first resume gate.
 *
 * Verified gap (pi-crew-upgrade-plan-2026-09-29 §2 G12): handleResume never
 * consulted the active-run registry or task claims, and executeTeamRun runs
 * OUTSIDE the resume lock — so resuming a LIVE run double-dispatched workers
 * (duplicate tokens + duplicate side effects). G4 principle: force:true
 * bypasses OWNERSHIP only, NEVER LIVENESS, and a forced resume of a DEAD
 * foreign run must leave a security-event trace in events.jsonl.
 *
 * Red-first evidence: on the pre-fix HEAD these tests failed because resume
 * re-dispatched live runs and emitted no security event for force-on-foreign.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { registerActiveRun, unregisterActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasks } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
// Several pi-crew code paths refuse to write through untrusted symlink paths.
const realTmp = fs.realpathSync(os.tmpdir());

/**
 * Isolate PI_TEAMS_HOME (the TEAMS??CREW mirror winner, env-vars.ts) so
 * registerActiveRun / activeRunEntries in this file never touch the real user
 * registry. Mirrors test/unit/state/stores/active-run-registry.test.ts.
 */
function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-live-home-"));
	// userPiRoot() validates the .pi/agent path exists and is owned by the
	// current user — create the structure it requires.
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** macOS-CI teardown hardening — mirrors resume-cancel.test.ts. */
function rmCwd(cwd: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
				console.error(`resume-liveness teardown: unable to remove ${cwd}: ${String(error)}`);
				break;
			}
		}
	}
}

/** Seed a completed scaffold run and return its runId. */
async function seedCompletedRun(cwd: string, sessionId: string): Promise<string> {
	const run = await handleTeamTool(
		{
			action: "run",
			config: { runtime: { mode: "scaffold" } },
			team: "fast-fix",
			goal: "resume liveness guard",
		},
		{ cwd, sessionId },
	);
	const runId = run.details.runId;
	assert.ok(runId, "seed run must produce a runId");
	assert.equal(run.isError, false, `seed run must succeed: ${textFromToolResult(run)}`);
	return runId;
}

test("G12: resume REFUSES a run that is live in the active-run registry — with and without force", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-live-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		let runId = "";
		try {
			runId = await seedCompletedRun(cwd, "session-owner");

			// Simulate a LIVE dispatched run: non-terminal status + fresh heartbeat,
			// registered in the global active-run registry (what run.ts does at
			// dispatch time). This is the double-dispatch scenario from G12: an
			// async run is executing; a resume arriving NOW must be refused.
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded, "seeded run must be loadable");
			const liveManifest = {
				...loaded.manifest,
				status: "running" as const,
				updatedAt: new Date().toISOString(),
			};
			// allowTerminalExit: the disk manifest is terminal (completed) and the
			// state-store write guard (Finding 8) would silently preserve it — the
			// sanctioned opt-in mirrors what the resume flow itself uses when
			// re-activating a run.
			await saveRunManifestAsync(liveManifest, { allowTerminalExit: true });
			registerActiveRun(liveManifest);

			const plain = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(plain.isError, true, "resume of a live run must REFUSE");
			assert.match(textFromToolResult(plain), /live/i, "error must state the run is alive");
			assert.match(textFromToolResult(plain), new RegExp(runId), "error must name the run");

			const forced = await handleTeamTool({ action: "resume", runId, force: true }, { cwd, sessionId: "session-owner" });
			assert.equal(forced.isError, true, "force:true must NOT bypass liveness (G12/G4 principle)");
			assert.match(textFromToolResult(forced), /live/i);

			// The live run must be untouched — no adoption, no reset, no re-dispatch.
			const after = loadRunManifestById(cwd, runId);
			assert.ok(after, "manifest must still exist after refused resume");
			assert.equal(after.manifest.status, "running", "refused resume must not reset the live run");
			assert.equal(after.manifest.ownerSessionId, "session-owner", "refused resume must not adopt ownership");
		} finally {
			if (runId) unregisterActiveRun(runId);
			rmCwd(cwd);
		}
	});
});

test("G12: resume REFUSES a run whose running task holds an unexpired worker claim", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-claim-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded, "seeded run must be loadable");

			// Simulate an in-flight worker: a running task with an unexpired claim
			// (5-min default lease, task-claims.ts). The registry deliberately has
			// NO entry for this run — the claim alone proves liveness.
			const claimedTasks: TeamTaskState[] = loaded.tasks.map((task, index) =>
				index === 0
					? {
							...task,
							status: "running" as const,
							claim: {
								owner: "worker-inline-1",
								token: "claim-token-g12",
								leasedUntil: new Date(Date.now() + 5 * 60_000).toISOString(),
							},
						}
					: task,
			);
			saveRunTasks(loaded.manifest, claimedTasks);

			const plain = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(plain.isError, true, "resume with a live worker claim must REFUSE");
			assert.match(textFromToolResult(plain), /live/i);

			const forced = await handleTeamTool({ action: "resume", runId, force: true }, { cwd, sessionId: "session-owner" });
			assert.equal(forced.isError, true, "force:true must not bypass claim liveness");
			assert.match(textFromToolResult(forced), /live/i);

			// The claimed task must NOT have been reset to queued.
			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			const stillRunning = after.tasks.find((task) => task.id === claimedTasks[0]?.id);
			assert.ok(stillRunning);
			assert.equal(stillRunning.status, "running", "refused resume must not reset the claimed task");
		} finally {
			rmCwd(cwd);
		}
	});
});

test("G4: forced resume of a DEAD foreign run succeeds and records a security event", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-g4-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");

			// Sanity anchor (pre-existing behavior, stays green on HEAD): an
			// unforced foreign resume is refused by the ownership check.
			const foreign = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-intruder" });
			assert.equal(foreign.isError, true, "unforced foreign resume must stay refused (ownership)");

			// Dead run (completed, unregistered) + foreign session + force → the
			// ownership bypass is ALLOWED, but must be auditable: a
			// run.resume_forced_foreign security event lands in events.jsonl.
			const forced = await handleTeamTool({ action: "resume", runId, force: true }, { cwd, sessionId: "session-intruder" });
			assert.equal(forced.isError, false, `forced resume of dead foreign run must succeed: ${textFromToolResult(forced)}`);

			const manifestAfter = loadRunManifestById(cwd, runId)!;
			const events = fs.readFileSync(manifestAfter.manifest.eventsPath, "utf-8");
			const forcedEvents = events
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line) as { type?: string; data?: Record<string, unknown> })
				.filter((event) => event.type === "run.resume_forced_foreign");
			assert.equal(forcedEvents.length, 1, "exactly one run.resume_forced_foreign event must be recorded");
			assert.equal(forcedEvents[0]?.data?.ownerSessionId, "session-owner");
			assert.equal(forcedEvents[0]?.data?.forcingSessionId, "session-intruder");
			assert.equal(forcedEvents[0]?.data?.action, "resume");
		} finally {
			rmCwd(cwd);
		}
	});
});
