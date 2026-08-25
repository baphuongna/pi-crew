/**
 * PERF round 2, Task 3 (2026-08-25): opt-in best-effort fsync for non-terminal
 * tasks checkpoints (PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC).
 *
 * saveRunTasksCoalesced gains an optional `durability` param that flows into
 * the coalesced entry. persistSingleTaskUpdate (state-helpers.ts) keeps the
 * 50ms coalesce window for NON-terminal saves when the config flag is on and
 * drops ONLY durability — it does NOT bypass the coalesced path and does NOT
 * flush eagerly. The coalesced entry stores "best-effort" (atomic-write.ts:980)
 * and the flush forwards it to atomicWriteFile (atomic-write.ts:997), which
 * skips the data AND parent-dir fsync. Terminal transitions MUST remain
 * full-durability regardless of the flag.
 *
 * We assert OBSERVABLY via a node:fs CJS-default swap (the same pattern as
 * test/unit/manifest-cache-ttl.test.ts): patch `fs.openSync` to map each
 * opened temp fd → its temp path, and `fs.fsyncSync` to count fsyncs whose fd
 * is a tasks.json temp fd of the targeted run. A "full" write fsyncs that fd
 * (atomic-write.ts:676); a "best-effort" write never calls fsync on it
 * (atomic-write.ts:676/708). Everything else — run lock files (writeSync, no
 * fsync), event log, agents records — either has no fsync on our fd or is
 * filtered by the temp-path match, so the count is unambiguous.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { invalidateConfigCache, loadConfig } from "../../../src/config/config.ts";
import { persistSingleTaskUpdate } from "../../../src/runtime/task-runner/state-helpers.ts";
import { flushPendingAtomicWrites } from "../../../src/state/atomic-write.ts";
import { loadTasksWithRecovery } from "../../../src/state/stores/manifest-io.ts";
import { createRunManifest, loadRunManifestById, saveRunTasksCoalesced } from "../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

const envRestorers: Array<() => void> = [];
after(() => {
	for (const restore of envRestorers.splice(0)) restore();
});

/** Set an env var for THIS test; restored at suite end (beforeEach snapshots it). */
function setEnv(name: string, value: string): void {
	process.env[name] = value;
	envRestorers.push(() => {
		if (process.env[name] === value) delete process.env[name];
	});
}

