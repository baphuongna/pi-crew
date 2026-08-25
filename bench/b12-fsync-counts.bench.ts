/**
 * b12 — fsync-call COUNT micro-benchmark (perf round 2 verification).
 *
 * Counts `fs.fsyncSync` calls issued by the state layer's single-event /
 * checkpoint / mailbox-mark write paths, verifying the 2026-08-25 durability
 * trims landed:
 *
 *   - T1: sync event-log lock pid file is now an O_EXCL ("wx") plain write
 *     (event-log.ts withEventLogLockSync) — was atomicWriteFile "full"
 *     (2 fsync: data + parent dir) per lock acquire.
 *   - F3a (round 1): non-terminal events skip the data fsync; terminal
 *     events keep exactly one.
 *   - T2: appendEventBuffered batches skip the fsync when the whole batch is
 *     non-terminal.
 *   - T3: non-terminal tasks checkpoints accept best-effort durability when
 *     env PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC=1 (driven end-to-end through
 *     persistSingleTaskUpdate → loadConfig, exactly like production).
 *   - T4: mailbox delivery.json marks default to best-effort.
 *
 * SPY DESIGN: the unit-test suite (test/unit/state/state-store-tasks-fsync
 * .test.ts) spies via the CJS-default swap with fd→path attribution; that is
 * heavier than a bench needs. Benches run in their OWN node process, so we
 * simply monkey-patch `fs.fsyncSync` on the CJS default export BEFORE the
 * modules under test are imported (plus module.syncBuiltinESMExports() so
 * their `import * as fs from "node:fs"` namespaces see the patch) and count
 * EVERY call in the measured window. Every src fsync site on these paths is
 * the sync `fs.fsyncSync` form (the async atomic path's `fh.sync()` is not
 * used by any operation measured here). Stray background timers (20ms event
 * buffer, 50ms atomic coalesce) are drained by settle() and the counter is
 * reset immediately before each measured window, so the whole-process count
 * IS the operation's count.
 *
 * Output contract (scripts/run-bench.mjs): human lines first, then ONE final
 * NDJSON line `{"name":"b12.fsync-counts","cases":{...}}` — the runner parses
 * the LAST JSON line on stdout.
 *
 * Run standalone:
 *   node --experimental-strip-types bench/b12-fsync-counts.bench.ts
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Spy — installed BEFORE importing anything from src/.
// ---------------------------------------------------------------------------
const nodeRequire = createRequire(import.meta.url);
const fsDefault = nodeRequire("node:fs") as {
	fsyncSync: (...args: unknown[]) => unknown;
};
const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
const originalFsyncSync = fsDefault.fsyncSync;
let fsyncCalls = 0;
fsDefault.fsyncSync = (...args: unknown[]) => {
	fsyncCalls++;
	return originalFsyncSync(...args);
};
nodeModule.syncBuiltinESMExports();

// Modules under test — imported AFTER the spy is live.
const { appendEvent, appendEventBuffered, flushEventLogBuffer } = await import("../src/state/event-log/event-log.ts");
const { appendMailboxMessage } = await import("../src/state/coordination/mailbox.ts");
const { flushPendingAtomicWrites } = await import("../src/state/atomic-write.ts");
const { createRunManifest, loadRunManifestById } = await import("../src/state/stores/state-store.ts");
const { persistSingleTaskUpdate } = await import("../src/runtime/task-runner/state-helpers.ts");
const { invalidateConfigCache } = await import("../src/config/config.ts");

type AppendTeamEvent = Parameters<typeof appendEvent>[1];
type MailboxManifest = Parameters<typeof appendMailboxMessage>[0];

const tmpRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-b12-"));

/** Drain every deferred-write mechanism so nothing fires inside a later
 *  measured window: buffered event batches (20ms), coalesced atomic writes
 *  (50ms), then one macrotask turn past both windows. */
