/**
 * SDD-4 WI-6 (W-C2) — async-resume stale detached-runner pointer.
 *
 * Battery finding 1 (docs/real-test/reports/real-test-2026-10-02-sdd3-wc-battery.md):
 * resume of a COMPLETED async run flipped to failed 14s in — a status poll
 * during the resume window read the manifest's dispatch-time `async: { pid }`
 * block (the detached runner, already dead) while the freshly adopted manifest
 * said status=running, so transitionStaleAsyncUnderLock (status.ts) flipped
 * the LIVE resumed run to failed ("Async process stale: process does not
 * exist") and cancelled its tasks. The sync contrast passed — sync manifests
 * never carry an async block.
 *
 * Root cause: handleResume never re-spawns a detached runner (all three arms —
 * static executeTeamRun, DWF, goal-loop — re-execute in the resuming
 * session's process) yet never reconciled manifest.async with that fact; the
 * adopted manifest kept the dead pointer through the whole re-execution
 * window. Fix: adoption DROPS manifest.async (static path + special-kind
 * adoption) and audits the drop on run.resume_requested (data.clearedAsyncPid).
 * Liveness of a resumed run is carried by registerActiveRun + ownerSessionId —
 * exactly like a foreground sync run.
 *
 * Red-first evidence: on pre-fix HEAD test 1 fails (the async block survives
 * resume on the final manifest; no clearedAsyncPid audit) and test 5 fails
 * (special-kind adoption keeps the pointer). Tests 2-4 pin the invariants that
 * must NOT regress: genuine dead-runner detection (fix lives in resume, not in
 * the stale detector), G12 live-pid refusal, and the sync contrast.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { createRunManifest, loadRunManifestById, saveRunManifest, saveRunManifestAsync } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
const realTmp = fs.realpathSync(os.tmpdir());

// These tests resume a PROJECT-sourced .dwf.ts script (test 5), which the
// F-01 trust gate denies unless PI_CREW_TRUST_PROJECT_DWF=1 (mirrors
// team-tool-resume-runkind.test.ts).
const prevTrust = process.env.PI_CREW_TRUST_PROJECT_DWF;
process.env.PI_CREW_TRUST_PROJECT_DWF = "1";
test.after(() => {
	if (prevTrust === undefined) delete process.env.PI_CREW_TRUST_PROJECT_DWF;
	else process.env.PI_CREW_TRUST_PROJECT_DWF = prevTrust;
});

/** Isolate PI_TEAMS_HOME (the TEAMS??CREW mirror winner) so registerActiveRun /
 * activeRunEntries in this file never touch the real user registry. Mirrors
 * team-tool-resume-liveness.test.ts. */
function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-async-home-"));
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

/** macOS-CI teardown hardening — mirrors team-tool-resume-liveness.test.ts. */
function rmCwd(cwd: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
				console.error(`resume-async teardown: unable to remove ${cwd}: ${String(error)}`);
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
			goal: "async resume stale pointer",
		},
		{ cwd, sessionId },
	);
	const runId = run.details.runId;
	assert.ok(runId, "seed run must produce a runId");
	assert.equal(run.isError, false, `seed run must succeed: ${textFromToolResult(run)}`);
	return runId;
}

/**
 * Attach the battery's async-block state to a manifest on disk: the run was
 * dispatched with a detached runner (async.spawned wrote `async: { pid, ... }`),
 * the runner finalized the run to completed, and NOTHING cleared the block —
 * `pid` points at the now-dead original runner. This is byte-for-byte the
 * state the 2026-10-02 battery resumed.
 */
async function attachDeadAsyncBlock(cwd: string, runId: string, pid: number): Promise<void> {
	const loaded = loadRunManifestById(cwd, runId);
	assert.ok(loaded, "run must be loadable before attaching the async block");
	await saveRunManifestAsync(
		{
			...loaded.manifest,
			async: {
				pid,
				logPath: path.join(loaded.manifest.stateRoot, "background.log"),
				spawnedAt: new Date().toISOString(),
			},
		},
		{ allowTerminalExit: true },
	);
}

