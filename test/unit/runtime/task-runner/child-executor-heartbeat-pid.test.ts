/**
 * FIX-2 (live catch, run team_20261030044630): child-executor heartbeat pid
 * pinning. In that run EVERY task heartbeat had pid:undefined — the
 * heartbeat-watcher PID-liveness gate (heartbeat?.pid ?? checkpoint?.childPid,
 * which downgrades dead→stale while the worker process is alive) had nothing
 * to read, so a >5min-silent-but-alive worker could not be vindicated.
 *
 * child-executor now pins the current attempt's worker pid into
 * task.heartbeat on every persistHeartbeat touch (attemptWorkerPid, set by
 * onSpawn; hoisted to task scope + reset per attempt). Mock-mode workers
 * never spawn, so onSpawn never fires in-process — the POSITIVE direction
 * (pid appears once the worker spawns) is pinned by the helper-contract test
 * below at the exact call shapes the executor uses. What this executor-level
 * test pins is the hygiene invariant from the same live run: a STALE pid
 * from a previous attempt must NEVER survive into the new attempt's
 * heartbeat (the dispatch rewrite creates a fresh heartbeat and the
 * per-attempt reset keeps attemptWorkerPid undefined until the new spawn).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { createWorkerHeartbeat, touchWorkerHeartbeat } from "../../../../src/runtime/heartbeat/worker-heartbeat.ts";
import { runTeamTask } from "../../../../src/runtime/task-runner.ts";
import { createRunManifest, loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { createTrackedTempDir } from "../../../fixtures/test-tempdir.ts";
import { removeDirWithRetry } from "../../../helpers/rm-retry.ts";

const team = {
	name: "t",
	description: "",
	source: "test",
	filePath: "t",
	roles: [{ name: "r", agent: "a" }],
} as const;
const workflow = {
	name: "w",
	description: "",
	source: "test",
	filePath: "w",
	steps: [{ id: "s", role: "r", task: "x" }],
} as const;
const agent = {
	name: "a",
	description: "",
	source: "test",
	filePath: "a",
	systemPrompt: "test",
} as const;

test("worker-heartbeat helper contract: pid survives create + touch (the call shapes child-executor uses)", () => {
	const created = createWorkerHeartbeat("t1", 4242);
	assert.equal(created.pid, 4242, "createWorkerHeartbeat(workerId, pid) must carry the pid");
	assert.equal(created.alive, true);
	// The guarded pin shape: touch with an explicit pid overwrites (new
	// attempt's incarnation wins — matches onSpawn semantics).
	const retpinned = touchWorkerHeartbeat(created, { pid: 5252 });
	assert.equal(retpinned.pid, 5252);
	assert.equal(retpinned.lastSeenAt > created.lastSeenAt || retpinned.lastSeenAt === created.lastSeenAt, true);
	// The no-pid shape: touch with NO updates must not disturb the pid.
	const touched = touchWorkerHeartbeat(retpinned);
	assert.equal(touched.pid, 5252, "empty touch must preserve the existing pid");
});

test("executor seam: a stale pre-attempt pid never survives into the new attempt's heartbeat (mock worker)", async () => {
	let cwd = createTrackedTempDir("pi-crew-heartbeat-pid-");
	try {
		const r = fs.realpathSync.native(cwd);
		cwd = r.startsWith("\\\\?\\") ? r.slice(4) : r;
	} catch {
		/* keep as-is */
	}
	const saved: Record<string, string | undefined> = {
		PI_CREW_ALLOW_MOCK: process.env.PI_CREW_ALLOW_MOCK,
		PI_TEAMS_MOCK_CHILD_PI: process.env.PI_TEAMS_MOCK_CHILD_PI,
		PI_TEAMS_MOCK_STEER_WINDOW_MS: process.env.PI_TEAMS_MOCK_STEER_WINDOW_MS,
		PI_CREW_HEARTBEAT_PULSE_MS: process.env.PI_CREW_HEARTBEAT_PULSE_MS,
	};
	// json-slow-success gives a short deterministic running window; the pulse
	// is shrunk to 100ms so persistHeartbeat fires at least once mid-attempt
	// while attemptWorkerPid is still undefined (mocks never call onSpawn —
	// exactly the worst case for an unguarded pid spread).
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-slow-success";
	process.env.PI_TEAMS_MOCK_STEER_WINDOW_MS = "1200";
	process.env.PI_CREW_HEARTBEAT_PULSE_MS = "100";
	try {
		fs.writeFileSync(path.join(cwd, "package.json"), "{}", "utf-8");
		const created = createRunManifest({ cwd, team: team as never, workflow: workflow as never, goal: "pid-pin" });
		const task = created.tasks[0]!;
		// Pre-seed a STALE pid from a "previous attempt" (crash-resume shape):
		const seeded = {
			...task,
			heartbeat: { workerId: task.id, pid: 999_999, lastSeenAt: "2026-01-01T00:00:00.000Z", alive: true },
		};
		await runTeamTask({
			manifest: created.manifest,
			tasks: [seeded],
			task: seeded,
			step: workflow.steps[0] as never,
			agent: agent as never,
			executeWorkers: true,
			runtimeKind: "child-process",
			workspaceId: cwd,
		});
		const final = loadRunManifestById(cwd, created.manifest.runId);
		const finalTask = final?.tasks[0];
		assert.equal(finalTask?.status, "completed", "mock worker run must complete");
		assert.ok(finalTask?.heartbeat?.lastSeenAt, "heartbeat must be touched during the attempt");
		assert.notEqual(
			finalTask?.heartbeat?.pid,
			999_999,
			`stale pre-attempt pid must NOT survive into the new attempt's heartbeat (got ${finalTask?.heartbeat?.pid}) — a watcher checking it would probe a dead/recycled pid`,
		);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await removeDirWithRetry(cwd);
	}
});
