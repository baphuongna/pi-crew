import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildHealthReport,
	countStatuses,
	detectStuckTasks,
	handleHealthMonitor,
	STUCK_TASK_THRESHOLD_MS,
	scanZombieTempWorkspaces,
} from "../../src/extension/team-tool/health-monitor.ts";
import {
	registerActiveRun,
	unregisterActiveRun,
} from "../../src/state/active-run-registry.ts";
import {
	__test__clearManifestCache,
	createRunManifest,
	saveRunManifest,
	saveRunTasks,
	updateRunStatus,
} from "../../src/state/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import { clearProjectRootCache } from "../../src/utils/paths.ts";
import { sharedScanCache } from "../../src/utils/scan-cache.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

// ── Shared fixtures ──────────────────────────────────────────────────

const team: TeamConfig = {
	name: "health-test",
	description: "health monitor test team",
	source: "builtin",
	filePath: "health-test.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "health-test",
	description: "health monitor test workflow",
	source: "builtin",
	filePath: "health-test.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

/**
 * Isolate PI_TEAMS_HOME to a temp dir so user-level state doesn't leak
 * between tests or into the developer's real home directory.
 */
function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-health-home-"));
	process.env.PI_TEAMS_HOME = home;
	clearProjectRootCache();
	sharedScanCache.clear();
	__test__clearManifestCache();
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
		clearProjectRootCache();
		sharedScanCache.clear();
		__test__clearManifestCache();
	}
}

/** Create a temp project cwd with .crew directory. */
function createProjectCwd(tmpDir?: string): string {
	const base = tmpDir ?? os.tmpdir();
	// Use a prefix that does NOT start with "pi-crew-" so zombie scanners don't match.
	const cwd = fs.mkdtempSync(path.join(base, "hc-cwd-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	return cwd;
}

/** Create an isolated tmpDir for zombie/temp workspace scanning. */
function createIsolatedTmpDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-health-tmp-"));
}

/** Extract report text from the health-monitor tool result. */
function reportText(result: {
	content: Array<{ type: string; text?: string }>;
}): string {
	return result.content.map((item) => item.text ?? "").join("\n");
}

// ── 1. Ghost run detection ──────────────────────────────────────────

// Ghost detection relies on the active-run registry returning a manifest whose
// cwd field points to a deleted directory.  collectRuns in run-index.ts already
// pre-filters active-status runs with dead cwds from filesystem scanning, so
// ghost runs only surface through collectActiveRuns().  activeRunEntries()
// checks the *registry entry's* cwd (set at registration time), not the
// manifest's cwd field.  By modifying the manifest's cwd after registration,
// we create a scenario where the entry passes the registry's cwd-existence
// check but the health monitor sees a manifest with a dead cwd.

test("should detect ghost run when manifest cwd no longer exists but registry entry cwd does", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);
		// realDir stays alive — it is the cwd registered in the active-run index.
		const realDir = fs.mkdtempSync(path.join(isolatedTmp, "hc-realdir-"));
		fs.mkdirSync(path.join(realDir, ".crew"));

		try {
			const created = createRunManifest({
				cwd: realDir,
				team,
				workflow,
				goal: "ghost run",
			});
			registerActiveRun(created.manifest);

			// Rewrite the manifest with a cwd that does NOT exist.
			// The registry entry still points to realDir (which exists),
			// so activeRunEntries() includes this run.  But the health
			// monitor reads manifest.cwd = ghostDir and detects the ghost.
			const ghostDir = path.join(
				isolatedTmp,
				"pi-crew-health-ghost-" + Date.now(),
			);
			const ghostManifest: TeamRunManifest = {
				...created.manifest,
				status: "running",
				cwd: ghostDir,
			};
			saveRunManifest(ghostManifest);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 1);
			assert.equal(counts.ghost, 1);
			assert.match(text, /Ghost \(dead cwd\): 1/);
			assert.ok(
				text.includes(created.manifest.runId),
				"report should list the ghost runId",
			);
			assert.match(text, /Ghost runs:/);
		} finally {
			try {
				unregisterActiveRun("");
			} catch {
				/* best-effort */
			}
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(realDir, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("should not crash when ghost run is fully deleted (cwd gone, registry filtered)", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);
		const ghostCwd = fs.mkdtempSync(
			path.join(isolatedTmp, "pi-crew-health-ghost-"),
		);

		try {
			// Create a run, register it, then delete the cwd entirely.
			// Both collectRuns and activeRunEntries filter this out.
			const created = createRunManifest({
				cwd: ghostCwd,
				team,
				workflow,
				goal: "ghost run",
			});
			registerActiveRun(created.manifest);
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);

			fs.rmSync(ghostCwd, { recursive: true, force: true });

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			// The run is filtered by both paths; the health monitor should
			// produce a clean report without crashing.
			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 0);
			assert.match(text, /All runs healthy\./);
		} finally {
			try {
				unregisterActiveRun("");
			} catch {
				/* best-effort */
			}
			fs.rmSync(projectCwd, { recursive: true, force: true });
			try {
				fs.rmSync(ghostCwd, { recursive: true, force: true });
			} catch {
				/* already deleted */
			}
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 2. Orphaned run — stale async PID ───────────────────────────────

test("should detect orphaned run with stale async PID past threshold", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "stale async pid",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);

			// Simulate an async run with a non-existent PID and updatedAt 31 minutes ago.
			const staleTime = new Date(
				Date.now() - 31 * 60 * 1000,
			).toISOString();
			const staleManifest: TeamRunManifest = {
				...running,
				async: {
					pid: 999999,
					logPath: "/dev/null",
					spawnedAt: new Date().toISOString(),
				},
				updatedAt: staleTime,
			};
			saveRunManifest(staleManifest);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 1);
			assert.match(text, /Orphaned \(stale process\): 1/);
			assert.match(text, /stale-async-pid/);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 3. Orphaned run — non-async stale run with no progress ──────────

