import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { reconcileOrphanedTempWorkspaces } from "../../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest, TeamTaskState } from "../../../../src/state/types.ts";

/**
 * Frozen-workspace regression (live 2026-09-26): a session killed between
 * sentinel-create and dir-delete abandoned `.cleanup-in-progress` files; every
 * later reconcile tick hit EEXIST → "another cleanup in progress" → skip, with
 * NO TTL — 42 workspaces were frozen out of the cleanup cycle forever. A stale
 * sentinel (older than SENTINEL_STALE_RECLAIM_MS = 10 min) must be reclaimed
 * and the workspace cleaned; a FRESH sentinel must still block.
 */

const HOUR = 60 * 60 * 1000;

function makeWorkspace(isolatedTmp: string): string {
	const wsDir = fs.mkdtempSync(path.join(isolatedTmp, "pi-crew-sentinel-"));
	const runDir = path.join(wsDir, ".crew", "state", "runs", "run_sentinel_1");
	fs.mkdirSync(runDir, { recursive: true });
	const manifest: TeamRunManifest = {
		schemaVersion: 1,
		runId: "run_sentinel_1",
		cwd: wsDir,
		team: "t",
		goal: "g",
		status: "completed",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		stateRoot: path.join(wsDir, ".crew", "state"),
		artifactsRoot: path.join(wsDir, ".crew", "artifacts"),
		tasksPath: path.join(runDir, "tasks.json"),
		eventsPath: path.join(runDir, "events.jsonl"),
		workspaceMode: "single",
		artifacts: [],
	};
	fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
	const tasks: TeamTaskState[] = [
		{
			id: "task-1",
			runId: "run_sentinel_1",
			role: "executor",
			agent: "a",
			title: "t",
			status: "completed",
			dependsOn: [],
			cwd: wsDir,
			finishedAt: new Date().toISOString(),
		},
	];
	fs.writeFileSync(path.join(runDir, "tasks.json"), JSON.stringify(tasks));
	return wsDir;
}

function run(name: string, sentinelAgeMs: number, expectCleaned: boolean): void {
	test(name, () => {
		const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-isotmp-"));
		try {
			const now = Date.now();
			const wsDir = makeWorkspace(isolatedTmp);
			// Abandon a sentinel `sentinelAgeMs` ago; the workspace dir itself is
			// 2h old (dirAge passes the 1h threshold — the realistic live shape:
			// frozen dirs sit around for hours).
			const sentinelPath = path.join(wsDir, ".cleanup-in-progress");
			fs.writeFileSync(sentinelPath, JSON.stringify({ startedAt: now - sentinelAgeMs }));
			const old = new Date(now - 2 * HOUR);
			fs.utimesSync(wsDir, old, old);
			fs.utimesSync(sentinelPath, new Date(now - sentinelAgeMs), new Date(now - sentinelAgeMs));

			const result = reconcileOrphanedTempWorkspaces(now, { tmpDir: isolatedTmp, cleanupOrphanedTempDirs: true });
			if (expectCleaned) {
				assert.ok(result.cleanedDirs >= 1, `expected cleanup, got ${JSON.stringify(result)}`);
				assert.ok(!fs.existsSync(wsDir), "stale-sentinel workspace must be reclaimed and deleted");
			} else {
				assert.ok(fs.existsSync(wsDir), "fresh-sentinel workspace must be preserved");
			}
		} finally {
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
}

run("sentinel STALE (>10min, abandoned by a dead owner) → reclaimed + workspace cleaned", 15 * 60 * 1000, true);
run("sentinel FRESH (≤10min, live cleanup in progress) → still blocks cleanup", 30 * 1000, false);