/** A REAL dead pid: spawn a short-lived process synchronously and return its
 * (exited, reaped) pid — the exact battery condition of a detached runner that
 * finished its run. */
function spawnDeadPid(): number {
	const done = spawnSync(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore", timeout: 10_000 });
	assert.equal(done.status, 0, `dead-pid probe must exit cleanly (status=${done.status})`);
	assert.ok(typeof done.pid === "number" && done.pid > 0, "spawnSync must report the child pid");
	return done.pid;
}

/** Read events.jsonl and parse one line per event. */
function readEvents(manifest: TeamRunManifest): Array<Record<string, unknown>> {
	const raw = fs.readFileSync(manifest.eventsPath, "utf-8");
	return raw
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("W-C2: resume of a completed ASYNC run drops the dead detached-runner pointer and completes", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-async-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");
			const deadPid = spawnDeadPid();
			await attachDeadAsyncBlock(cwd, runId, deadPid);

			// The battery action: resume the async-completed run.
			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(resumed.isError, false, `resume of an async-completed run must succeed: ${textFromToolResult(resumed)}`);
			assert.match(textFromToolResult(resumed), /Status: completed/, "resumed run must complete, not fail");

			const after = loadRunManifestById(cwd, runId);
			assert.ok(after, "manifest must exist after resume");
			assert.equal(after.manifest.status, "completed");
			// ROOT-CAUSE PIN: the stale detached-runner pointer must be GONE — its
			// presence on an adopted running manifest is exactly what
			// transitionStaleAsyncUnderLock reads to kill the live resumed run.
			// RED on pre-fix HEAD: the block survived the whole resume.
			assert.equal(after.manifest.async, undefined, "resume must drop manifest.async (no runner is re-spawned)");

			const events = readEvents(after.manifest);
			assert.ok(
				events.every((event) => event.type !== "async.stale"),
				"no async.stale event may be emitted for the resumed run",
			);
			// Audit trail: the dropped pointer is recorded, not silently vanished.
			const resumeRequested = events.filter((event) => event.type === "run.resume_requested");
			assert.ok(resumeRequested.length >= 1, "resume must log run.resume_requested");
			const last = resumeRequested[resumeRequested.length - 1]?.data as Record<string, unknown> | undefined;
			assert.equal(last?.clearedAsyncPid, deadPid, "run.resume_requested must audit clearedAsyncPid");
		} finally {
			rmCwd(cwd);
		}
	});
});

test("W-C2 guard: genuine dead detached runners STILL flip via status — the fix lives in resume, not the stale detector", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-killchain-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");
			const deadPid = spawnDeadPid();
			await attachDeadAsyncBlock(cwd, runId, deadPid);

			// Simulate a CRASHED detached runner (not a resume): active status on
			// disk + dead pid + no registry entry — the exact state the stale-async
			// transition exists for. It must keep working after WI-6.
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded);
			await saveRunManifestAsync(
				{ ...loaded.manifest, status: "running", updatedAt: new Date().toISOString() },
				{ allowTerminalExit: true },
			);

			const status = await handleTeamTool({ action: "status", runId }, { cwd, sessionId: "session-owner" });
			assert.match(textFromToolResult(status), /Async process stale/, "a genuinely dead runner must still be detected");
			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			assert.equal(after.manifest.status, "failed", "dead detached runner must flip the run to failed");
			assert.ok(
				readEvents(after.manifest).some((event) => event.type === "async.stale"),
				"async.stale event must be recorded",
			);
		} finally {
			rmCwd(cwd);
		}
	});
});

