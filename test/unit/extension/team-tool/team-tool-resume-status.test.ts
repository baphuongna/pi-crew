/**
 * RELIABILITY regression test — bug #3 (2026-10-10, wave-2/wave-3 resume
 * observations): `team action=resume` returned a bare
 *   "Status: completed"
 * which read as "the whole run just finished" — while the resume had re-queued
 * real work that kept executing (wave-2/wave-3 both observed the misleading
 * instant-`completed` message). The message must report the truth: what the
 * resumed execution returned, how much work was re-queued at resume, and the
 * per-status task breakdown.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { textFromToolResult } from "../../../../src/extension/tool-result.ts";
import { loadRunManifestById, saveRunManifestAsync, saveRunTasks } from "../../../../src/state/stores/state-store.ts";

const realTmp = fs.realpathSync(os.tmpdir());

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-status-home-"));
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

function rmCwd(cwd: string): void {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			fs.rmSync(cwd, { recursive: true, force: true });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
				console.error(`resume-status teardown: unable to remove ${cwd}: ${String(error)}`);
				break;
			}
		}
	}
}

/** Seed a completed scaffold run (hermetic — no child Pi spawns) and return its runId. */
async function seedCompletedRun(cwd: string, sessionId: string): Promise<string> {
	const run = await handleTeamTool(
		{
			action: "run",
			config: { runtime: { mode: "scaffold" } },
			team: "fast-fix",
			goal: "resume status truth",
		},
		{ cwd, sessionId },
	);
	const runId = run.details.runId;
	assert.ok(runId, "seed run must produce a runId");
	assert.equal(run.isError, false, `seed run must succeed: ${textFromToolResult(run)}`);
	return runId;
}

test("bug #3: resume message reports re-queued work — no bare 'Status: completed'", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-status-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");

			// Simulate a crashed run: status failed + one task failed on disk.
			const loaded = loadRunManifestById(cwd, runId);
			assert.ok(loaded, "seeded run loadable");
			assert.ok(loaded.tasks.length >= 1, "seeded run has at least one task");
			const failedTasks = loaded.tasks.map((task, index) =>
				index === 0 ? { ...task, status: "failed" as const, error: "simulated crash for resume-status test" } : task,
			);
			await saveRunManifestAsync(
				{ ...loaded.manifest, status: "failed", summary: "simulated crash", updatedAt: new Date().toISOString() },
				{ allowTerminalExit: true },
			);
			saveRunTasks(loaded.manifest, failedTasks);

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(resumed.isError, false, `resume must succeed: ${textFromToolResult(resumed)}`);
			const text = textFromToolResult(resumed);

			// The re-queued work is reported — the message can no longer read as
			// "everything finished instantly".
			assert.match(text, /Resumed work: 1 task\(s\) re-queued/, `expected re-queue count in: ${text}`);
			// Status line carries resume context, not the old bare status.
			assert.doesNotMatch(text, /^Status: completed$/m, "the bare 'Status: completed' line must be gone");
			assert.match(text, /Status: completed — resumed execution finished/, `expected truthful status line in: ${text}`);
			// Per-status task breakdown is present.
			assert.match(text, /Tasks: \d+ \(\d+ completed/, `expected task-count breakdown in: ${text}`);
			// Live-status pointer so the user can verify rather than trust.
			assert.match(text, /team action=status runId=/, `expected status hint in: ${text}`);
		} finally {
			rmCwd(cwd);
		}
	});
});

test("bug #3: resume of an already-terminal run says so explicitly (0 re-queued)", async () => {
	await withIsolatedHome(async () => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-resume-terminal-"));
		fs.mkdirSync(path.join(cwd, ".crew"));
		try {
			const runId = await seedCompletedRun(cwd, "session-owner");

			const resumed = await handleTeamTool({ action: "resume", runId }, { cwd, sessionId: "session-owner" });
			assert.equal(resumed.isError, false, `resume must succeed: ${textFromToolResult(resumed)}`);
			const text = textFromToolResult(resumed);
			// The instant-return case (nothing to resume) is now explicit instead
			// of a misleading bare "Status: completed".
			assert.match(
				text,
				/Resumed work: 0 task\(s\) re-queued \(run was already terminal — nothing to resume\)/,
				`expected explicit zero-requeue wording in: ${text}`,
			);
		} finally {
			rmCwd(cwd);
		}
	});
});