test("should detect orphaned non-async stale run with no agent progress", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "stale no-progress run",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);

			// Set updatedAt to 3 minutes ago (past ORPHANED_ACTIVE_RUN_MS = 2 min).
			const staleTime = new Date(
				Date.now() - 3 * 60 * 1000,
			).toISOString();
			const staleManifest: TeamRunManifest = {
				...running,
				updatedAt: staleTime,
			};
			saveRunManifest(staleManifest);

			// Write agents.json with all agents in "queued" status and no progress.
			const agentsPath = path.join(
				staleManifest.stateRoot,
				"agents.json",
			);
			fs.writeFileSync(
				agentsPath,
				JSON.stringify([
					{
						id: "agent-1",
						runId: staleManifest.runId,
						taskId: created.tasks[0]!.id,
						agent: "planner",
						role: "planner",
						runtime: "scaffold",
						status: "queued",
						startedAt: staleTime,
					},
				]),
			);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 1);
			assert.match(text, /Orphaned \(stale process\): 1/);
			assert.match(text, /stale-no-progress/);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 4. Corrupted run detection ──────────────────────────────────────

test("should detect corrupted run when artifacts root is missing", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "corrupted run",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);

			// Delete the artifacts root but keep the state root (manifest survives).
			fs.rmSync(running.artifactsRoot, { recursive: true, force: true });

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 1);
			assert.match(text, /Corrupted \(missing state\): 1/);
			assert.ok(
				text.includes(running.runId),
				`report should contain runId ${running.runId}`,
			);
			assert.match(text, /Corrupted runs:/);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("should detect corrupted run when state root is missing", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "missing state",
			});
			// Note: can't updateRunStatus because stateRoot is about to be deleted.
			// Leave status as "queued" (active) so the health monitor checks it.

			// The state root contains the manifest. Deleting it means collectRuns
			// cannot read the manifest either. However, if the run is in the
			// active-run registry, collectActiveRuns may surface it.
			// Register before deleting.
			registerActiveRun(created.manifest);

			// Save the runId before deleting state root.
			const runId = created.manifest.runId;
			const artifactsRoot = created.manifest.artifactsRoot;

			// Delete state root (which contains the manifest).
			fs.rmSync(created.paths.stateRoot, {
				recursive: true,
				force: true,
			});

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			// The health monitor should produce a valid report without crashing.
			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);
			assert.ok(text.includes("pi-crew health report"));
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 5. Healthy run ──────────────────────────────────────────────────

