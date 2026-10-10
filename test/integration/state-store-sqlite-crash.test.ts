/**
 * U8 (upgrade-spec 2026-10-09) — crash durability: kill -9 DURING batch writes
 * must never leave a half batch. Reopen is always clean.
 *
 * Pattern live-proven in /tmp/pi-crew-verify10-crash/ (round-10 harness,
 * 20/20 iterations; PRAGMA journal_mode=wal + synchronous=1): the child
 * process runs the REAL SqliteRunStateStore (spawned via tsx so the .ts
 * module resolves exactly as in production) in a tight batch loop — each
 * iteration is ONE saveManifestAndTasks transaction (manifest.taskCount=i +
 * N tasks replaced atomically). The parent SIGKILLs the child at a seeded
 * random delay after the first ready signal, then reopens the db with a
 * FRESH handle and asserts the all-or-nothing invariant:
 *
 *   observed task set belongs EXACTLY to the observed manifest batch
 *   (taskCount*k tasks, ids all prefixed t<taskCount>-) — never a mix of
 *   batch k and batch k+1 — and PRAGMA integrity_check is "ok".
 *
 * A kill before the very first commit is also consistent (0 batches).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SqliteRunStateStore, sqliteDbPath } from "../../src/state/stores/sqlite-run-state.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STORE_MODULE = fileURLToPath(new URL("../../src/state/stores/sqlite-run-state.ts", import.meta.url));

/** Tasks per batch — big enough that each transaction runs for measurable
 * time, so a random kill has a real chance to land INSIDE the tx window. */
const TASKS_PER_BATCH = 400;
const BATCH_DESCRIPTION_BYTES = 1024;
const ITERATIONS = 10;

/** Deterministic pseudo-random delay (seeded LCG) so failures reproduce. */
function makeRng(seed: number): () => number {
	let state = seed >>> 0 || 1;
	return () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0xffffffff;
	};
}

const CHILD_SOURCE = `
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
const stateRoot = process.argv[2];
const mod = await import(pathToFileURL(${JSON.stringify(STORE_MODULE)}).href);
const store = mod.getSqliteRunStateStore(stateRoot);
const description = "x".repeat(${String(BATCH_DESCRIPTION_BYTES)});
let i = 0;
// Ready signal AFTER the db exists; batches start immediately after.
fs.writeFileSync(path.join(stateRoot, "child-ready"), String(process.pid));
for (;;) {
	i++;
	const tasks = Array.from({ length: ${String(TASKS_PER_BATCH)} }, (_, k) => ({
		id: "t" + i + "-" + k,
		runId: "u8-crash",
		stepId: "s" + k,
		role: "executor",
		agent: "executor",
		title: "task " + i + "-" + k,
		description,
		status: "queued",
		dependsOn: [],
		cwd: stateRoot,
	}));
	const manifest = {
		schemaVersion: 3,
		runId: "u8-crash",
		sessionId: "u8-crash",
		team: "crash",
		goal: "kill -9 durability",
		status: "running",
		createdAt: "2026-10-10T00:00:00.000Z",
		updatedAt: "batch-" + i,
		cwd: stateRoot,
		stateRoot,
		artifactsRoot: stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
		taskCount: i,
	};
	store.saveManifestAndTasks(manifest, tasks); // ONE transaction per batch
	store.nextSeq("batch");
}
`;

interface CrashIterationResult {
	batchesCommitted: number;
	killedBeforeFirstCommit: boolean;
}

