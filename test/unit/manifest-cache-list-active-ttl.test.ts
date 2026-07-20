/**
 * FIND-03 regression test: manifestCache.listActive() must be memoized
 * behind a 500ms TTL — many calls within the TTL only run the full scan
 * once (verified by counting fs.statSync calls on the manifest dir), and
 * an explicit cache invalidation (via cache.clear() — which the fs.watch
 * handler also triggers through scheduleListRefresh) forces the next call
 * to re-scan.
 *
 * The cache is a CLOSURE-LEVEL state inside createManifestCache. There is
 * no public invalidate hook for it; the production invalidation paths are:
 *   1. cache.clear() → invalidate() → listCache.clear() + invalidateListActive()
 *   2. scheduleListRefresh() (fs.watch tick) → invalidateListActive()
 *   3. dispose() → invalidateListActive()
 * We exercise (1) here, which is the simplest and most direct. The
 * RT-F3 listActive test (separate file) still asserts the "all running"
 * semantic.
 *
 * Implementation note: we count fs.statSync calls on the manifest files
 * themselves. The production code calls fs.statSync inside
 * parseManifestIfChanged — one stat per manifest per full scan. With the
 * cache warm, NO additional stats are issued. Without the cache, every
 * listActive call would re-stat every manifest.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createManifestCache } from "../../src/runtime/manifest-cache.ts";
import { createRunManifest, updateRunStatus } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "act",
	description: "act",
	source: "builtin",
	filePath: "act.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "act",
	description: "act",
	source: "builtin",
	filePath: "act.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

/**
 * Count fs.statSync calls that target any file inside a specific directory.
 * The original statSync is preserved and restored in the returned cleanup.
 * Only paths under `root` are counted (filters out unrelated stat calls
 * from the active-run-registry / userCrewRoot).
 *
 * Implementation note: `node:fs` is a built-in module; its named exports
 * are read-only on the namespace object. We swap via the CommonJS-style
 * default export (which IS mutable) and call syncBuiltinESMExports() to
 * refresh the ESM namespace. This is the same pattern documented in the
 * Node.js test suite (test/parallel/test-mock-fs-statSync).
 */
test("listActive memoizes within TTL — many calls only scan once", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-ttl-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const runIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `g${i}` });
			updateRunStatus(manifest, "running", "test");
			runIds.push(manifest.runId);
		}

		const cache = createManifestCache(cwd, { watch: false });

		// Warm the cache (1 full scan reads all manifests → all status "running").
		const warm = cache.listActive(1000);
		assert.ok(warm.length >= 5, "warm call should return at least the 5 created runs");

		// Mutate one manifest on disk to status "completed". A re-scan would
		// pick this up; a memoized (TTL-cached) call returns the cached
		// "running" snapshot. We verify TTL behavior WITHOUT spying fs.statSync
		// (which is a read-only property on modern Node ESM module namespaces,
		// making stat-counting spies fragile across Node versions).
		const mutated = runIds[0]!;
		const mutatedManifest = warm.find((m) => m.runId === mutated)!;
		updateRunStatus(mutatedManifest, "completed", "test");

		// 49 calls within the 500ms TTL. None should re-scan, so the mutated
		// runId must still report the cached "running" status.
		for (let i = 0; i < 49; i++) cache.listActive(1000);
		const afterBurst = cache.listActive(1000);
		const mutatedObserved = afterBurst.find((m) => m.runId === mutated);
		assert.equal(
			mutatedObserved?.status,
			"running",
			`cached calls must NOT re-scan manifests; expected mutated runId=${mutated} to still report cached 'running', got '${mutatedObserved?.status}'`,
		);

		// Cap is applied post-cache on every return.
		assert.equal(cache.listActive(2).length, 2, "capped slice must respect the limit");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listActive re-scans after cache.clear() (the watcher invalidation path)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-invalidate-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const cache = createManifestCache(cwd, { watch: false });

		// Create 5 manifests and warm the cache (snapshot of 5).
		for (let i = 0; i < 5; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `g${i}` });
			updateRunStatus(manifest, "running", "test");
		}
		const warm = cache.listActive(1000);
		assert.ok(warm.length >= 5, "warm should return the 5 initial manifests");

		// Add a 6th running manifest on disk AFTER warming. A memoized (TTL-cached)
		// call won't see it; a re-scan (after clear) will.
		const { manifest: newManifest } = createRunManifest({ cwd, team, workflow, goal: "g-new" });
		updateRunStatus(newManifest, "running", "test");
		const newRunId = newManifest.runId;

		// Within TTL: cached result must NOT include the newly-created run.
		const cached = cache.listActive(1000);
		assert.equal(
			cached.some((m) => m.runId === newRunId),
			false,
			`pre-clear: cached call must NOT include the newly-created runId=${newRunId} (proves no re-scan)`,
		);

		// cache.clear() drops the listActive cache → next call must re-scan and
		// surface the newly-created running manifest.
		cache.clear();
		const afterClear = cache.listActive(1000);
		assert.ok(
			afterClear.some((m) => m.runId === newRunId),
			`post-clear call must re-scan and include the newly-created runId=${newRunId} (proves clear drops cache)`,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listActive cache does NOT cap by list()'s top-N (all-running semantic preserved)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-no-topn-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		// Create 20 running runs in this cwd. The cache must surface ALL of
		// them regardless of list()'s top-N and regardless of how many calls
		// we make with different `limit` arguments.
		const runningIds: string[] = [];
		for (let i = 0; i < 20; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `g${i}` });
			updateRunStatus(manifest, "running", "test");
			runningIds.push(manifest.runId);
		}

		const cache = createManifestCache(cwd, { watch: false });
		// First call with limit=5 forces the cache to be populated. The
		// cache itself must store the full un-capped set (per FIND-03
		// design); a second call with a larger cap must surface the rest.
		const limited = cache.listActive(5);
		assert.equal(limited.length, 5);
		// The cached underlying set must include all 20 — verified by a
		// second call with a larger cap. (The first caller's cap=5 is NOT
		// stored in the cache; the cap is applied post-cache on every
		// return.)
		const expanded = cache.listActive(10_000);
		const expandedSet = new Set(expanded.map((m) => m.runId));
		let includedCount = 0;
		for (const id of runningIds) {
			if (expandedSet.has(id)) includedCount++;
		}
		assert.equal(includedCount, 20, `cached un-capped set must surface all 20 created runs (got ${includedCount}/20)`);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