test("G12 pin: resume still REFUSES a run whose detached async pid is ALIVE (gate reads before adoption)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-livepid-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");
			await attachDeadAsyncBlock(cwd, runId, child.pid!);
			// Signal-3 liveness requires an ACTIVE, FRESH manifest with the live pid.
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded);
			await saveRunManifestAsync(
				{ ...loaded.manifest, status: "running", updatedAt: new Date().toISOString() },
				{ allowTerminalExit: true },
			);

			const plain = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(plain.isError, true, "resume of a live-detached-runner run must REFUSE");
			assert.match(textFromToolResult(plain), /live/i);
			assert.match(textFromToolResult(plain), new RegExp(`PID ${child.pid} is alive`));

			const forced = await handleTeamTool({ action: "resume", runId, force: true }, { cwd, sessionId: "session-owner" });
			assert.equal(forced.isError, true, "force:true must never bypass liveness (G12/G4)");
			assert.match(textFromToolResult(forced), /live/i);
		} finally {
			child.kill("SIGKILL");
			rmCwd(cwd);
		}
	});
});

test("sync contrast: resume of a completed SYNC run (no async block) still completes", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-synccontrast-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded);
			assert.equal(loaded.manifest.async, undefined, "sync seed must not carry an async block");

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(resumed.isError, false, `sync contrast resume must stay green: ${textFromToolResult(resumed)}`);
			assert.match(textFromToolResult(resumed), /Status: completed/);
			const after = loadRunManifestById(cwd, runId);
			assert.ok(after);
			assert.equal(after.manifest.status, "completed");
			assert.equal(after.manifest.async, undefined);
		} finally {
			rmCwd(cwd);
		}
	});
});

test("W-C2: special-kind adoption (dynamic-workflow) drops the stale async pointer too", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-dwfasync-"));
		fs.mkdirSync(path.join(cwd, ".crew", "workflows"), { recursive: true });
		try {
			// Project-sourced dynamic workflow whose script just reports a result
			// (mirrors team-tool-resume-runkind.test.ts).
			const artifactPath = path.join(cwd, "dwf-resume-async-result.txt");
			fs.writeFileSync(artifactPath, "dwf resume async ok\n");
			fs.writeFileSync(
				path.join(cwd, ".crew", "workflows", "runkind-echo-async.dwf.ts"),
				`export default async function run(ctx) {\n\tctx.setResult(${JSON.stringify(artifactPath)});\n}\n`,
			);

			const created = createRunManifest({
				cwd,
				team: {
					name: "placeholder",
					description: "",
					source: "project",
					filePath: "<test>",
					roles: [{ name: "worker", agent: "executor" }],
				},
				goal: "resume drops stale async pointer",
				runKind: "dynamic-workflow",
			});
			const deadPid = spawnDeadPid();
			const manifest: TeamRunManifest = {
				...created.manifest,
				team: `dwf-${created.manifest.runId.slice(-12)}`,
				workflow: "runkind-echo-async",
				status: "failed",
				summary: "simulated crashed dwf run with a dead detached runner",
				updatedAt: new Date().toISOString(),
				async: {
					pid: deadPid,
					logPath: path.join(created.manifest.stateRoot, "background.log"),
					spawnedAt: new Date().toISOString(),
				},
			};
			saveRunManifest(manifest);

			const resumed = await handleTeamTool({ action: "resume", runId: manifest.runId }, { cwd, sessionId: "session-resumer" });
			assert.equal(resumed.isError, false, `dwf resume must succeed: ${textFromToolResult(resumed)}`);

			const after = loadRunManifestById(cwd, manifest.runId);
			assert.ok(after);
			assert.equal(after.manifest.status, "completed", "DWF engine must complete the resumed run");
			// RED on pre-fix HEAD: special-kind adoption kept the dead pointer.
			assert.equal(after.manifest.async, undefined, "special-kind adoption must drop manifest.async");
			const events = readEvents(after.manifest);
			const resumeRequested = events.filter((event) => event.type === "run.resume_requested");
			assert.ok(resumeRequested.length >= 1, "dwf resume must log run.resume_requested");
			const last = resumeRequested[resumeRequested.length - 1]?.data as Record<string, unknown> | undefined;
			assert.equal(last?.clearedAsyncPid, deadPid, "dwf run.resume_requested must audit clearedAsyncPid");
		} finally {
			rmCwd(cwd);
		}
	});
});
