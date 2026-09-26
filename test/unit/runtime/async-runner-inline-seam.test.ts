/**
 * IN-PROCESS ASYNC TEST SEAM (PI_CREW_TEST_ASYNC_INLINE=1 + PI_CREW_ALLOW_MOCK=1):
 * spawnBackgroundTeamRun must execute the run IN-PROCESS instead of spawning a
 * detached background-runner (async-runner.ts seam; the execution core is
 * background-runner.ts executeBackgroundRun).
 *
 * Why this matters (see the seam doc in async-runner.ts):
 *  1. Windows Defender first-spawn stall (CI run 36093514388 attempt 3):
 *     the detached runner spawn stalled >300s with the task left "queued".
 *  2. Orphan-tmpdir leak: a detached runner survives the test's rmSync and
 *     keeps writing run state into a deleted tree.
 *
 * Mutation guard: the `pid === process.pid` assertion goes RED if the seam
 * breaks — a real spawn returns the CHILD pid, never the test process's.
 * The gate-combo tests go red if the double-env defense-in-depth is weakened.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { isInlineAsyncTestSeamActive, spawnBackgroundTeamRun } from "../../../src/runtime/async-runner.ts";
import { createRunManifest } from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";

/** Minimal team shape — createRunManifest only reads identifying fields off it. */
const MINIMAL_TEAM = {
	name: "inline-seam-fixture",
	description: "inline seam fixture team",
	roles: [],
	defaultWorkflow: "research",
} as unknown as TeamConfig;

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) saved[key] = process.env[key];
	try {
		for (const [key, value] of Object.entries(env)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fn();
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

test("seam gate: inactive by default, needs BOTH PI_CREW_TEST_ASYNC_INLINE and PI_CREW_ALLOW_MOCK", () => {
	withEnv({ PI_CREW_TEST_ASYNC_INLINE: undefined, PI_CREW_ALLOW_MOCK: undefined }, () => {
		assert.equal(isInlineAsyncTestSeamActive(), false, "no env → detached spawn path (production default)");
	});
	withEnv({ PI_CREW_TEST_ASYNC_INLINE: "1", PI_CREW_ALLOW_MOCK: undefined }, () => {
		assert.equal(isInlineAsyncTestSeamActive(), false, "INLINE alone must NOT activate — ALLOW_MOCK is the defense-in-depth gate");
	});
	withEnv({ PI_CREW_TEST_ASYNC_INLINE: undefined, PI_CREW_ALLOW_MOCK: "1" }, () => {
		assert.equal(isInlineAsyncTestSeamActive(), false, "ALLOW_MOCK alone must NOT activate the seam");
	});
	withEnv({ PI_CREW_TEST_ASYNC_INLINE: "1", PI_CREW_ALLOW_MOCK: "1" }, () => {
		assert.equal(isInlineAsyncTestSeamActive(), true, "both envs → in-process execution");
	});
});

test("seam active: spawnBackgroundTeamRun executes in-process (pid=self, no detached child)", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-inline-seam-"));
	try {
		const { manifest, paths } = createRunManifest({
			cwd: dir,
			team: MINIMAL_TEAM,
			goal: "inline seam probe",
			runKind: "goal-loop", // no GoalLoopState exists → core throws fast → async.failed
		});
		fs.mkdirSync(path.dirname(paths.eventsPath), { recursive: true });
		fs.mkdirSync(manifest.stateRoot, { recursive: true });

		const prevInline = process.env.PI_CREW_TEST_ASYNC_INLINE;
		const prevMock = process.env.PI_CREW_ALLOW_MOCK;
		process.env.PI_CREW_TEST_ASYNC_INLINE = "1";
		process.env.PI_CREW_ALLOW_MOCK = "1";
		let result: Awaited<ReturnType<typeof spawnBackgroundTeamRun>>;
		try {
			// The seam gate is read synchronously at function entry, so restoring
			// the env right after the call is safe (spawn() semantics — no await of the run).
			result = await spawnBackgroundTeamRun(manifest);
		} finally {
			if (prevInline === undefined) delete process.env.PI_CREW_TEST_ASYNC_INLINE;
			else process.env.PI_CREW_TEST_ASYNC_INLINE = prevInline;
			if (prevMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
			else process.env.PI_CREW_ALLOW_MOCK = prevMock;
		}
		assert.equal(result.pid, process.pid, "in-process seam returns the TEST process pid — a detached spawn would return a child pid");

		const log = fs.readFileSync(result.logPath, "utf-8");
		assert.match(log, /inline test seam/, "background.log must record the inline host");

		const readEvents = (): Array<Record<string, unknown>> =>
			fs
				.readFileSync(paths.eventsPath, "utf-8")
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
		assert.ok(
			readEvents().some((e) => e.type === "async.spawned" && (e.data as { inline?: boolean })?.inline === true),
			"events must carry async.spawned with data.inline=true",
		);

		// The fire-and-forget inline core must actually run and reach the
		// failure path (bogus goal-loop → async.failed), never silently no-op.
		const deadline = Date.now() + 20_000;
		let failed = false;
		while (Date.now() < deadline) {
			if (readEvents().some((e) => e.type === "async.failed")) {
				failed = true;
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		assert.ok(
			failed,
			"inline execution must terminate with async.failed for a bogus goal-loop manifest (got stale? see background.log)",
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