async function runCrashIteration(iteration: number, killDelayMs: number): Promise<CrashIterationResult> {
	const stateRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `u8-crash-${iteration}-`));
	const childScript = path.join(stateRoot, "crash-child.mjs");
	fs.writeFileSync(childScript, CHILD_SOURCE, "utf-8");
	try {
		const child = spawn(process.execPath, ["--import", "tsx/esm", childScript, stateRoot], {
			cwd: REPO_ROOT,
			stdio: "ignore",
		});
		// Wait for the ready marker (child has opened the store, is about to loop).
		const deadline = Date.now() + 15_000;
		while (!fs.existsSync(path.join(stateRoot, "child-ready"))) {
			if (Date.now() > deadline) {
				child.kill("SIGKILL");
				throw new Error(`iteration ${iteration}: child never became ready`);
			}
			await sleep(5);
		}
		await sleep(killDelayMs);
		child.kill("SIGKILL");
		await new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			setTimeout(resolve, 5000).unref?.();
		});

		// ── Reopen with a FRESH handle (true reopen, not the process cache). ──
		const reopened = new SqliteRunStateStore(stateRoot);
		const loaded = reopened.loadManifestAndTasks();
		if (!loaded) {
			// Killed before the first commit: 0 complete batches = consistent.
			reopened.close();
			return { batchesCommitted: 0, killedBeforeFirstCommit: true };
		}
		const { manifest, tasks } = loaded;
		const batch = (manifest as TeamRunManifest & { taskCount?: number }).taskCount ?? 0;
		assert.ok(batch >= 1, `iteration ${iteration}: manifest present but taskCount=${batch} (corrupt batch)`);
		// All-or-nothing: the visible task set belongs EXACTLY to the visible
		// manifest batch — saveManifestAndTasks REPLACES the whole task set per
		// batch (DELETE + INSERT inside one tx), so a consistent state is
		// exactly TASKS_PER_BATCH rows, all from batch `batch`. A torn batch
		// would show a MIX (rows from batch k and k+1) or a count != batch set.
		assert.equal(
			tasks.length,
			TASKS_PER_BATCH,
			`iteration ${iteration}: HALF BATCH — manifest batch ${batch} but ${tasks.length} tasks (expected exactly ${TASKS_PER_BATCH} from batch ${batch})`,
		);
		const prefix = `t${batch}-`;
		for (const task of tasks as TeamTaskState[]) {
			assert.ok(
				task.id.startsWith(prefix),
				`iteration ${iteration}: task ${task.id} does not belong to manifest batch ${batch} — torn batch`,
			);
		}
		const uniqueIds = new Set(tasks.map((t) => t.id));
		assert.equal(uniqueIds.size, tasks.length, `iteration ${iteration}: duplicate task ids — torn batch`);
		// The monotonic seq is inside [batch-1, batch] (bumped right after the
		// batch tx; a kill in between leaves it one behind).
		const seqAfterReopen = reopened.nextSeq("batch");
		assert.ok(
			seqAfterReopen === batch || seqAfterReopen === batch + 1,
			`iteration ${iteration}: seq ${seqAfterReopen} outside [${batch}, ${batch + 1}]`,
		);
		reopened.close();

		// File-level integrity: WAL recovery on open must leave a clean db.
		const raw = new DatabaseSync(sqliteDbPath(stateRoot));
		const integrity = raw.prepare("PRAGMA integrity_check").get() as { integrity_check: string } | undefined;
		raw.close();
		assert.equal(integrity?.integrity_check, "ok", `iteration ${iteration}: integrity_check must be ok after kill -9 reopen`);
		return { batchesCommitted: batch, killedBeforeFirstCommit: false };
	} finally {
		fs.rmSync(stateRoot, { recursive: true, force: true });
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("U8 crash: kill -9 mid-batch never leaves a half batch — reopen is always clean (10 iterations)", { timeout: 120_000 }, async () => {
	const rng = makeRng(20261010);
	const results: CrashIterationResult[] = [];
	for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
		// Kill delay after ready: 5–120ms — spans "inside first tx" through
		// "many batches in", reproducing the verify10 harness spread.
		const delay = Math.floor(5 + rng() * 115);
		results.push(await runCrashIteration(iteration, delay));
	}
	const withBatches = results.filter((r) => r.batchesCommitted > 0);
	const totalBatches = withBatches.reduce((sum, r) => sum + r.batchesCommitted, 0);
	// The loop must have actually committed work in at least one iteration,
	// otherwise this run proves nothing about mid-batch kills.
	assert.ok(
		withBatches.length >= 1 && totalBatches >= 1,
		`no iteration observed a committed batch — kill delays never crossed the first commit (results: ${JSON.stringify(results)})`,
	);
	// Every iteration that observed a manifest also observed its exact task
	// set (asserted per-iteration above); record the evidence shape here.
	console.log(
		`[U8 crash-test] ${ITERATIONS} kill -9 iterations: ` +
			`${withBatches.length}/${ITERATIONS} reopened with committed batches ` +
			`(batches observed: ${results.map((r) => r.batchesCommitted).join(",")}), ` +
			`${results.length - withBatches.length} killed before first commit — ` +
			`0 half batches, all integrity_check=ok`,
	);
});