test("should report all runs healthy when no issues found", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "healthy run",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);
			updateRunStatus(running, "completed", "done");

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 1);
			assert.match(text, /All runs healthy\./);
			assert.doesNotMatch(text, /Ghost \(dead cwd\): [1-9]/);
			assert.doesNotMatch(text, /Orphaned \(stale process\): [1-9]/);
			assert.doesNotMatch(text, /Corrupted \(missing state\): [1-9]/);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 6. Cross-scope scanning ─────────────────────────────────────────

test("should scan both project and user level runs", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			// Project-scoped run.
			const projectRun = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "project run",
			});
			const projectRunning = updateRunStatus(
				projectRun.manifest,
				"running",
				"started",
			);
			updateRunStatus(projectRunning, "completed", "project done");

			// User-level run: use a cwd WITHOUT .crew so it falls back to user scope.
			// The run's state ends up under PI_TEAMS_HOME/.pi/agent/extensions/pi-crew/.
			const userCwd = fs.mkdtempSync(path.join(isolatedTmp, "hc-user-"));
			try {
				const userRun = createRunManifest({
					cwd: userCwd,
					team,
					workflow,
					goal: "user run",
				});
				const userRunning = updateRunStatus(
					userRun.manifest,
					"running",
					"started",
				);
				updateRunStatus(userRunning, "completed", "user done");

				clearProjectRootCache();
				sharedScanCache.clear();
				__test__clearManifestCache();

				const { text, counts } = buildHealthReport(
					{ cwd: projectCwd },
					{},
					{ tmpDir: isolatedTmp },
				);

				// Both runs should be scanned: 1 project + 1 user = 2.
				assert.equal(counts.total, 2);
				assert.match(text, /All runs healthy\./);
			} finally {
				fs.rmSync(userCwd, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 7. Empty scan ───────────────────────────────────────────────────

test("should report zero runs and healthy when no runs exist", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 0);
			assert.match(text, /All runs healthy\./);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 8. Mixed issues: orphaned + corrupted ───────────────────────────

test("should report multiple issue types in a single scan", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			// Run 1: orphaned (stale async PID).
			const run1 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "orphaned",
			});
			const run1Running = updateRunStatus(
				run1.manifest,
				"running",
				"started",
			);
			const staleTime = new Date(
				Date.now() - 31 * 60 * 1000,
			).toISOString();
			saveRunManifest({
				...run1Running,
				async: {
					pid: 999999,
					logPath: "/dev/null",
					spawnedAt: new Date().toISOString(),
				},
				updatedAt: staleTime,
			});

			// Run 2: corrupted (missing artifacts).
			const run2 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "corrupted",
			});
			fs.rmSync(run2.manifest.artifactsRoot, {
				recursive: true,
				force: true,
			});

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 2);
			assert.match(text, /Orphaned \(stale process\): 1/);
			assert.match(text, /Corrupted \(missing state\): 1/);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 9. Status counts ────────────────────────────────────────────────

