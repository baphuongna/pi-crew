import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { pruneFinishedRuns, pruneUserLevelRuns } from "../../../../src/extension/run-maintenance.ts";
import { createMetricRegistry } from "../../../../src/observability/metric-registry.ts";
import { createTrackedTempDir, removeTrackedTempDir } from "../../../fixtures/test-tempdir.ts";

function writeManifest(stateRoot: string, runId: string, status: string, updatedAt: string, cwd: string, artifactsRoot: string) {
	const manifest = {
		schemaVersion: 1,
		runId,
		team: "test",
		goal: "test",
		status,
		workspaceMode: "single",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt,
		cwd,
		stateRoot,
		artifactsRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifacts: [],
	};
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
	fs.writeFileSync(path.join(stateRoot, "tasks.json"), "[]");
	fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "");
}

describe("pruneFinishedRuns", () => {
	it("returns empty results when no runs exist", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-");
		const result = pruneFinishedRuns(tmp, 5);
		assert.deepEqual(result.kept, []);
		assert.deepEqual(result.removed, []);
		removeTrackedTempDir(tmp);
	});

	it("keeps finished runs up to keep limit", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-");
		const runsDir = path.join(tmp, ".crew", "state", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		// Create 3 finished runs
		for (let i = 0; i < 3; i++) {
			const runId = `run-${i}`;
			const stateRoot = path.join(runsDir, runId);
			const artRoot = path.join(tmp, ".crew", "artifacts", runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.mkdirSync(artRoot, { recursive: true });
			writeManifest(stateRoot, runId, "completed", `2026-01-0${i + 1}T00:00:00Z`, tmp, artRoot);
		}

		const result = pruneFinishedRuns(tmp, 2);
		assert.equal(result.kept.length, 2);
		assert.equal(result.removed.length, 1);
		removeTrackedTempDir(tmp);
	});

	it("does not prune active runs", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-");
		const runsDir = path.join(tmp, ".crew", "state", "runs");
		fs.mkdirSync(runsDir, { recursive: true });

		const runId = "active-run";
		const stateRoot = path.join(runsDir, runId);
		const artRoot = path.join(tmp, ".crew", "artifacts", runId);
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.mkdirSync(artRoot, { recursive: true });
		writeManifest(stateRoot, runId, "running", "2026-01-01T00:00:00Z", tmp, artRoot);

		const result = pruneFinishedRuns(tmp, 0);
		assert.equal(result.removed.length, 0);
		removeTrackedTempDir(tmp);
	});
});

describe("pruneUserLevelRuns", () => {
	it("returns empty when user runs dir does not exist", () => {
		// This test just verifies no crash when the dir doesn't exist
		const result = pruneUserLevelRuns(5);
		assert.ok(Array.isArray(result.kept));
		assert.ok(Array.isArray(result.removed));
	});
});

