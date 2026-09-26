import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { reconcileOrphanedTempWorkspaces } from "../../../../src/runtime/stale-reconciler.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

/**
 * Bug B regression (live 2026-09-26): the temp-workspace sweep took only the
 * alphabetically-first `slice(0, 50)` each tick. A cluster of UNCLEANABLE dirs
 * at the head of the alphabet (42 frozen `.cleanup-in-progress` sentinels in
 * `agent-stale-wakeup-test-*`) therefore occupied the batch forever — ~3.4k
 * dirs behind them were never scanned. The batch index must ROTATE per tick
 * (stateless, derived from `now`) so later slices get their turn.
 */

const HOUR = 60 * 60 * 1000;
const TICK = 60_000;

function makeDir(
	parent: string,
	name: string,
	opts: { manifest?: "completed" | "none"; freshSentinel?: boolean; old?: boolean },
	now: number,
): string {
	const dir = path.join(parent, name);
	fs.mkdirSync(dir, { recursive: true });
	if (opts.manifest === "completed") {
		const runDir = path.join(dir, ".crew", "state", "runs", `run_${name}`);
		fs.mkdirSync(runDir, { recursive: true });
		const manifest: TeamRunManifest = {
			schemaVersion: 1,
			runId: `run_${name}`,
			cwd: dir,
			team: "t",
			goal: "g",
			status: "completed",
			createdAt: new Date(now - 2 * HOUR).toISOString(),
			updatedAt: new Date(now - 2 * HOUR).toISOString(),
			stateRoot: path.join(dir, ".crew", "state"),
			artifactsRoot: path.join(dir, ".crew", "artifacts"),
			tasksPath: path.join(runDir, "tasks.json"),
			eventsPath: path.join(runDir, "events.jsonl"),
			workspaceMode: "single",
			artifacts: [],
		};
		fs.writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify(manifest));
		fs.writeFileSync(path.join(runDir, "tasks.json"), "[]");
	}
	if (opts.freshSentinel) {
		fs.writeFileSync(path.join(dir, ".cleanup-in-progress"), JSON.stringify({ startedAt: now - 30_000 }));
	}
	const t = new Date(opts.old === false ? now : now - 2 * HOUR);
	fs.utimesSync(dir, t, t);
	return dir;
}

test("batch ROTATION reaches dirs behind a stuck alphabetical head cluster", () => {
	const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-isotmp-"));
	try {
		// 2 batches at scanBatchSize=50: batch 0 = 50 STUCK dirs (fresh sentinels,
		// alphabetically first: a-stuck-*), batch 1 = 5 CLEANABLE dirs (z-clean-*).
		// Pick an ODD tick index near real wall-clock so manifest timestamps are
		// realistic (1970-era `now` trips manifest validation) while batch
		// selection stays deterministic: floor(now/TICK) % 2 === 1.
		const k = Math.floor(Date.now() / TICK / 2);
		const now = (2 * k + 1) * TICK; // odd multiple of one tick → batch 1
		const stuck: string[] = [];
		for (let i = 0; i < 50; i++) {
			stuck.push(makeDir(isolatedTmp, `pi-crew-a-stuck-${String(i).padStart(2, "0")}`, { freshSentinel: true, old: true }, now));
		}
		const clean: string[] = [];
		for (let i = 0; i < 5; i++) {
			clean.push(makeDir(isolatedTmp, `pi-crew-z-clean-${String(i).padStart(2, "0")}`, { manifest: "completed", old: true }, now));
		}
		const result = reconcileOrphanedTempWorkspaces(now, { tmpDir: isolatedTmp, scanBatchSize: 50, cleanupOrphanedTempDirs: true });
		// The old slice(0,50) code would visit ONLY the stuck batch → cleanedDirs 0
		// and the z-clean dirs would never be reached (starvation). Rotation must
		// process batch 1 this tick.
		assert.ok(result.cleanedDirs >= 1, `expected rotation to clean batch 1, got ${JSON.stringify(result)}`);
		assert.ok(
			clean.some((d) => !fs.existsSync(d)),
			"at least one z-clean dir must be cleaned on a batch-1 tick",
		);
		// Batch-0 tick (one tick earlier): stuck dirs survive, nothing crashes.
		const earlier = 2 * k * TICK; // even multiple of one tick → batch 0
		const r0 = reconcileOrphanedTempWorkspaces(earlier, { tmpDir: isolatedTmp, scanBatchSize: 50, cleanupOrphanedTempDirs: true });
		assert.ok(
			stuck.every((d) => fs.existsSync(d)),
			"fresh-sentinel dirs must be preserved",
		);
		assert.equal(r0.cleanedDirs, 0);
	} finally {
		fs.rmSync(isolatedTmp, { recursive: true, force: true });
	}
});
