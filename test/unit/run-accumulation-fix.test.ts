/**
 * Tests for the stale run accumulation fixes:
 * - Bug 2: purgeStaleActiveRunIndex deletes directories
 * - Bug 3: pruneUserLevelRuns cleans user-level run directories
 * - Bug 4: registerActiveRun filters terminal entries inline
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_PATHS } from "../../src/config/defaults.ts";
import { pruneUserLevelRuns } from "../../src/extension/run-maintenance.ts";
import { readActiveRunRegistry, registerActiveRun } from "../../src/state/active-run-registry.ts";
import { createRunManifest, updateRunStatus } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import { userCrewRoot } from "../../src/utils/paths.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "ari",
	description: "ari",
	source: "builtin",
	filePath: "ari.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "ari",
	description: "ari",
	source: "builtin",
	filePath: "ari.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-accum-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

// ─── Bug 4: registerActiveRun filters terminal entries ───

test("registerActiveRun filters out terminal entries before writing", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reg-filter-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			// Create a run and register it
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "terminal filter test",
			});
			registerActiveRun(created.manifest);

			// Transition to running then completed
			updateRunStatus(created.manifest, "running", "started");
			// Re-read to get updated manifest for next transition
			const updatedManifest = {
				...created.manifest,
				status: "running" as const,
				updatedAt: new Date().toISOString(),
			};
			updateRunStatus(updatedManifest, "completed", "done");

			// Create a second run and register it
			const created2 = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "second run",
			});
			registerActiveRun(created2.manifest);

			// The registry should only have the second (non-terminal) run
			const entries = readActiveRunRegistry();
			assert.equal(entries.length, 1, "Registry should contain only 1 active entry after filtering terminal ones");
			assert.equal(entries[0]!.runId, created2.manifest.runId, "Remaining entry should be the second run");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("registerActiveRun filters out entries with missing manifest files", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reg-missing-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			// Create a run and register it
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "missing manifest test",
			});
			registerActiveRun(created.manifest);

			// Delete the manifest file to simulate stale entry
			fs.rmSync(created.manifest.stateRoot, {
				recursive: true,
				force: true,
			});

			// Create a second run and register — should filter the missing one
			const created2 = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "still alive",
			});
			registerActiveRun(created2.manifest);

			const entries = readActiveRunRegistry();
			assert.equal(entries.length, 1, "Registry should only have the entry with existing manifest");
			assert.equal(entries[0]!.runId, created2.manifest.runId);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("registerActiveRun keeps active entries intact", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-reg-active-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			// Create and register a running run
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "running run",
			});
			registerActiveRun(created.manifest);

			// Create and register a second running run
			const created2 = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "another running run",
			});
			registerActiveRun(created2.manifest);

			// Both should be present (both are still "queued" status)
			const entries = readActiveRunRegistry();
			assert.equal(entries.length, 2, "Both active entries should be preserved");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

// ─── Bug 3: pruneUserLevelRuns ───

test("pruneUserLevelRuns removes old finished user-level runs", () => {
	withIsolatedHome(() => {
		const crewRoot = userCrewRoot();
		const runsRoot = path.join(crewRoot, DEFAULT_PATHS.state.runsSubdir);
		fs.mkdirSync(runsRoot, { recursive: true });

		// Create 5 finished runs at user level
		const runIds: string[] = [];
		for (let i = 0; i < 5; i++) {
			const runId = `team_${Date.now()}_run_${i}_${Math.random().toString(36).slice(2, 8)}`;
			const stateRoot = path.join(runsRoot, runId);
			const artifactsRoot = path.join(crewRoot, DEFAULT_PATHS.state.artifactsSubdir, runId);
			fs.mkdirSync(stateRoot, { recursive: true });
			fs.mkdirSync(artifactsRoot, { recursive: true });

			const manifest = {
				schemaVersion: 1,
				runId,
				team: "test",
				status: "completed",
				createdAt: new Date(Date.now() - (5 - i) * 1000).toISOString(),
				updatedAt: new Date(Date.now() - (5 - i) * 1000).toISOString(),
				cwd: crewRoot,
				stateRoot,
				artifactsRoot,
				tasksPath: path.join(stateRoot, "tasks.json"),
				eventsPath: path.join(stateRoot, "events.jsonl"),
				goal: `test run ${i}`,
			};
			fs.writeFileSync(path.join(stateRoot, DEFAULT_PATHS.state.manifestFile), JSON.stringify(manifest));
			runIds.push(runId);
		}

		// Prune to keep only 2
		const result = pruneUserLevelRuns(2);
		assert.equal(result.removed.length, 3, "Should remove 3 old runs");
		assert.equal(result.kept.length, 2, "Should keep 2 runs");

		// Verify the newest 2 still exist
		assert.equal(fs.existsSync(path.join(runsRoot, runIds[4]!)), true, "Newest run should exist");
		assert.equal(fs.existsSync(path.join(runsRoot, runIds[3]!)), true, "Second newest should exist");

		// Verify the oldest 3 are gone
		assert.equal(fs.existsSync(path.join(runsRoot, runIds[0]!)), false, "Oldest run should be removed");
		assert.equal(fs.existsSync(path.join(runsRoot, runIds[1]!)), false, "Second oldest should be removed");
		assert.equal(fs.existsSync(path.join(runsRoot, runIds[2]!)), false, "Third oldest should be removed");
	});
});

test("pruneUserLevelRuns skips non-finished runs", () => {
	withIsolatedHome(() => {
		const crewRoot = userCrewRoot();
		const runsRoot = path.join(crewRoot, DEFAULT_PATHS.state.runsSubdir);
		fs.mkdirSync(runsRoot, { recursive: true });

		// Create a running run (not finished)
		const runId = `team_${Date.now()}_running_${Math.random().toString(36).slice(2, 8)}`;
		const stateRoot = path.join(runsRoot, runId);
		const artifactsRoot = path.join(crewRoot, DEFAULT_PATHS.state.artifactsSubdir, runId);
		fs.mkdirSync(stateRoot, { recursive: true });
		fs.mkdirSync(artifactsRoot, { recursive: true });

		const manifest = {
			schemaVersion: 1,
			runId,
			team: "test",
			status: "running",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			cwd: crewRoot,
			stateRoot,
			artifactsRoot,
			tasksPath: path.join(stateRoot, "tasks.json"),
			eventsPath: path.join(stateRoot, "events.jsonl"),
			goal: "running test",
		};
		fs.writeFileSync(path.join(stateRoot, DEFAULT_PATHS.state.manifestFile), JSON.stringify(manifest));

		// Prune to keep 0 — should NOT remove the running run
		const result = pruneUserLevelRuns(0);
		assert.equal(result.removed.length, 0, "Should not remove running runs");
		assert.equal(fs.existsSync(stateRoot), true, "Running run directory should still exist");
	});
});

test("pruneUserLevelRuns returns empty when no runs directory exists", () => {
	withIsolatedHome(() => {
		const result = pruneUserLevelRuns(10);
		assert.equal(result.kept.length, 0);
		assert.equal(result.removed.length, 0);
	});
});
