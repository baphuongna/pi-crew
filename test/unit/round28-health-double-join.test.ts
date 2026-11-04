/**
 * BUG A (pts/2 hang investigation 2026-06-16): double-joined health path.
 *
 * stateRoot = `<crewRoot>/state/runs/<runId>`. The crew root is THREE dirnames
 * up, but team-runner computed only TWO → got `<crewRoot>/state` (the state
 * dir). HealthStore then joined HEALTH_DIR (`.crew/state/health`) onto it →
 * `<crewRoot>/state/.crew/state/health` — a bogus double-joined path. Health
 * snapshots were silently written to a nonexistent subtree (breaking the
 * feature) AND created junk dirs the recursive state watcher attached extra
 * inotify watches to.
 *
 * Fix: crewRoot = 3 dirnames up; HEALTH_DIR = "state/health" (relative to crew root).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { HealthStore, removeHealthSnapshot, sweepOrphanHealthSnapshots } from "../../src/state/stores/health-store.ts";

function tmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-health-path-"));
}

describe("BUG A: health snapshot path is NOT double-joined", () => {
	it("writes to <crewRoot>/state/health/<runId>.json (single join)", () => {
		const crewRoot = tmpDir();
		try {
			const store = new HealthStore(crewRoot);
			store.saveSnapshot({
				runId: "team_test_run_001",
				tasks: [{ id: "01", status: "completed" }],
				createdAt: new Date().toISOString(),
			});
			const expected = path.join(crewRoot, "state", "health", "team_test_run_001.json");
			assert.ok(fs.existsSync(expected), `expected health file at ${expected}`);
			const parsed = JSON.parse(fs.readFileSync(expected, "utf-8"));
			assert.equal(parsed.runId, "team_test_run_001");
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});

	it("does NOT create a double-joined .crew/state/.crew/state/ subtree", () => {
		const crewRoot = tmpDir();
		try {
			const store = new HealthStore(crewRoot);
			store.saveSnapshot({
				runId: "team_test_run_002",
				tasks: [],
				createdAt: new Date().toISOString(),
			});
			// The bug created <crewRoot>/state/.crew/state/health/... — assert it does NOT exist.
			const bogus = path.join(crewRoot, "state", ".crew", "state", "health");
			assert.ok(!fs.existsSync(bogus), `double-joined bogus subtree must not exist: ${bogus}`);
			// Also assert no nested .crew under state at all.
			const nestedCrew = path.join(crewRoot, "state", ".crew");
			assert.ok(!fs.existsSync(nestedCrew), `no nested .crew under state/: ${nestedCrew}`);
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});

	it("crewRoot computed from stateRoot (3 dirnames) yields the correct health path", () => {
		// Mirror team-runner's computation exactly.
		const crewRoot = tmpDir();
		const stateRoot = path.join(crewRoot, "state", "runs", "team_xyz");
		fs.mkdirSync(stateRoot, { recursive: true });
		try {
			const computedCrewRoot = path.dirname(path.dirname(path.dirname(stateRoot)));
			assert.equal(path.resolve(computedCrewRoot), path.resolve(crewRoot));
			const store = new HealthStore(computedCrewRoot);
			store.saveSnapshot({
				runId: "team_xyz",
				tasks: [{ id: "01", status: "completed" }],
				createdAt: new Date().toISOString(),
			});
			assert.ok(fs.existsSync(path.join(crewRoot, "state", "health", "team_xyz.json")));
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});
});

// FIX 1 (retention): health snapshots live outside the run dir, so prune/forget
// must call removeHealthSnapshot, and a sweep must clean up orphans left by
// pre-fix prunes. Conservative: exists-but-unreadable run dir → KEEP.
describe("FIX 1: removeHealthSnapshot / sweepOrphanHealthSnapshots", () => {
	it("removeHealthSnapshot deletes the file once and reports false when absent", () => {
		const crewRoot = tmpDir();
		try {
			const store = new HealthStore(crewRoot);
			store.saveSnapshot({
				runId: "team_gone_001",
				tasks: [],
				createdAt: new Date().toISOString(),
			});
			assert.equal(removeHealthSnapshot(crewRoot, "team_gone_001"), true);
			assert.ok(!fs.existsSync(path.join(crewRoot, "state", "health", "team_gone_001.json")));
			// Second call: ENOENT → false (already gone), not an error.
			assert.equal(removeHealthSnapshot(crewRoot, "team_gone_001"), false);
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});

	it("sweep removes ONLY snapshots whose run dir is absent; keeps one whose run dir exists", () => {
		const crewRoot = tmpDir();
		try {
			const healthDir = path.join(crewRoot, "state", "health");
			fs.mkdirSync(healthDir, { recursive: true });
			// Orphan: no run dir under state/runs/.
			fs.writeFileSync(path.join(healthDir, "team_orphan_001.json"), "{}\n");
			// Owned: run dir exists → snapshot is still referenced.
			fs.writeFileSync(path.join(healthDir, "team_live_001.json"), "{}\n");
			fs.mkdirSync(path.join(crewRoot, "state", "runs", "team_live_001"), { recursive: true });
			const { removed, kept } = sweepOrphanHealthSnapshots(crewRoot);
			assert.deepEqual(removed, ["team_orphan_001"]);
			assert.equal(kept, 1);
			assert.ok(!fs.existsSync(path.join(healthDir, "team_orphan_001.json")));
			assert.ok(fs.existsSync(path.join(healthDir, "team_live_001.json")));
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});

	it("sweep is a no-op when the health dir does not exist", () => {
		const crewRoot = tmpDir();
		try {
			const { removed, kept } = sweepOrphanHealthSnapshots(crewRoot);
			assert.deepEqual(removed, []);
			assert.equal(kept, 0);
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});

	it("sweep honors the bounded maxFiles option", () => {
		const crewRoot = tmpDir();
		try {
			const healthDir = path.join(crewRoot, "state", "health");
			fs.mkdirSync(healthDir, { recursive: true });
			for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(healthDir, `team_orphan_${i}.json`), "{}\n");
			const { removed } = sweepOrphanHealthSnapshots(crewRoot, { maxFiles: 2 });
			assert.equal(removed.length, 2); // bounded — remaining 3 untouched
			assert.ok(fs.existsSync(path.join(healthDir, "team_orphan_4.json")));
		} finally {
			fs.rmSync(crewRoot, { recursive: true, force: true });
		}
	});
});
