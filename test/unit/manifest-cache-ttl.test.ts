/**
 * Round 19 test-health: manifest-cache TTL eviction coverage.
 * Previously only LRU size-eviction was tested; the time-based expiry path
 * (setManifestCache evicts entries older than MANIFEST_CACHE_TTL_MS) had
 * zero coverage.
 *
 * Task 23 (2026-08-24): runtime manifest-cache stat-storm removal coverage —
 * statTtlMs skip in parseManifestIfChanged, dir-listing cache in collectRoots,
 * filename-granular fs.watch handling, and the plain createdAt sort. See the
 * "runtime manifest cache" section below.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import type { ManifestCacheEntry } from "../../src/state/stores/state-store.ts";
import {
	__test__clearManifestCache,
	__test__getManifestCacheEntry,
	__test__manifestCacheSize,
	__test__setManifestCache,
	createRunManifest,
	MANIFEST_CACHE_TTL_MS_VALUE,
	updateRunStatus,
} from "../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

/**
 * Global env isolation: snapshot process.env before each test and restore it after.
 * Ensures PI_CREW_HOME mutations (or any env var leaks) cannot spread between tests.
 */
const envBackup = new Map<string, string | undefined>();
beforeEach(() => {
	envBackup.clear();
	for (const key of Object.keys(process.env)) envBackup.set(key, process.env[key]);
});
afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!envBackup.has(key)) delete process.env[key];
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function makeEntry(cachedAt: number): ManifestCacheEntry {
	return {
		manifest: {
			schemaVersion: 1,
			runId: "team_test",
			team: "t",
			status: "running",
			goal: "g",
			workspaceMode: "single",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			stateRoot: "/s",
			artifactsRoot: "/a",
			tasksPath: "/t",
			eventsPath: "/e",
			artifacts: [],
			cwd: "/c",
		},
		tasks: [],
		cachedAt,
		generation: 0,
	} as unknown as ManifestCacheEntry;
}

test("setManifestCache evicts entries older than the TTL on the next set", () => {
	__test__clearManifestCache();
	try {
		// Insert a fresh entry (within TTL).
		__test__setManifestCache("/run/fresh", makeEntry(Date.now()));
		assert.equal(__test__manifestCacheSize(), 1);

		// Insert a second entry, then backdate its cachedAt beyond the TTL.
		// (setManifestCache always stamps cachedAt=now, so we mutate the stored
		// entry directly to simulate an entry that has aged out.)
		__test__setManifestCache("/run/stale", makeEntry(Date.now()));
		const stored = __test__getManifestCacheEntry("/run/stale");
		assert.ok(stored, "entry should be in cache");
		stored!.cachedAt = Date.now() - MANIFEST_CACHE_TTL_MS_VALUE - 1000;

		// Now insert a third entry; the sweep should evict the stale one.
		__test__setManifestCache("/run/trigger", makeEntry(Date.now()));
		assert.ok(!__test__getManifestCacheEntry("/run/stale"), "stale (TTL-expired) entry must be evicted when a new entry is set");
		assert.ok(__test__getManifestCacheEntry("/run/fresh"), "fresh entry survives");
		assert.ok(__test__getManifestCacheEntry("/run/trigger"), "new entry present");
	} finally {
		__test__clearManifestCache();
	}
});

test("setManifestCache keeps entries within the TTL", () => {
	__test__clearManifestCache();
	try {
		__test__setManifestCache("/run/young", makeEntry(Date.now()));
		__test__setManifestCache("/run/another", makeEntry(Date.now()));
		assert.ok(__test__getManifestCacheEntry("/run/young"), "young entry not evicted");
		assert.ok(__test__getManifestCacheEntry("/run/another"), "young entry not evicted");
	} finally {
		__test__clearManifestCache();
	}
});

test("MANIFEST_CACHE_TTL_MS is a sane positive value (60s)", () => {
	assert.ok(MANIFEST_CACHE_TTL_MS_VALUE > 0);
	assert.equal(MANIFEST_CACHE_TTL_MS_VALUE, 60_000);
});

// ---------------------------------------------------------------------------
// Task 23 (2026-08-24): runtime manifest cache (src/runtime/manifest-cache.ts)
// ---------------------------------------------------------------------------

