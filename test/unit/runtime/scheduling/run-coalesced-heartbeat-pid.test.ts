/**
 * NEW-3 (SDD-4 W-D) — coalesced-group heartbeats must carry the REAL worker pid.
 *
 * Pre-fix measurement (recorded in the SDD-4 execution record):
 *   - 10 production call sites of createWorkerHeartbeat/touchWorkerHeartbeat;
 *     0 pass `pid` → task.heartbeat.pid was NEVER written by production code.
 *   - checkpoint.childPid is written by exactly ONE site — child-executor.ts
 *     (onSpawn → checkpointTask "child-spawned") — the SINGLETON path only.
 *   - Consequence at the two consumers (stale-reconciler.ts and
 *     heartbeat-watcher.ts, both read `heartbeat?.pid ?? checkpoint?.childPid`):
 *     verdicts resolved via the checkpoint fallback on the singleton path, and
 *     to UNDEFINED on the coalesced path (which never calls checkpointTask) —
 *     the PID-liveness gate was completely dead for EVERY task in EVERY
 *     coalesced group: an alive-but-silent coalesced worker could be falsely
 *     repaired/killed.
 *
 * Proven here:
 *   1. Structural — the wiring exists (onSpawn capture → tick → persist).
 *   2. Seam — `__test__persistGroupHeartbeats` stamps pid on create AND touch,
 *      and a pid-less tick never clobbers an already-recorded pid.
 *   3. Behavioral E2E — a REAL spawned worker's pid lands in the PERSISTED task
 *      heartbeat on disk while the worker is alive (pid parity: the heartbeat
 *      pid must equal the sidecar pid the worker process itself reported).
 *
 * The dispatch-time create (run-coalesced-task-group "M6 heartbeats" block and
 * pre-execution.ts) intentionally stays pid-less: the worker does not exist
 * yet at those points, and the singleton path's real pid arrives via
 * checkpoint.childPid (child-executor.ts). The first 15s heartbeat tick stamps
 * the coalesced heartbeat — pid only matters once staleness is suspected
 * (5min threshold), far beyond one tick.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { __test_resetCap, getWorkerCapCapacity } from "../../../../src/runtime/scheduling/global-worker-cap.ts";
import { __test__persistGroupHeartbeats, runCoalescedTaskGroup } from "../../../../src/runtime/scheduling/run-coalesced-task-group.ts";
import { createRunManifest, loadRunManifestById, saveRunTasksAsync } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const SRC_PATH = "src/runtime/scheduling/run-coalesced-task-group.ts";

// Heartbeat tick interval in run-coalesced-task-group.ts (15s setInterval).
// The E2E task timeout must sit ABOVE one tick so the pid-stamped heartbeat
// lands on disk before the abort, and the poll deadline above the timeout.
const HEARTBEAT_TICK_MS = 15_000;
const TASK_TIMEOUT_MS = 20_000;
const POLL_DEADLINE_MS = 23_000;
const RESPONSE_TIMEOUT_MS = 30_000;

const team: TeamConfig = {
	name: "coalesced-hb-pid",
	description: "heartbeat pid test",
	source: "builtin",
	filePath: "builtin",
	roles: [{ name: "worker", agent: "worker" }],
};

const workflow: WorkflowConfig = {
	name: "wf-hb-pid",
	description: "heartbeat pid test",
	steps: [{ id: "batch", role: "worker", task: "Do {goal}" }],
	source: "builtin",
	filePath: "builtin",
};

const agent: AgentConfig = {
	name: "worker",
	description: "heartbeat pid worker",
	source: "builtin",
	filePath: "builtin",
	systemPrompt: "",
};

const GROUP_ID = "group-1";
const SIBLING_ID = "sibling-1";

function makeTmpCwd(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-hb-pid-"));
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeTask(id: string, status: TeamTaskState["status"], runId: string, cwd: string): TeamTaskState {
	return {
		id,
		runId,
		stepId: "batch",
		role: "worker",
		agent: "worker",
		title: id,
		status,
		dependsOn: [],
		cwd,
	};
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
	const snap: Record<string, string | undefined> = {};
	for (const k of keys) snap[k] = process.env[k];
	return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
	for (const [k, v] of Object.entries(snap)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1. Structural wiring ────────────────────────────────────────────

test("NEW-3 structural: coalesced dispatch captures worker pid and threads it into heartbeat persists", () => {
	const src = fs.readFileSync(SRC_PATH, "utf-8");

	// runWorker call must capture the spawned pid (onSpawn fires per attempt —
	// retry/model-fallback overwrites with the latest live pid).
	assert.match(
		src,
		/onSpawn:\s*\(pid\)\s*=>\s*\{\s*workerPid\s*=\s*pid;\s*\}/,
		"runWorker input must capture the real worker pid via onSpawn",
	);

	// The heartbeat tick must forward the captured pid to persistGroupHeartbeats.
	assert.match(
		src,
		/persistGroupHeartbeats\(manifest,\s*taskIds,\s*workerPid\)/,
		"heartbeat timer tick must pass workerPid into persistGroupHeartbeats",
	);

	// The create-fallback inside persistGroupHeartbeats must seed pid at create.
	assert.match(src, /createWorkerHeartbeat\(t\.id,\s*workerPid\)/, "create fallback must seed the worker pid");

	// The touch update must stamp pid WITHOUT clobbering an existing pid when
	// the current tick has no pid (conditional spread — a literal
	// `pid: undefined` would overwrite a previously recorded pid).
	assert.match(
		src,
		/\.\.\.\(workerPid\s*\?\s*\{\s*pid:\s*workerPid\s*\}\s*:\s*\{\}\)/,
		"touch update must conditionally spread pid (never clobber with undefined)",
	);
});

// ── 2. Seam: persistGroupHeartbeats pid stamping ─────────────────────

test("NEW-3 seam: heartbeat CREATE fallback stamps the worker pid (task had no heartbeat)", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "NEW-3 create pid" });
		await saveRunTasksAsync(manifest, [makeTask(GROUP_ID, "running", manifest.runId, cwd)]);

		const WORKER_PID = 4242;
		await __test__persistGroupHeartbeats(manifest, [GROUP_ID], WORKER_PID);

		const after = loadRunManifestById(cwd, manifest.runId)!;
		const task = after.tasks.find((t) => t.id === GROUP_ID)!;
		assert.ok(task.heartbeat, "group task should have a heartbeat after persist");
		assert.equal(task.heartbeat!.pid, WORKER_PID, "created heartbeat must carry the worker pid");
		assert.equal(task.heartbeat!.alive, true, "heartbeat must be alive: true");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("NEW-3 seam: heartbeat TOUCH stamps the worker pid onto a pid-less existing heartbeat", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "NEW-3 touch pid" });
		// Seed a dispatch-time pid-less heartbeat (exactly what the M6 block creates).
		const seeded = makeTask(GROUP_ID, "running", manifest.runId, cwd);
		seeded.heartbeat = { workerId: GROUP_ID, lastSeenAt: new Date().toISOString(), alive: true };
		await saveRunTasksAsync(manifest, [seeded]);

		const WORKER_PID = 5150;
		await __test__persistGroupHeartbeats(manifest, [GROUP_ID], WORKER_PID);

		const after = loadRunManifestById(cwd, manifest.runId)!;
		const task = after.tasks.find((t) => t.id === GROUP_ID)!;
		assert.ok(task.heartbeat, "heartbeat must survive the touch persist");
		assert.equal(task.heartbeat!.pid, WORKER_PID, "existing pid-less heartbeat must receive the worker pid");
		assert.equal(task.heartbeat!.alive, true, "heartbeat must stay alive: true");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("NEW-3 seam: pid-less tick NEVER clobbers an already-recorded pid (undefined-spread guard)", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "NEW-3 no clobber" });
		const seeded = makeTask(GROUP_ID, "running", manifest.runId, cwd);
		// A previous tick recorded pid 4242; the next tick has no pid (worker
		// respawn gap / pre-onSpawn tick). The guard must preserve 4242 —
		// `pid: undefined` in the touch updates would wipe it.
		seeded.heartbeat = { workerId: GROUP_ID, pid: 4242, lastSeenAt: new Date().toISOString(), alive: true };
		await saveRunTasksAsync(manifest, [seeded]);

		await __test__persistGroupHeartbeats(manifest, [GROUP_ID], undefined);

		const after = loadRunManifestById(cwd, manifest.runId)!;
		const task = after.tasks.find((t) => t.id === GROUP_ID)!;
		assert.equal(task.heartbeat?.pid, 4242, "existing pid must survive a pid-less tick");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("NEW-3 seam: sibling task is never touched by the pid-stamping heartbeat save", async () => {
	const cwd = makeTmpCwd();
	try {
		const { manifest } = createRunManifest({ cwd, team, goal: "NEW-3 sibling untouched" });
		await saveRunTasksAsync(manifest, [
			makeTask(GROUP_ID, "running", manifest.runId, cwd),
			makeTask(SIBLING_ID, "running", manifest.runId, cwd),
		]);

		await __test__persistGroupHeartbeats(manifest, [GROUP_ID], 4242);

		const after = loadRunManifestById(cwd, manifest.runId)!;
		const sibling = after.tasks.find((t) => t.id === SIBLING_ID)!;
		assert.equal(sibling.heartbeat, undefined, "sibling outside the group must not gain a heartbeat/pid");
		const group = after.tasks.find((t) => t.id === GROUP_ID)!;
		assert.equal(group.heartbeat?.pid, 4242, "group task must carry the pid");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// ── 3. Behavioral E2E: real spawned worker pid ↔ persisted heartbeat ─

test("NEW-3 behavioral: REAL worker pid lands in the persisted task heartbeat while the worker is alive", async () => {
	// Real child process (NOT PI_TEAMS_MOCK_CHILD_PI): the pid under test must
	// be an actual OS pid. The worker reports its own process.pid to a sidecar
	// file NEXT TO ITS OWN SCRIPT (the child env is allowlist-filtered by
	// buildChildPiSpawnOptions, so a custom env var cannot carry the path),
	// emits one message, then hangs. The 15s heartbeat tick must stamp that
	// exact pid into the persisted task heartbeat BEFORE the task timeout (20s)
	// aborts the worker — pid parity proves the onSpawn → tick → persist wiring
	// end-to-end. Mutation-equivalent: drop the onSpawn capture (or the tick's
	// workerPid argument) and no pid ever appears → poll deadline fails.
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-coal-hb-pid-fakepi-"));
	const scriptPath = path.join(scriptDir, "fake-pi-hang.js");
	const pidFile = path.join(scriptDir, "worker.pid");
	fs.writeFileSync(
		scriptPath,
		[
			"// NEW-3 fixture: report the REAL worker pid (sidecar next to this script),",
			"// emit one message, then hang for the heartbeat tick.",
			"require('node:fs').writeFileSync(require('node:path').join(__dirname, 'worker.pid'), String(process.pid));",
			"process.stdout.write(JSON.stringify({",
			"\ttype: 'message',",
			"\tmessage: { role: 'assistant', content: [{ type: 'text', text: 'started; hanging for the heartbeat tick' }] },",
			"}) + '\\n');",
			"process.on('SIGTERM', () => process.exit(143));",
			"setTimeout(() => {}, 60000);",
		].join("\n"),
	);

	const envSnap = snapshotEnv([
		"PI_TEAMS_PI_BIN",
		"PI_TEAMS_MOCK_CHILD_PI",
		"PI_CREW_ALLOW_MOCK",
		"PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS",
		"PI_CREW_DEPTH",
		"npm_config_prefix",
	]);
	process.env.npm_config_prefix = scriptDir;
	process.env.PI_TEAMS_PI_BIN = scriptPath;
	process.env.PI_TEAMS_CHILD_RESPONSE_TIMEOUT_MS = String(RESPONSE_TIMEOUT_MS);
	delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	delete process.env.PI_CREW_ALLOW_MOCK;
	delete process.env.PI_CREW_DEPTH;

	const prevCap = getWorkerCapCapacity();
	__test_resetCap(4);

	const cwd = makeTmpCwd();
	try {
		const { manifest, tasks } = createRunManifest({ cwd, team, workflow, goal: "NEW-3 pid parity" });
		const groupTasks: TeamTaskState[] = tasks.map((t) => ({ ...t, status: "queued" as const }));
		const step = workflow.steps![0]!;

		const dispatched = runCoalescedTaskGroup({
			manifest,
			tasks: [...groupTasks],
			groupTasks,
			step,
			agent,
			executeWorkers: true,
			workspaceId: "ws-hb-pid-parity",
			// Task timeout ABOVE one heartbeat tick so the pid lands first.
			runtimeConfig: { taskTimeoutMs: TASK_TIMEOUT_MS },
			// Single attempt — deterministic; the assert is about the heartbeat
			// content, not retry semantics.
			reliability: { autoRetry: false },
		});

		// Wait for the worker to report its pid (spawn is 1-3s).
		let workerPid: number | undefined;
		const spawnDeadline = Date.now() + 10_000;
		while (Date.now() < spawnDeadline) {
			if (fs.existsSync(pidFile)) {
				workerPid = Number(fs.readFileSync(pidFile, "utf-8"));
				break;
			}
			await sleep(200);
		}
		assert.ok(workerPid && workerPid > 0, `worker should report its pid via sidecar (pidFile=${pidFile})`);

		// Poll the PERSISTED task state for the pid-stamped heartbeat. It must
		// appear at the first 15s tick — well before the 20s task timeout.
		let observedPid: number | undefined;
		let observedAtMs: number | undefined;
		const pollStart = Date.now();
		while (Date.now() - pollStart < POLL_DEADLINE_MS) {
			const fresh = loadRunManifestById(cwd, manifest.runId);
			const task = fresh?.tasks.find((t) => t.id === groupTasks[0]!.id);
			if (task?.heartbeat?.pid) {
				observedPid = task.heartbeat.pid;
				observedAtMs = Date.now() - pollStart;
				break;
			}
			await sleep(200);
		}
		assert.ok(
			observedPid !== undefined,
			`persisted heartbeat must carry a pid within ${POLL_DEADLINE_MS}ms (tick=${HEARTBEAT_TICK_MS}ms, taskTimeout=${TASK_TIMEOUT_MS}ms) — worker reported pid ${workerPid}`,
		);
		assert.equal(observedPid, workerPid, "persisted heartbeat pid MUST equal the real spawned worker pid");
		assert.ok(observedAtMs! >= HEARTBEAT_TICK_MS - 2_000, `pid observed suspiciously early (${observedAtMs}ms) — wrong tick?`);

		const result = await dispatched;
		// Sanity: the run actually went through the executeWorkers branch and
		// was aborted by the task timeout (not by an early error).
		assert.equal(result.success, false, "hung worker aborted by taskTimeoutMs must not succeed");
		for (const taskId of result.taskIds) {
			const task = result.tasks.find((t) => t.id === taskId)!;
			assert.equal(task.status, "cancelled", `task ${taskId} must end 'cancelled' (got '${task.status}')`);
		}
	} finally {
		__test_resetCap(prevCap);
		restoreEnv(envSnap);
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
	}
});
