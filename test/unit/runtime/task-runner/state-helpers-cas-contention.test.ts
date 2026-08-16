/**
 * state-helpers-cas-contention.test.ts — T-6 (Round 9 transitive-coverage
 * gap, refactor-plan review §ROUND 9 "T-4/5/6 — LOW: task-runner helpers").
 *
 * Drives persistSingleTaskUpdate's mtime-CAS retry loop (state-helpers.ts)
 * against a REAL concurrent writer mutating tasks.json between the base stat
 * and the re-stat — the exact adversary the loop was built for (H5 comment:
 * "retries only fire under real contention from best-effort writers that
 * don't hold the run lock (async-notifier, crash-recovery)").
 *
 * ── SEAM CHOICE (why no module mocks) ──
 * The Round-9 recon proposed `mock.module("node:fs")` with a dynamic import,
 * but that seam is NOT usable in this repo's runner:
 *   - node:test `mock.module` requires --experimental-test-module-mocks and is
 *     `undefined` under the tsx/esm loader used by scripts/test-runner.mjs
 *     (verified: `typeof t.mock.module === "undefined"`).
 *   - Monkey-patching the CJS `require("node:fs").statSync` does not affect
 *     the ESM `import * as fs` namespace state-helpers.ts binds to (verified:
 *     namespace snapshot ignores later CJS export mutation).
 * Both scenarios therefore drive REAL disk state instead:
 *
 *   (a) DETERMINISTIC single contention via the F4 coalesce window itself:
 *       prime `saveRunTasksCoalesced` (buffers for 50ms, no disk write yet),
 *       then call persistSingleTaskUpdate. Attempt 0's mandatory
 *       `flushPendingAtomicWrites()` lands the buffered "other writer" update
 *       between the base stat and the re-stat → mtime drifts → CAS detects
 *       the other writer → retry reloads tasks.json from disk. No timing race
 *       exists: everything is synchronous, and the flush is inside the loop.
 *
 *   (b) SUSTAINED contention via a real child process tight-looping atomic
 *       (tmp+rename) rewrites of tasks.json for ~300ms — a lock-free writer
 *       that keeps invalidating the CAS base. Asserts the loop never throws,
 *       still merges over fresh disk state, and that a follow-up call
 *       converges once the pressure stops.
 *
 * ── EXHAUSTION FINDING (reported, src fix out of scope for this wave) ──
 * The documented exhaustion failure (state-helpers.ts:132-137, "failed to
 * converge after 10 attempts") is currently UNREACHABLE: `merged` is assigned
 * unconditionally on EVERY loop attempt (including attempt 0) before the
 * mtime check, so after 10 contended attempts the loop falls through to the
 * save with the 10th merge instead of throwing. The behavioral tests below
 * assert the ACTUAL exhaustion behavior (no throw + last-merge save under
 * sustained pressure); the source-level test pins the documented contract
 * text so a future fix that makes the guard reachable keeps the message.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { persistSingleTaskUpdate } from "../../../../src/runtime/task-runner/state-helpers.ts";
import { flushPendingAtomicWrites } from "../../../../src/state/atomic-write.ts";
import { createRunManifest, loadRunManifestById, saveRunTasksCoalesced } from "../../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import { sleepSync } from "../../../../src/utils/sleep.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

/** Create a temp dir with .git marker so useProjectState(dir) keeps state inside <dir>/.crew/. */
function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeTempDir("pi-crew-cas-contention-home-");
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** The "other writer": a lock-free child that atomic-rewrites tasks.json every ~2ms. */
function writeStormRewriter(scriptDir: string): string {
	const scriptPath = path.join(scriptDir, "tasks-storm-writer.cjs");
	fs.writeFileSync(
		scriptPath,
		[
			"// T-6 fixture: lock-free concurrent writer (H5 adversary).",
			"const fs = require('node:fs');",
			"const tasksPath = process.argv[2];",
			"const durationMs = Number(process.argv[3] || '300');",
			"const template = JSON.parse(process.argv[4]);",
			"const tmp = tasksPath + '.storm.tmp';",
			"const wait = new Int32Array(new SharedArrayBuffer(4));",
			"const end = Date.now() + durationMs;",
			"let n = 0;",
			"while (Date.now() < end) {",
			"\tn++;",
			"\tconst tasks = template.map((t) => (t.id === 'other-writer-b' ? { ...t, tick: n } : t));",
			"\tfs.writeFileSync(tmp, JSON.stringify(tasks));",
			"\tfs.renameSync(tmp, tasksPath); // atomic swap — readers never see torn content",
			"\tAtomics.wait(wait, 0, 0, 2);",
			"}",
		].join("\n"),
	);
	return scriptPath;
}

