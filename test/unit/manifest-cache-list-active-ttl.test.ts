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
import { syncBuiltinESMExports } from "node:module";
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
function countStatsUnder(root: string): { count: () => number; restore: () => void } {
	const fsDefault = (fs as unknown as { default?: typeof fs }).default ?? (fs as unknown as typeof fs);
	const original = (fsDefault as { statSync: typeof fs.statSync }).statSync;
	let calls = 0;
	const wrapped = ((target: fs.PathLike, ...rest: unknown[]) => {
		try {
			const resolved = path.resolve(typeof target === "string" ? target : target.toString());
			if (resolved.startsWith(path.resolve(root) + path.sep)) {
				calls++;
			}
		} catch {
			/* ignore path normalization errors */
		}
		return (original as (...a: unknown[]) => fs.Stats).call(fsDefault, target, ...rest);
	}) as typeof fs.statSync;
	(fsDefault as { statSync: typeof fs.statSync }).statSync = wrapped;
	syncBuiltinESMExports();
	return {
		count: () => calls,
		restore: () => {
			(fsDefault as { statSync: typeof fs.statSync }).statSync = original;
			syncBuiltinESMExports();
		},
	};
}

test("listActive memoizes within TTL — many calls only scan once", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-ttl-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		for (let i = 0; i < 5; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `g${i}` });
			updateRunStatus(manifest, "running", "test");
		}

		const cache = createManifestCache(cwd, { watch: false });

		// Warm the cache. This call triggers exactly 1 full scan → 5 stat
		// calls (one per manifest in this cwd, plus stat calls for other
		// active-run-registry manifests in userCrewRoot which we filter out).
		const statCounter = countStatsUnder(path.join(cwd, ".crew"));
		try {
			const warm = cache.listActive(1000);
			assert.ok(warm.length >= 5, "warm call should return at least the 5 created runs");
			const baseline = statCounter.count();
			assert.ok(baseline >= 5, `warm scan must stat at least 5 manifests (got ${baseline})`);

			// Do many calls back-to-back within the 500ms TTL. With the cache
			// working, NO additional stats should be issued (parseManifestIfChanged
			// is gated by the cache hit). Without the cache, we'd see 5 stats
			// per call × 49 calls = 245 additional stats.
			for (let i = 0; i < 49; i++) {
				cache.listActive(1000);
			}
			const afterBurst = statCounter.count();
			const delta = afterBurst - baseline;
			assert.equal(
				delta,
				0,
				`cached calls must NOT re-stat manifests; expected 0 new stats, got ${delta} (baseline=${baseline}, afterBurst=${afterBurst})`,
			);

			// Sanity: the cap must be respected on the returned slice.
			assert.equal(cache.listActive(2).length, 2, "capped slice must respect the limit");
		} finally {
			statCounter.restore();
		}
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listActive re-scans after cache.clear() (the watcher invalidation path)", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-list-active-invalidate-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		for (let i = 0; i < 5; i++) {
			const { manifest } = createRunManifest({ cwd, team, workflow, goal: `g${i}` });
			updateRunStatus(manifest, "running", "test");
		}

		const cache = createManifestCache(cwd, { watch: false });
		// Warm the cache.
		cache.listActive(1000);

		const statCounter = countStatsUnder(path.join(cwd, ".crew"));
		try {
			const before = statCounter.count();
			// Calls within TTL — should not stat.
			for (let i = 0; i < 10; i++) {
				cache.listActive(1000);
			}
			assert.equal(statCounter.count() - before, 0, "warm cache must not re-stat");

			// cache.clear() routes through invalidate() which now also drops
			// the listActive cache. The next call must re-scan and produce
			// at least 5 new stat calls (one per manifest).
			cache.clear();
			cache.listActive(1000);
			const afterClear = statCounter.count() - before;
			assert.ok(
				afterClear >= 5,
				`post-clear call must re-stat manifests; expected >=5 new stats, got ${afterClear}`,
			);
		} finally {
			statCounter.restore();
		}
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
		assert.equal(
			includedCount,
			20,
			`cached un-capped set must surface all 20 created runs (got ${includedCount}/20)`,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