const envBackup = new Map<string, string | undefined>();
beforeEach(() => {
	envBackup.clear();
	for (const key of Object.keys(process.env)) envBackup.set(key, process.env[key]);
});
afterEach(() => {
	setEnv("PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC", "0"); // default-off for any stray leak
	invalidateConfigCache();
	for (const key of Object.keys(process.env)) {
		if (!envBackup.has(key)) delete process.env[key];
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

const team: TeamConfig = {
	name: "fsync",
	description: "fsync",
	source: "builtin",
	filePath: "fsync.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "fsync",
	description: "fsync",
	source: "builtin",
	filePath: "fsync.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

function makeTempProject(): { cwd: string; cleanup(): void } {
	const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-crew-fsync-"));
	fs.mkdirSync(path.join(cwd, ".git")); // project marker → state stays under <tmp>/.crew/
	fs.mkdirSync(path.join(cwd, ".crew"));
	return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function makeRun(cwd: string): ReturnType<typeof createRunManifest> {
	return createRunManifest({ cwd, team, workflow, goal: "fsync gate" });
}

/** On-disk task statuses of a run, via the exact recovery loader used elsewhere. */
function onDiskStatuses(cwd: string, manifest: { runId: string; tasksPath: string; eventsPath: string }): string[] {
	try {
		return loadTasksWithRecovery(manifest.tasksPath, manifest.eventsPath, manifest.runId).map((t) => t.status);
	} catch {
		// tasks.json may legitimately be absent/broken; re-read via loadRunManifestById.
		return (loadRunManifestById(cwd, manifest.runId)?.tasks ?? []).map((t) => t.status);
	}
}

function waitForFlush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface FsSpy {
	/** Number of fsyncSync calls on a temp fd that is about to become the
	 *  targeted run's tasks.json, PLUS fsyncs on a directory fd opened at the
	 *  tasks file's parent (the full-durability parent-dir fsync). The DATA
	 *  fsync can't be distinguished from a full write's dir fsync by path
	 *  (both belong to the tasks file's write), so full durability counts
	 *  >= 2 fsyncs and best-effort counts EXACTLY 0 — a faithful probe that
	 *  the atomicWriteFile call was durability "full" vs "best-effort". */
	fsyncOnTasks(): number;
	restore(): void;
}

function makeTasksFsyncSpy(tasksPaths: string[]): FsSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as {
		openSync: (...args: unknown[]) => number;
		fsyncSync: (...args: unknown[]) => unknown;
	};
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const originalOpen = fsDefault.openSync;
	const originalFsync = fsDefault.fsyncSync;
	const targetPaths = new Set(tasksPaths);
	const fdToPath = new Map<number, string>();
	let fsyncOnTasks = 0;

	fsDefault.openSync = (...args: unknown[]) => {
		const fd = originalOpen(...args);
		const filePath = args[0];
		if (typeof filePath === "string") {
			if (filePath.endsWith(".tmp")) {
				// atomic-write.ts:619 — the data temp file for the target.
				const base = filePath.slice(0, -".tmp".length);
				const parent = path.dirname(base);
				for (const target of targetPaths) {
					const targetParent = path.dirname(target);
					if (parent === targetParent && path.basename(base).startsWith(path.basename(target))) {
						fdToPath.set(fd, filePath);
						break;
					}
				}
			} else {
				// atomic-write.ts:711 — the parent-dir fsync opens the directory
				// of the target file with flags "r". Attribute it to the target.
				for (const target of targetPaths) {
					if (filePath === path.dirname(target)) {
						fdToPath.set(fd, filePath);
						break;
					}
				}
			}
		}
		return fd;
	};
	fsDefault.fsyncSync = (...args: unknown[]) => {
		const fd = args[0];
		if (typeof fd === "number" && fdToPath.has(fd)) fsyncOnTasks++;
		return originalFsync(...args);
	};
	nodeModule.syncBuiltinESMExports();

	return {
		fsyncOnTasks: () => fsyncOnTasks,
		restore: () => {
			fsDefault.openSync = originalOpen;
			fsDefault.fsyncSync = originalFsync;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

// ---------------------------------------------------------------------------
// persistSingleTaskUpdate (the caller) — end-to-end gating
// ---------------------------------------------------------------------------

test("flag ON, non-terminal save → coalesced path, flushes best-effort with ZERO fsync", async () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		setEnv("PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC", "1");
		invalidateConfigCache();
		const created = makeRun(cwd);
		const spy = makeTasksFsyncSpy([created.paths.tasksPath]);
		try {
			const loaded = loadRunManifestById(cwd, created.manifest.runId);
			const base = loaded?.tasks[0];
			assert.ok(base, "run has at least one task");
			const updated = { ...base, status: "running" as const };
			const merged = persistSingleTaskUpdate(created.manifest, loaded?.tasks ?? [], updated, "started");
			assert.ok(merged.length >= 1, "persist returns a tasks array");
			// THE CALLER KEEPS THE COALESCE WINDOW: the best-effort write is
			// buffered, not flushed eagerly. After the CALLER's scoped flush at the
			// top of its CAS loop drained the previous pending entry, the fresh
			// best-effort entry sits in the 50ms window — so the disk must still
			// reflect the PRE-persist state (queued), not the running update.
			const statusesBefore = onDiskStatuses(cwd, created.manifest);
			assert.ok(statusesBefore.every((s) => s !== "running"), `coalesced best-effort must stay buffered until flush (got ${statusesBefore})`);
			await waitForFlush();
			// Flush the buffered best-effort entry → lands running, zero fsync.
			flushPendingAtomicWrites(created.paths.tasksPath);
			const statusesAfter = onDiskStatuses(cwd, created.manifest);
			assert.ok(statusesAfter.includes("running"), `flushed best-effort save must land the running status (got ${statusesAfter})`);
			assert.equal(spy.fsyncOnTasks(), 0, `best-effort tasks save must fsync the tasks fd 0 times (got ${spy.fsyncOnTasks()})`);
		} finally {
			spy.restore();
		}
	} finally {
		cleanup();
	}
});

test("flag OFF, non-terminal save → default coalesced/full durability (fsync observed at flush)", async () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		const created = makeRun(cwd);
		const spy = makeTasksFsyncSpy([created.paths.tasksPath]);
		try {
			const loaded = loadRunManifestById(cwd, created.manifest.runId);
			const base = loaded?.tasks[0];
			assert.ok(base, "run has at least one task");
			const updated = { ...base, status: "running" as const };
			const merged = persistSingleTaskUpdate(created.manifest, loaded?.tasks ?? [], updated, "started");
			assert.ok(merged.length >= 1);
			// Default path is coalesced: nothing reaches the disk before the
			// window elapses (no fsync on the tasks temp fd either).
			assert.equal(spy.fsyncOnTasks(), 0, "coalesced default path must not fsync before the window elapses");
			await waitForFlush();
			assert.equal(spy.fsyncOnTasks(), 0, "still no fsync before flush (buffered)");
			flushPendingAtomicWrites(created.paths.tasksPath);
			assert.ok(spy.fsyncOnTasks() >= 1, `flag-off non-terminal save must fsync the tasks fd at flush (got ${spy.fsyncOnTasks()})`);
		} finally {
			spy.restore();
		}
	} finally {
		cleanup();
	}
});

test("flag ON, TERMINAL save → full durability regardless of flag (fsync observed)", () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		setEnv("PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC", "1");
		invalidateConfigCache();
		const created = makeRun(cwd);
		const spy = makeTasksFsyncSpy([created.paths.tasksPath]);
		try {
			const loaded = loadRunManifestById(cwd, created.manifest.runId);
			const base = loaded?.tasks[0];
			assert.ok(base, "run has at least one task");
			const updated = { ...base, status: "completed" as const };
			const merged = persistSingleTaskUpdate(created.manifest, loaded?.tasks ?? [], updated, undefined, true); // skipCoalesce=true → terminal
			assert.ok(merged.length >= 1);
			// Terminal saves write immediately (skipCoalesce) with full durability.
			assert.ok(spy.fsyncOnTasks() >= 1, `terminal save must fsync the tasks fd (got ${spy.fsyncOnTasks()})`);
		} finally {
			spy.restore();
		}
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// saveRunTasksCoalesced level — durability param plumbing (default 'full')
// ---------------------------------------------------------------------------

test("saveRunTasksCoalesced default durability is 'full': a coalesced default save fsyncs on flush", async () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		const created = makeRun(cwd);
		const spy = makeTasksFsyncSpy([created.paths.tasksPath]);
		try {
			const loaded = loadRunManifestById(cwd, created.manifest.runId);
			const merged = (loaded?.tasks ?? []).map((t) => ({ ...t, status: "running" as const }));
			saveRunTasksCoalesced(created.manifest, merged); // no skipCoalesce → coalesced
			await waitForFlush();
			assert.equal(spy.fsyncOnTasks(), 0, "coalesced default save must not fsync before the window elapses");
			flushPendingAtomicWrites(created.paths.tasksPath);
			assert.ok(spy.fsyncOnTasks() >= 1, `default durability must fsync the tasks fd at flush (got ${spy.fsyncOnTasks()})`);
		} finally {
			spy.restore();
		}
	} finally {
		cleanup();
	}
});

test("saveRunTasksCoalesced best-effort durability param: a coalesced best-effort save never fsyncs the tasks fd", async () => {
	const { cwd, cleanup } = makeTempProject();
	try {
		const created = makeRun(cwd);
		const spy = makeTasksFsyncSpy([created.paths.tasksPath]);
		try {
			const loaded = loadRunManifestById(cwd, created.manifest.runId);
			const merged = (loaded?.tasks ?? []).map((t) => ({ ...t, status: "running" as const }));
			saveRunTasksCoalesced(created.manifest, merged, false, "best-effort"); // coalesced + best-effort
			await waitForFlush();
			flushPendingAtomicWrites(created.paths.tasksPath);
			assert.equal(spy.fsyncOnTasks(), 0, `coalesced best-effort must never fsync the tasks fd (got ${spy.fsyncOnTasks()})`);
		} finally {
			spy.restore();
		}
	} finally {
		cleanup();
	}
});

// ---------------------------------------------------------------------------
// Config precondition — the flag that gates the save site
// ---------------------------------------------------------------------------

/** Peek the persistence section of the effective loaded config. */
function persistenceOf(enabledViaEnv: string | undefined): { skipTasksFsync: boolean } {
	if (enabledViaEnv !== undefined) setEnv("PI_CREW_PERSISTENCE_SKIP_TASKS_FSYNC", enabledViaEnv);
	invalidateConfigCache();
	const loaded = loadConfig();
	return { skipTasksFsync: loaded.config.persistence?.skipTasksFsync === true };
}

test("config: persistence.skipTasksFsync defaults to false", () => {
	assert.equal(persistenceOf(undefined).skipTasksFsync, false);
});

test("config: env '1' sets persistence.skipTasksFsync true", () => {
	assert.equal(persistenceOf("1").skipTasksFsync, true);
});

test("config: env 'true' sets persistence.skipTasksFsync true", () => {
	assert.equal(persistenceOf("true").skipTasksFsync, true);
});

test("config: env '0' leaves persistence.skipTasksFsync false", () => {
	assert.equal(persistenceOf("0").skipTasksFsync, false);
});