// FIX 1: the health snapshot lives at <crewRoot>/state/health/<runId>.json,
// OUTSIDE stateRoot/artifactsRoot — prune paths must delete it alongside the
// run dirs or it orphans forever (2,322 files / 9.3 MB accumulated pre-fix).
function writeHealthSnapshot(crewRoot: string, runId: string): void {
	const dir = path.join(crewRoot, "state", "health");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${runId}.json`),
		JSON.stringify({ runId, timestamp: Date.now(), score: 100, grade: "A", penalties: [] }),
	);
}

// Isolate the user-level crew root to a tmp home so pruneUserLevelRuns tests
// never touch the developer's real ~/.pi (pattern: config-cache.test.ts).
function isolateUserHome(): { home: string; restore: () => void } {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prune-user-"));
	const prevHome = process.env.PI_TEAMS_HOME;
	const prevCheck = process.env.PI_CREW_SKIP_HOME_CHECK;
	process.env.PI_TEAMS_HOME = home;
	process.env.PI_CREW_SKIP_HOME_CHECK = "1";
	return {
		home,
		restore: () => {
			if (prevHome === undefined) delete process.env.PI_TEAMS_HOME;
			else process.env.PI_TEAMS_HOME = prevHome;
			if (prevCheck === undefined) delete process.env.PI_CREW_SKIP_HOME_CHECK;
			else process.env.PI_CREW_SKIP_HOME_CHECK = prevCheck;
			fs.rmSync(home, { recursive: true, force: true });
		},
	};
}

describe("FIX 1: prune deletes the run's health snapshot", () => {
	it("project-level prune removes the pruned run's snapshot, keeps retained runs'", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-health-");
		const crewRoot = path.join(tmp, ".crew");
		const runsDir = path.join(crewRoot, "state", "runs");
		fs.mkdirSync(runsDir, { recursive: true });
		for (let i = 0; i < 3; i++) {
			const runId = `run-${i}`;
			const stateRoot = path.join(runsDir, runId);
			const artRoot = path.join(crewRoot, "artifacts", runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.mkdirSync(artRoot, { recursive: true });
			writeManifest(stateRoot, runId, "completed", `2026-01-0${i + 1}T00:00:00Z`, tmp, artRoot);
			writeHealthSnapshot(crewRoot, runId);
		}
		const result = pruneFinishedRuns(tmp, 2);
		assert.deepEqual(result.removed, ["run-0"]); // oldest finished run
		const healthDir = path.join(crewRoot, "state", "health");
		assert.ok(!fs.existsSync(path.join(healthDir, "run-0.json")), "pruned run's health snapshot must be deleted");
		assert.ok(fs.existsSync(path.join(healthDir, "run-1.json")), "retained run's snapshot survives");
		assert.ok(fs.existsSync(path.join(healthDir, "run-2.json")), "retained run's snapshot survives");
		removeTrackedTempDir(tmp);
	});

	it("user-level prune removes the pruned run's health snapshot", () => {
		const iso = isolateUserHome();
		try {
			const crewRoot = path.join(iso.home, ".pi", "agent", "extensions", "pi-crew");
			const runId = "team_user_old_run";
			const stateRoot = path.join(crewRoot, "state", "runs", runId);
			const artRoot = path.join(crewRoot, "artifacts", runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.mkdirSync(artRoot, { recursive: true });
			writeManifest(stateRoot, runId, "completed", "2026-01-01T00:00:00Z", iso.home, artRoot);
			writeHealthSnapshot(crewRoot, runId);
			const result = pruneUserLevelRuns(0);
			assert.ok(result.removed.includes(runId), `expected ${runId} pruned, got ${JSON.stringify(result.removed)}`);
			assert.ok(
				!fs.existsSync(path.join(crewRoot, "state", "health", `${runId}.json`)),
				"user-level prune must delete the health snapshot",
			);
		} finally {
			iso.restore();
		}
	});

	it("user-level ghost-run removal deletes the ghost's health snapshot", () => {
		const iso = isolateUserHome();
		try {
			const crewRoot = path.join(iso.home, ".pi", "agent", "extensions", "pi-crew");
			const runId = "team_ghost_run";
			const stateRoot = path.join(crewRoot, "state", "runs", runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			// Active status + cwd that no longer exists → ghost-run path.
			writeManifest(
				stateRoot,
				runId,
				"running",
				"2026-01-01T00:00:00Z",
				path.join(iso.home, "deleted-project"),
				path.join(crewRoot, "artifacts", runId),
			);
			writeHealthSnapshot(crewRoot, runId);
			const result = pruneUserLevelRuns(5);
			assert.ok(result.removed.includes(runId), `expected ghost ${runId} removed, got ${JSON.stringify(result.removed)}`);
			assert.ok(
				!fs.existsSync(path.join(crewRoot, "state", "health", `${runId}.json`)),
				"ghost removal must delete the health snapshot",
			);
		} finally {
			iso.restore();
		}
	});
});

describe("FIX 2 phase-2: prune releases metric labels on the live registry", () => {
	it("pruned run's label series are released; retained runs keep theirs", () => {
		const tmp = createTrackedTempDir("pi-crew-prune-labels-");
		const crewRoot = path.join(tmp, ".crew");
		const runsDir = path.join(crewRoot, "state", "runs");
		fs.mkdirSync(runsDir, { recursive: true });
		const registry = createMetricRegistry();
		const counter = registry.counter("crew.test.run_events_total", "test counter");
		for (let i = 0; i < 2; i++) {
			const runId = `run-${i}`;
			const stateRoot = path.join(runsDir, runId);
			const artRoot = path.join(crewRoot, "artifacts", runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.mkdirSync(artRoot, { recursive: true });
			writeManifest(stateRoot, runId, "completed", `2026-01-0${i + 1}T00:00:00Z`, tmp, artRoot);
			counter.inc({ runId, phase: "settled" });
		}
		const result = pruneFinishedRuns(tmp, 1, { metricRegistry: registry });
		assert.deepEqual(result.removed, ["run-0"]);
		const snap = registry.snapshot().find((s) => s.name === "crew.test.run_events_total");
		assert.ok(snap, "counter must still be registered");
		const remainingRunIds = (snap?.values ?? []).map((point) => point.labels.runId);
		assert.ok(!remainingRunIds.includes("run-0"), "pruned run's label series must be released");
		assert.ok(remainingRunIds.includes("run-1"), "retained run's label series must survive");
		removeTrackedTempDir(tmp);
	});
});