async function settle(): Promise<void> {
	await flushEventLogBuffer();
	flushPendingAtomicWrites();
	await new Promise((resolve) => setTimeout(resolve, 80));
	await flushEventLogBuffer();
	flushPendingAtomicWrites();
}

interface CaseResult {
	fsyncCalls: number;
	expectation: string;
	pass: boolean;
	wallMs: number;
}

let failures = 0;
const cases: Record<string, CaseResult> = {};

function recordCase(name: string, expectation: string, calls: number, pass: boolean, wallMs: number): CaseResult {
	const result: CaseResult = { fsyncCalls: calls, expectation, pass, wallMs: round(wallMs) };
	cases[name] = result;
	if (!pass) {
		failures++;
		console.error(`  ✗ ${name}: ${calls} fsync (expected ${expectation})`);
	}
	console.log(`b12 ${name}: ${calls} fsync (expect ${expectation}) ${pass ? "PASS" : "FAIL"} in ${result.wallMs}ms`);
	return result;
}

function count(): number {
	return fsyncCalls;
}

function reset(): void {
	fsyncCalls = 0;
}

function round(n: number): number {
	return Math.round(n * 100) / 100;
}

function makeEvent(type: string, taskId: string): AppendTeamEvent {
	return {
		type,
		runId: "b12-run",
		taskId,
		message: `b12 fsync-count event ${type}`,
	};
}

/** Minimal manifest literal for paths-only consumers (mailbox). */
function makeLiteralManifest(stateRoot: string): MailboxManifest {
	return {
		schemaVersion: 1,
		runId: "b12-mailbox",
		team: "bench",
		workflow: "bench",
		goal: "b12",
		status: "running",
		workspaceMode: "single",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		cwd: stateRoot,
		stateRoot,
		artifactsRoot: path.join(stateRoot, "artifacts"),
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	} as MailboxManifest;
}