// ── Tests ───────────────────────────────────────────────────────────

test("T-6 (a): other-writer commits mid-CAS → retry reloads from disk → success within MAX_CAS_ATTEMPTS", () => {
	withIsolatedHome(() => {
		const cwd = makeTempDir("pi-crew-cas-contention-a-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "cas contention deterministic" });
			// Guarantee an mtime delta between createRunManifest's write and the
			// flushed "other writer" write on coarse-mtime filesystems.
			sleepSync(25);

			const taskA = created.tasks[0];
			assert.ok(taskA, "expected at least one task from createRunManifest");

			// The other writer's committed state: A still running + a NEW task B
			// they completed. B is the canary: it exists ONLY on disk, so its
			// presence in the result proves the retry reloaded tasks.json.
			const taskB: TeamTaskState = {
				...taskA,
				id: "other-writer-b",
				status: "completed",
				finishedAt: new Date().toISOString(),
			};
			const otherWriterTasks: TeamTaskState[] = [{ ...taskA, status: "running" }, taskB];
			assert.ok(!created.tasks.some((t) => t.id === taskB.id), "precondition: fallbackTasks must NOT contain B");

			// PRIME the F4 seam: buffer the other writer's write (50ms coalesce
			// window, unref'd timer cannot fire during the synchronous call below).
			saveRunTasksCoalesced(created.manifest, otherWriterTasks);

			// Our update (as the task-runner would persist it). skipCoalesce=true
			// so the final merged save lands on disk immediately for assertions.
			const updated: TeamTaskState = {
				...taskA,
				status: "completed",
				finishedAt: new Date().toISOString(),
			};
			const result = persistSingleTaskUpdate(created.manifest, created.tasks, updated, undefined, true);

			// The retry MUST have merged over the FRESH disk state (which contains
			// B), not the stale fallbackTasks. Without the mtime CAS check, the
			// attempt-0 merge (fallbackTasks, no B) would be saved and B would be
			// lost — the exact clobbering race the loop exists to prevent.
			assert.equal(result.length, 2, "retry must merge over fresh disk state (A + B), not the stale fallback (A only)");
			const returnedA = result.find((t) => t.id === taskA.id);
			const returnedB = result.find((t) => t.id === taskB.id);
			assert.ok(returnedB, "other writer's task B must survive — proves the CAS retry reloaded tasks.json");
			assert.equal(returnedA?.status, "completed", "our update must be applied on top of the fresh state");
			assert.equal(returnedB.status, "completed", "other writer's B content must be preserved verbatim");

			// The converged merge landed on disk (skipCoalesce=true → immediate).
			const onDisk = JSON.parse(fs.readFileSync(created.manifest.tasksPath, "utf-8")) as TeamTaskState[];
			assert.ok(
				onDisk.some((t) => t.id === taskA.id && t.status === "completed"),
				"disk must contain our completed A",
			);
			assert.ok(
				onDisk.some((t) => t.id === taskB.id),
				"disk must contain the other writer's B",
			);
		} finally {
			flushPendingAtomicWrites();
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("T-6 (b): sustained lock-free writer pressure — no convergence error, merge still lands, then converges", async () => {
	// Async body: manage PI_TEAMS_HOME isolation manually so it spans every
	// await (the sync withIsolatedHome helper would restore the env at the first
	// suspension point, before loadRunManifestById below runs).
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeTempDir("pi-crew-cas-contention-home-b-");
	process.env.PI_TEAMS_HOME = home;
	const cwd = makeTempDir("pi-crew-cas-contention-b-");
	const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-cas-contention-bin-"));
	let child: ReturnType<typeof spawn> | undefined;
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "cas contention sustained" });
		sleepSync(25);

		const taskA = created.tasks[0];
		assert.ok(taskA);
		const taskB: TeamTaskState = { ...taskA, id: "other-writer-b", status: "running" };
		const stormTemplate: TeamTaskState[] = [{ ...taskA, status: "running" }, taskB];
		const updated: TeamTaskState = {
			...taskA,
			status: "completed",
			finishedAt: new Date().toISOString(),
		};

		// Start the lock-free storm writer.
		const rewriter = writeStormRewriter(scriptDir);
		child = spawn(process.execPath, [rewriter, created.manifest.tasksPath, "300", JSON.stringify(stormTemplate)], { stdio: "ignore" });
		const childExited = new Promise<void>((resolve) => {
			child!.on("close", () => resolve());
		});
		sleepSync(60); // let the storm reach steady state before the persist

		// Prime the F4 seam as well: guarantees ≥1 CAS retry (attempt 0's
		// flush lands this write mid-CAS) even if a storm write were to miss
		// the window, so "B present in the merge" below is deterministic.
		saveRunTasksCoalesced(created.manifest, stormTemplate);

		// Persist DURING the storm. If the exhaustion guard were reachable
		// and fired here, this would throw "failed to converge after 10
		// attempts" — the actual behavior under sustained contention is a
		// last-merge save (see header finding), so this call must settle.
		const during = persistSingleTaskUpdate(created.manifest, created.tasks, updated, undefined, true);

		assert.ok(Array.isArray(during) && during.length >= 1, "must return the merged task array (no throw)");
		assert.equal(during.find((t) => t.id === taskA.id)?.status, "completed", "our update must be in the under-pressure merge");
		assert.ok(
			during.some((t) => t.id === taskB.id),
			"merge must derive from disk state containing B (≥1 retry via the primed flush)",
		);

		// Once the pressure stops, a follow-up persist (with a fresh
		// fallback, as the caller contract requires) converges on the first
		// attempt and durably lands the merge.
		await childExited;
		const fresh = loadRunManifestById(cwd, created.manifest.runId)?.tasks ?? [];
		const settled = persistSingleTaskUpdate(created.manifest, fresh, updated, undefined, true);
		assert.equal(settled.find((t) => t.id === taskA.id)?.status, "completed");

		const onDisk = JSON.parse(fs.readFileSync(created.manifest.tasksPath, "utf-8")) as TeamTaskState[];
		assert.ok(
			onDisk.some((t) => t.id === taskA.id && t.status === "completed"),
			"post-storm persist must land our completed A on disk",
		);
		assert.ok(
			onDisk.some((t) => t.id === taskB.id),
			"post-storm persist must preserve the concurrent writer's B",
		);
		const diskB = onDisk.find((t) => t.id === taskB.id) as (TeamTaskState & { tick?: number }) | undefined;
		assert.ok(typeof diskB?.tick === "number" && diskB.tick >= 1, "storm writer's tick marker must be present on B");
	} finally {
		child?.kill();
		flushPendingAtomicWrites();
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(scriptDir, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("T-6 (source-level): exhaustion error path mirrors MAX_CAS_ATTEMPTS=10 and guards the loop exit", () => {
	const sourcePath = fileURLToPath(new URL("../../../../src/runtime/task-runner/state-helpers.ts", import.meta.url));
	const source = fs.readFileSync(sourcePath, "utf-8");

	// H5: the loop bound is the same constant both error paths reference
	// (FIX-05 regression guard — the old messages hardcoded a stale "50").
	assert.match(source, /const MAX_CAS_ATTEMPTS = 10/, "H5 lowered the bound to a MAX_CAS_ATTEMPTS=10 constant");
	assert.match(source, /attempt < MAX_CAS_ATTEMPTS/, "loop bound must use the constant");
	assert.match(
		source,
		/failed to converge after \$\{MAX_CAS_ATTEMPTS\} attempts/,
		"the documented exhaustion error text must reference MAX_CAS_ATTEMPTS (state-helpers.ts:132-137)",
	);
	assert.match(source, /if \(merged === undefined\)/, "the exhaustion error must be guarded on merged === undefined");

	// Structural fact the behavioral tests rely on (and the dead-branch finding):
	// merged is assigned unconditionally on every attempt, INCLUDING attempt 0,
	// before the mtime check — so the guard above cannot fire today. If a future
	// fix makes exhaustion reachable, keep the message and the behavioral tests
	// above will need updating to expect the throw.
	assert.match(source, /merged = updateTask\(latest, taskWithCheckpoint\);/);
});