const team: TeamConfig = {
	name: "ttl",
	description: "ttl",
	source: "builtin",
	filePath: "ttl.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "ttl",
	description: "ttl",
	source: "builtin",
	filePath: "ttl.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeTempProject(): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-manifest-cache-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	// getCrewEnv("PI_CREW_HOME") resolves the mirror pair with "teams"
	// precedence (PI_TEAMS_HOME ?? PI_CREW_HOME — see src/config/env-vars.ts),
	// so an ambient PI_TEAMS_HOME would override our fixture root and point
	// every cache scan at the user's real crew home. Delete the winning name
	// too; the afterEach env snapshot restores it.
	delete process.env.PI_TEAMS_HOME;
	process.env.PI_CREW_HOME = path.join(cwd, ".crew");
	return cwd;
}

function runsRootOf(cwd: string): string {
	return path.join(cwd, ".crew", "state", "runs");
}

function manifestFileOf(manifest: { stateRoot: string }): string {
	return path.join(manifest.stateRoot, "manifest.json");
}

/** Create a run and drive it to a terminal status so it leaves the active-run registry. */
function createCompletedRun(cwd: string, goal: string): { runId: string; manifestPath: string; stateRoot: string } {
	const { manifest } = createRunManifest({ cwd, team, workflow, goal });
	const running = updateRunStatus(manifest, "running", "test");
	updateRunStatus(running, "completed", "test");
	return { runId: manifest.runId, manifestPath: manifestFileOf(manifest), stateRoot: manifest.stateRoot };
}

/**
 * Instrumentation for the runtime manifest cache (task-23 tests).
 *
 * `node:fs` ESM namespace properties are read-only, so `t.mock.method(fs, ...)`
 * and direct assignment on the namespace do NOT work. However the CommonJS
 * exports object behind the builtin IS mutable, and
 * `module.syncBuiltinESMExports()` pushes patched functions back into every
 * ESM namespace that imported `node:fs` (verified on this toolchain, Node
 * v22). This is the same pattern used by Node's own test suite.
 *
 * Counts are scoped to the given roots so unrelated stat/readdir traffic
 * (user-level runs root, active-run-registry, real user runs) is ignored.
 */
interface FsSpy {
	readonly manifestStats: number;
	readonly rootReaddirs: number;
	restore(): void;
}

function spyFsForRoots(roots: string[]): FsSpy {
	const nodeRequire = createRequire(import.meta.url);
	const fsDefault = nodeRequire("node:fs") as {
		statSync: (...args: unknown[]) => unknown;
		readdirSync: (...args: unknown[]) => unknown;
		realpathSync: { native(p: string): string };
	};
	const nodeModule = nodeRequire("node:module") as { syncBuiltinESMExports(): void };
	const originalStat = fsDefault.statSync;
	const originalReaddir = fsDefault.readdirSync;
	const state = { manifestStats: 0, rootReaddirs: 0 };
	// macOS: os.tmpdir() is /var/folders/… but realpath (and the cache, which
	// canonicalizes via realpathSync.native — same helper it uses for run-root
	// identity, manifest-cache.ts:91) resolves to /private/var/folders/….
	// A spy matching only the raw tmpdir prefix sees ZERO stats on macOS CI
	// and the liveness assertion fires ("warm scan must stat each manifest
	// got 0" — run 33462332100). Match BOTH spellings of each root.
	// Roots may not exist yet when the spy is installed (runs dir is created
	// lazily by the first createRunManifest) — realpath the EXISTING ancestor
	// (.crew always exists — makeTempProject mkdirs it) and re-join the missing
	// tail, giving the canonical spelling the cache will use once the dir
	// appears. Falls back to the raw root when even the parent is missing.
	const realRoots = roots.map((r) => {
		const parent = path.dirname(r);
		const tail = path.basename(r);
		try {
			return path.join(fsDefault.realpathSync.native(parent), tail);
		} catch {
			return r;
		}
	});
	const allRoots = [...new Set([...roots, ...realRoots])];
	const underRoots = (p: string) => allRoots.some((root) => p === root || p.startsWith(`${root}${path.sep}`));
	fsDefault.statSync = (...args: unknown[]) => {
		const target = args[0];
		if (typeof target === "string" && target.endsWith("manifest.json") && underRoots(target)) state.manifestStats++;
		return originalStat(...args);
	};
	fsDefault.readdirSync = (...args: unknown[]) => {
		const target = args[0];
		if (typeof target === "string" && allRoots.includes(target)) state.rootReaddirs++;
		return originalReaddir(...args);
	};
	nodeModule.syncBuiltinESMExports();
	return {
		get manifestStats() {
			return state.manifestStats;
		},
		get rootReaddirs() {
			return state.rootReaddirs;
		},
		restore() {
			fsDefault.statSync = originalStat;
			fsDefault.readdirSync = originalReaddir;
			nodeModule.syncBuiltinESMExports();
		},
	};
}