test("should count status accurately across runs", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			// Run 1: completed
			const r1 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "completed",
			});
			const r1r = updateRunStatus(r1.manifest, "running", "started");
			updateRunStatus(r1r, "completed", "done");

			// Run 2: failed
			const r2 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "failed",
			});
			const r2r = updateRunStatus(r2.manifest, "running", "started");
			updateRunStatus(r2r, "failed", "error");

			// Run 3: cancelled
			const r3 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "cancelled",
			});
			const r3r = updateRunStatus(r3.manifest, "running", "started");
			updateRunStatus(r3r, "cancelled", "stopped");

			// Run 4: blocked (can transition from running)
			const r4 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "blocked",
			});
			const r4r = updateRunStatus(r4.manifest, "running", "started");
			updateRunStatus(r4r, "blocked", "waiting");

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 4);
			assert.equal(counts.completed, 1);
			assert.equal(counts.failed, 1);
			assert.equal(counts.cancelled, 1);
			assert.equal(counts.blocked, 1);
			assert.equal(counts.running, 0);
			assert.equal(counts.queued, 0);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("should count running and queued runs", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			// Queued run (stays queued)
			const r1 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "queued",
			});

			// Running run with a recent heartbeat so it's not orphaned
			const r2 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "running",
			});
			const r2r = updateRunStatus(r2.manifest, "running", "started");
			// Write agents.json with a running agent so it's not orphaned
			const agentsPath = path.join(r2r.stateRoot, "agents.json");
			fs.writeFileSync(
				agentsPath,
				JSON.stringify([
					{
						id: "agent-1",
						runId: r2r.runId,
						taskId: r2.tasks[0]!.id,
						agent: "planner",
						role: "planner",
						runtime: "scaffold",
						status: "running",
						startedAt: new Date().toISOString(),
						progress: {
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
						},
					},
				]),
			);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.total, 2);
			assert.equal(counts.queued, 1);
			assert.equal(counts.running, 1);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 10. Stuck task detection ────────────────────────────────────────

test("should detect stuck tasks with stale heartbeat", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "stuck task",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);

			// Create a task with status "running" and stale lastActivityAt (10 minutes ago)
			const staleActivity = new Date(
				Date.now() - 10 * 60 * 1000,
			).toISOString();
			const staleTasks: TeamTaskState[] = [
				{
					...created.tasks[0]!,
					status: "running",
					startedAt: new Date(
						Date.now() - 15 * 60 * 1000,
					).toISOString(),
					agentProgress: {
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						lastActivityAt: staleActivity,
					},
				},
			];
			saveRunTasks(running, staleTasks);

			// Write agents.json with a running agent so the run isn't orphaned
			const agentsPath = path.join(running.stateRoot, "agents.json");
			fs.writeFileSync(
				agentsPath,
				JSON.stringify([
					{
						id: "agent-1",
						runId: running.runId,
						taskId: staleTasks[0]!.id,
						agent: "planner",
						role: "planner",
						runtime: "scaffold",
						status: "running",
						startedAt: new Date().toISOString(),
						progress: {
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							lastActivityAt: staleActivity,
						},
					},
				]),
			);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text, counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(counts.stuck, 1, "should detect 1 stuck task");
			assert.match(text, /Stuck tasks \(heartbeat >5min\): 1/);
			assert.match(text, /Stuck tasks:/);
			assert.ok(
				text.includes(staleTasks[0]!.id),
				"should list the stuck task ID",
			);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("should not flag recently active tasks as stuck", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "active task",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);

			// Task with very recent activity (1 minute ago)
			const recentActivity = new Date(
				Date.now() - 1 * 60 * 1000,
			).toISOString();
			const activeTasks: TeamTaskState[] = [
				{
					...created.tasks[0]!,
					status: "running",
					startedAt: recentActivity,
					agentProgress: {
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						lastActivityAt: recentActivity,
					},
				},
			];
			saveRunTasks(running, activeTasks);

			// Write agents.json so run isn't orphaned
			const agentsPath = path.join(running.stateRoot, "agents.json");
			fs.writeFileSync(
				agentsPath,
				JSON.stringify([
					{
						id: "agent-1",
						runId: running.runId,
						taskId: activeTasks[0]!.id,
						agent: "planner",
						role: "planner",
						runtime: "scaffold",
						status: "running",
						startedAt: recentActivity,
						progress: {
							recentTools: [],
							recentOutput: [],
							toolCount: 1,
							lastActivityAt: recentActivity,
						},
					},
				]),
			);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.equal(
				counts.stuck,
				0,
				"recently active task should not be stuck",
			);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 11. Zombie /tmp/ workspace detection ────────────────────────────