async function main(): Promise<void> {
	// --- Case 1: sync appendEvent, NON-terminal -----------------------------
	// T1 removed the pid-file atomicWrite (2 fsync) and F3a already skipped the
	// data fsync for non-terminal events; the .seq sidecar is best-effort.
	{
		const eventsPath = path.join(tmpRoot, "ev-nonterminal", "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		await settle();
		reset();
		const start = performance.now();
		appendEvent(eventsPath, makeEvent("task.progress", "task-1"));
		const calls = count();
		recordCase("appendEventSyncNonTerminal", "<=1 (was 2 pre-T1: pid atomicWrite)", calls, calls <= 1, performance.now() - start);
	}

	// --- Case 2: sync appendEvent, TERMINAL ----------------------------------
	// Terminal events keep the documented single data fsync (event-log.ts:989).
	{
		const eventsPath = path.join(tmpRoot, "ev-terminal", "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		await settle();
		reset();
		const start = performance.now();
		appendEvent(eventsPath, makeEvent("task.completed", "task-1"));
		const calls = count();
		recordCase("appendEventSyncTerminal", "==1 (documented terminal fsync)", calls, calls === 1, performance.now() - start);
	}

	// --- Case 3: appendEventBuffered, all-non-terminal batch -----------------
	// T2: the batch flush skips the fsync when no terminal event is present.
	{
		const eventsPath = path.join(tmpRoot, "ev-buffered", "events.jsonl");
		fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
		await settle();
		reset();
		const start = performance.now();
		const pending: Promise<unknown>[] = [];
		for (let i = 0; i < 8; i++) pending.push(appendEventBuffered(eventsPath, makeEvent("task.progress", `task-${i}`)));
		await Promise.all(pending);
		const calls = count();
		recordCase("appendEventBufferedNonTerminalBatch8", "==0 (T2 batch skip)", calls, calls === 0, performance.now() - start);
	}

	// --- Cases 4+5: non-terminal tasks checkpoint, flag OFF then ON ----------
	// Driven end-to-end through persistSingleTaskUpdate (the production caller
	// that maps env PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC → durability
	// "best-effort" via loadConfig), on a real .crew run layout.
	const project = path.join(tmpRoot, "project");
	fs.mkdirSync(path.join(project, ".git"), { recursive: true }); // project marker → state under <project>/.crew/
	fs.mkdirSync(path.join(project, ".crew"));
	const team = {
		name: "fsync",
		description: "fsync",
		source: "builtin" as const,
		filePath: "fsync.team.md",
		roles: [{ name: "explorer", agent: "explorer" }],
	};
	const workflow = {
		name: "fsync",
		description: "fsync",
		source: "builtin" as const,
		filePath: "fsync.workflow.md",
		steps: [{ id: "explore", role: "explorer", task: "Explore" }],
	};
	const created = createRunManifest({ cwd: project, team, workflow, goal: "b12 fsync counts" });

	const runNonTerminalCheckpoint = async (): Promise<readonly [number, number]> => {
		const loaded = loadRunManifestById(project, created.manifest.runId);
		const base = loaded?.tasks[0];
		if (!base) throw new Error("b12: run has no tasks to checkpoint");
		await settle();
		reset();
		const start = performance.now();
		persistSingleTaskUpdate(created.manifest, loaded?.tasks ?? [], { ...base, status: "running" }, "started");
		// The save sits in the 50ms coalesce window — force it out synchronously.
		flushPendingAtomicWrites(created.paths.tasksPath);
		const wallMs = performance.now() - start;
		await new Promise((resolve) => setImmediate(resolve));
		return [count(), wallMs] as const;
	};

	{
		// Flag OFF (env "0" also guards against a stray user-config true):
		// default full durability → data + parent-dir fsync at flush.
		process.env.PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC = "0";
		invalidateConfigCache();
		const [calls, wallMs] = await runNonTerminalCheckpoint();
		recordCase("tasksCheckpointNonTerminalFlagOff", ">=1 (full durability: data + dir fsync)", calls, calls >= 1, wallMs);
	}
	{
		// Flag ON: best-effort durability → zero fsync, content still lands.
		process.env.PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC = "1";
		invalidateConfigCache();
		const [calls, wallMs] = await runNonTerminalCheckpoint();
		recordCase("tasksCheckpointNonTerminalFlagOn", "==0 (PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC=1)", calls, calls === 0, wallMs);
	}
	delete process.env.PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC;
	invalidateConfigCache();

	// --- Case 6: appendMailboxMessage delivery mark ---------------------------
	// T4: the queued-path delivery.json write defaults to best-effort. The
	// FIRST append on a fresh mailbox seeds inbox/outbox/delivery files with
	// full-durability atomicWriteFile (ensureRunMailbox) — that one-time setup
	// is warmed up OUTSIDE the measured window; the steady-state append is
	// what the old 2-fsync delivery mark regressed to 0.
	{
		const stateRoot = path.join(tmpRoot, "mailbox", "state");
		const manifest = makeLiteralManifest(stateRoot);
		appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "lead",
			to: "worker-1",
			body: "warm-up (seeds mailbox files — excluded from the count)",
			kind: "message",
			priority: "normal",
		});
		await settle();
		reset();
		const start = performance.now();
		appendMailboxMessage(manifest, {
			direction: "outbox",
			from: "lead",
			to: "worker-1",
			body: "b12 measured append",
			kind: "message",
			priority: "normal",
		});
		const calls = count();
		recordCase("appendMailboxMessageDeliveryMark", "==0 (T4 best-effort mark; was 2)", calls, calls === 0, performance.now() - start);
	}
}

try {
	await main();
} finally {
	await settle();
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

// NDJSON contract line — must be the LAST stdout line (runner parses it).
console.log(
	JSON.stringify({
		name: "b12.fsync-counts",
		unit: "fsync-calls",
		cases,
		failures,
	}),
);

if (failures > 0) {
	console.error(`\nb12 FAILED (${failures} case(s))`);
	process.exit(1);
}
console.log("\nb12 PASSED");