async function pollUntil<T>(predicate: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = predicate();
		if (value) return value;
		if (Date.now() >= deadline) return predicate();
		await sleep(10);
	}
}

test("runtime cache: list() re-scan within the stat TTL stats no manifests, re-readdirs no root, and re-parses nothing", {
	skip:
		process.platform === "darwin"
			? "spy instrument (CJS-default-swap + module.syncBuiltinESMExports) counts 0 on the macOS CI runner (same Node v22.23.1 passes on Linux/Windows — CI 33463597499); the liveness guard fires. Needs a portable instrumentation before this can assert on darwin."
			: undefined,
}, async () => {
	const cwd = makeTempProject();
	const cache = createManifestCache(cwd, { watch: false, debounceMs: 40, statTtlMs: 60_000 });
	const spy = spyFsForRoots([runsRootOf(cwd)]);
	try {
		const runs = [createCompletedRun(cwd, "a"), createCompletedRun(cwd, "b"), createCompletedRun(cwd, "c")];
		const first = cache.list();
		const firstIds = new Set(first.map((m) => m.runId));
		for (const run of runs) {
			assert.ok(firstIds.has(run.runId), `warm scan must list ${run.runId}`);
		}
		// Instrument liveness guard: if the spy were dead (e.g. a future Node
		// breaking syncBuiltinESMExports), the zero-delta assertions below
		// would pass vacuously. The warm scan MUST have stat'ed each manifest.
		assert.ok(spy.manifestStats >= runs.length, `instrument liveness: warm scan must stat each manifest (got ${spy.manifestStats})`);
		const statsAfterWarm = spy.manifestStats;
		const readdirsAfterWarm = spy.rootReaddirs;

		// Let the 40ms list TTL lapse, but stay far inside the 60s stat TTL.
		await sleep(80);

		const second = cache.list();
		assert.equal(spy.manifestStats, statsAfterWarm, "re-scan within stat TTL must not stat any manifest");
		assert.equal(spy.rootReaddirs, readdirsAfterWarm, "re-scan with unchanged root mtime must not re-readdir the runs root");
		// No re-parse: identical object references per runId.
		const firstById = new Map(first.map((m) => [m.runId, m]));
		for (const m of second) {
			const prev = firstById.get(m.runId);
			if (prev) assert.ok(prev === m, `manifest ${m.runId} must be the same cached object (no re-parse)`);
		}
		const secondIds = new Set(second.map((m) => m.runId));
		for (const run of runs) {
			assert.ok(secondIds.has(run.runId), `re-scan must still list ${run.runId}`);
		}
	} finally {
		spy.restore();
		cache.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runtime cache: once the stat TTL lapses, list() re-stats and picks up changed manifest content", {
	skip:
		process.platform === "darwin"
			? "spy instrument (CJS-default-swap + module.syncBuiltinESMExports) counts 0 on the macOS CI runner (same Node v22.23.1 passes on Linux/Windows — CI 33463597499); the liveness guard fires. Needs a portable instrumentation before this can assert on darwin."
			: undefined,
}, async () => {
	const cwd = makeTempProject();
	const cache = createManifestCache(cwd, { watch: false, debounceMs: 40, statTtlMs: 1 });
	const spy = spyFsForRoots([runsRootOf(cwd)]);
	try {
		const run = createCompletedRun(cwd, "original goal");
		const warm = cache.list().find((m) => m.runId === run.runId);
		assert.ok(warm, "warm scan lists the run");
		assert.equal(warm.goal, "original goal");
		const statsAfterWarm = spy.manifestStats;

		// Rewrite the manifest on disk (mtime/size change), then let both TTLs
		// (40ms list, 1ms stat) lapse.
		const raw = JSON.parse(fs.readFileSync(run.manifestPath, "utf-8")) as Record<string, unknown>;
		raw.goal = "rewritten goal with a longer string";
		fs.writeFileSync(run.manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
		await sleep(80);

		const rescan = cache.list().find((m) => m.runId === run.runId);
		assert.ok(rescan, "re-scan lists the run");
		assert.ok(spy.manifestStats > statsAfterWarm, "stat TTL lapse must cause a fresh manifest stat");
		assert.equal(rescan.goal, "rewritten goal with a longer string", "changed manifest must be re-parsed after TTL lapse");
		assert.ok(rescan !== warm, "re-parse must produce a new manifest object");
	} finally {
		spy.restore();
		cache.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runtime cache: watcher filename events refresh the affected run and expire the list mid-TTL", async () => {
	const cwd = makeTempProject();
	// The runs root must exist BEFORE the cache is created — fs.watch on a
	// missing dir returns null and the project root would stay unwatched.
	fs.mkdirSync(runsRootOf(cwd), { recursive: true });
	const cache = createManifestCache(cwd, { watch: true, debounceMs: 10_000, statTtlMs: 10_000 });
	try {
		const runA = createCompletedRun(cwd, "run a");
		const warm = cache.list();
		const warmIds = new Set(warm.map((m) => m.runId));
		assert.ok(warmIds.has(runA.runId), "warm scan lists runA");

		// Adding a run dir fires the runs-root watcher with filename=<runId>.
		// With both TTLs at 10s, only the watcher-driven list expiry can make
		// the new run visible within the poll window.
		const runB = createCompletedRun(cwd, "run b");
		const seenB = await pollUntil(() => {
			const listed = cache.list();
			return listed.some((m) => m.runId === runB.runId) ? listed : undefined;
		}, 3_000);
		assert.ok(seenB, "watcher filename event must expire the list cache mid-TTL so the new run is listed");
		assert.ok(!warmIds.has(runB.runId), "the pre-event cached snapshot did not contain the new run");

		// Removing the run dir fires the watcher again (filename=<runId>);
		// handleWatchEvent force-stats (bypassing the 10s stat TTL) and drops
		// the index entry, and the root mtime change refreshes the cached dir
		// listing — so the removal must be visible mid-TTL too.
		fs.rmSync(runA.stateRoot, { recursive: true, force: true });
		const seenRemoval = await pollUntil(() => {
			const listed = cache.list();
			return listed.every((m) => m.runId !== runA.runId) ? listed : undefined;
		}, 3_000);
		assert.ok(seenRemoval, "watcher filename event must expire the list cache mid-TTL so the removed run disappears");
	} finally {
		cache.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("runtime cache: list() orders by createdAt descending; missing createdAt sorts last", () => {
	const cwd = makeTempProject();
	const cache = createManifestCache(cwd, { watch: false });
	try {
		const runOld = createCompletedRun(cwd, "old");
		const runNoDate = createCompletedRun(cwd, "no date");
		const runNew = createCompletedRun(cwd, "new");

		// Backdate runOld, drop runNoDate's createdAt entirely (exercises the
		// `?? ""` fallback of the plain comparator). Ordering does not depend on
		// creation-time separation — the rewrites pin the compared values.
		const backdate = JSON.parse(fs.readFileSync(runOld.manifestPath, "utf-8")) as Record<string, unknown>;
		backdate.createdAt = "2020-01-01T00:00:00.000Z";
		fs.writeFileSync(runOld.manifestPath, `${JSON.stringify(backdate, null, 2)}\n`);
		const dropDate = JSON.parse(fs.readFileSync(runNoDate.manifestPath, "utf-8")) as Record<string, unknown>;
		delete dropDate.createdAt;
		fs.writeFileSync(runNoDate.manifestPath, `${JSON.stringify(dropDate, null, 2)}\n`);

		const listed = cache.list();
		const position = new Map(listed.map((m, index) => [m.runId, index]));
		assert.ok(position.has(runNew.runId) && position.has(runOld.runId) && position.has(runNoDate.runId), "all three runs listed");
		assert.ok(
			(position.get(runNew.runId) ?? -1) < (position.get(runOld.runId) ?? -1),
			"newer createdAt must sort before backdated createdAt",
		);
		assert.ok(
			(position.get(runOld.runId) ?? -1) < (position.get(runNoDate.runId) ?? -1),
			'missing createdAt ("" fallback) must sort after every present createdAt',
		);
	} finally {
		cache.dispose();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