test("should count zombie /tmp/ workspaces with run manifests", () => {
	const isolatedTmp = createIsolatedTmpDir();

	try {
		// Create a pi-crew-* workspace with a run manifest
		const ws1 = path.join(isolatedTmp, "pi-crew-test-workspace-1");
		const ws1Runs = path.join(ws1, ".crew", "state", "runs", "run-001");
		fs.mkdirSync(ws1Runs, { recursive: true });
		fs.writeFileSync(
			path.join(ws1Runs, "manifest.json"),
			JSON.stringify({
				runId: "run-001",
				status: "running",
			}),
		);

		// Create another workspace with multiple runs
		const ws2 = path.join(isolatedTmp, "pi-crew-test-workspace-2");
		fs.mkdirSync(path.join(ws2, ".crew", "state", "runs", "run-002"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(
				ws2,
				".crew",
				"state",
				"runs",
				"run-002",
				"manifest.json",
			),
			JSON.stringify({
				runId: "run-002",
				status: "completed",
			}),
		);
		fs.mkdirSync(path.join(ws2, ".crew", "state", "runs", "run-003"), {
			recursive: true,
		});
		fs.writeFileSync(
			path.join(
				ws2,
				".crew",
				"state",
				"runs",
				"run-003",
				"manifest.json",
			),
			JSON.stringify({
				runId: "run-003",
				status: "failed",
			}),
		);

		// Create a dir that does NOT have a manifest (should not be counted as zombie)
		const ws3 = path.join(isolatedTmp, "pi-crew-test-workspace-3");
		fs.mkdirSync(path.join(ws3, ".crew", "state", "runs"), {
			recursive: true,
		});

		// Create a dir without .crew at all (should not be counted)
		const ws4 = path.join(isolatedTmp, "pi-crew-test-workspace-4");
		fs.mkdirSync(ws4, { recursive: true });

		const zombies = scanZombieTempWorkspaces(isolatedTmp, Date.now());

		assert.equal(zombies.length, 2, "should find 2 zombie workspaces");
		// ws1 has 1 run, ws2 has 2 runs
		const ws1Zombie = zombies.find((z) => z.dir === ws1);
		const ws2Zombie = zombies.find((z) => z.dir === ws2);
		assert.ok(ws1Zombie, "ws1 should be a zombie");
		assert.ok(ws2Zombie, "ws2 should be a zombie");
		assert.equal(ws1Zombie!.runCount, 1);
		assert.equal(ws2Zombie!.runCount, 2);
	} finally {
		fs.rmSync(isolatedTmp, { recursive: true, force: true });
	}
});

test("should not count non-pi-crew dirs as zombie workspaces", () => {
	const isolatedTmp = createIsolatedTmpDir();

	try {
		// Create a non-pi-crew dir with .crew
		const otherDir = path.join(isolatedTmp, "other-project");
		fs.mkdirSync(path.join(otherDir, ".crew", "state", "runs"), {
			recursive: true,
		});

		const zombies = scanZombieTempWorkspaces(isolatedTmp, Date.now());
		assert.equal(
			zombies.length,
			0,
			"non-pi-crew dirs should not be zombies",
		);
	} finally {
		fs.rmSync(isolatedTmp, { recursive: true, force: true });
	}
});

// ── 12. Compact TUI summary format ─────────────────────────────────

test("should include compact TUI summary line", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "summary test",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);
			updateRunStatus(running, "completed", "done");

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { text } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			// Verify compact summary format
			assert.match(
				text,
				/Summary: total=1 running=0 completed=1 failed=0 cancelled=0 blocked=0 \| stuck=0 zombie=0/,
			);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

test("should include structured data in result details", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			const created = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "data test",
			});
			const running = updateRunStatus(
				created.manifest,
				"running",
				"started",
			);
			updateRunStatus(running, "completed", "done");

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			assert.ok(counts, "should have counts");
			assert.equal(counts.total, 1);
			assert.equal(counts.completed, 1);
			assert.equal(counts.running, 0);
			assert.equal(counts.failed, 0);
			assert.equal(counts.cancelled, 0);
			assert.equal(counts.blocked, 0);
			assert.equal(counts.stuck, 0);
			assert.equal(counts.zombie, 0);

			// Also test that handleHealthMonitor puts data into details
			const toolResult = handleHealthMonitor({ cwd: projectCwd }, {});
			assert.ok(
				toolResult.details.data,
				"details should have a data object",
			);
			assert.equal(
				typeof (toolResult.details.data as Record<string, unknown>)
					.total,
				"number",
			);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});

// ── 13. Status counts unit test ─────────────────────────────────────

test("countStatuses should count all known statuses", () => {
	const runs = [
		{ status: "running" },
		{ status: "running" },
		{ status: "completed" },
		{ status: "failed" },
		{ status: "cancelled" },
		{ status: "blocked" },
		{ status: "queued" },
		{ status: "planning" },
		{ status: "waiting" },
		{ status: "completed" },
	];
	const counts = countStatuses(runs);

	assert.equal(counts.total, 10);
	assert.equal(counts.running, 2);
	assert.equal(counts.completed, 2);
	assert.equal(counts.failed, 1);
	assert.equal(counts.cancelled, 1);
	assert.equal(counts.blocked, 1);
	assert.equal(counts.queued, 1);
	assert.equal(counts.planning, 1);
	assert.equal(counts.waiting, 1);
});

test("countStatuses should handle empty runs", () => {
	const counts = countStatuses([]);
	assert.equal(counts.total, 0);
	assert.equal(counts.running, 0);
	assert.equal(counts.completed, 0);
});

// ── 14. Multi-workspace scan ────────────────────────────────────────

test("should merge temp workspace runs with primary runs", () => {
	withIsolatedHome(() => {
		const isolatedTmp = createIsolatedTmpDir();
		const projectCwd = createProjectCwd(isolatedTmp);

		try {
			// Primary run in project cwd
			const r1 = createRunManifest({
				cwd: projectCwd,
				team,
				workflow,
				goal: "primary run",
			});
			const r1r = updateRunStatus(r1.manifest, "running", "started");
			updateRunStatus(r1r, "completed", "primary done");

			// Create a temp workspace run OUTSIDE the project cwd (simulating a live-session workspace)
			const tempWs = path.join(isolatedTmp, "pi-crew-test-ws");
			const tempStateRoot = path.join(
				tempWs,
				".crew",
				"state",
				"runs",
				"temp-run-001",
			);
			fs.mkdirSync(tempStateRoot, { recursive: true });
			const tempArtifactsRoot = path.join(
				tempWs,
				".crew",
				"artifacts",
				"temp-run-001",
			);
			fs.mkdirSync(tempArtifactsRoot, { recursive: true });

			const tempManifest = {
				schemaVersion: 1,
				runId: "temp-run-001",
				team: "health-test",
				goal: "temp run",
				status: "running",
				workspaceMode: "single",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				cwd: tempWs,
				stateRoot: tempStateRoot,
				artifactsRoot: tempArtifactsRoot,
				tasksPath: path.join(tempStateRoot, "tasks.json"),
				eventsPath: path.join(tempStateRoot, "events.jsonl"),
				artifacts: [],
			};
			fs.writeFileSync(
				path.join(tempStateRoot, "manifest.json"),
				JSON.stringify(tempManifest),
			);
			fs.writeFileSync(
				path.join(tempStateRoot, "tasks.json"),
				JSON.stringify([]),
			);

			clearProjectRootCache();
			sharedScanCache.clear();
			__test__clearManifestCache();

			const { counts } = buildHealthReport(
				{ cwd: projectCwd },
				{},
				{ tmpDir: isolatedTmp },
			);

			// 1 primary + 1 temp = 2
			assert.equal(counts.total, 2);
			assert.equal(counts.completed, 1);
			assert.equal(counts.running, 1);
		} finally {
			fs.rmSync(projectCwd, { recursive: true, force: true });
			fs.rmSync(isolatedTmp, { recursive: true, force: true });
		}
	});
});
