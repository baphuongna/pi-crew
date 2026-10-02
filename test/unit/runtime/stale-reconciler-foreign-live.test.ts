import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { reconcileStaleRun } from "../../../src/runtime/stale-reconciler.ts";
import { registerActiveRun } from "../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, saveRunManifest, saveRunTasks } from "../../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../../src/state/types.ts";
import type { TeamConfig } from "../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../src/workflows/workflow-config.ts";

/**
 * G24 (SDD-4 WI-2, pi-crew-upgrade-plan-2026-09-29.md §2): the stale
 * reconciler must SKIP foreign-LIVE runs — runs the active-run registry shows
 * as owned by a live session/runner — instead of repairing (cancelling) them
 * just because heartbeats look frozen. Until now liveness/ownership was only
 * checked as "run of the CURRENT session" (crash-recovery.ts ownerSessionId
 * filter); a child session scanning the parent's live run had no guard at all,
 * and the /tmp orphan scan had none either.
 *
 * Contract under test:
 * 1. Registry entry ALIVE (fresh, on-disk, non-terminal, run registered) →
 *    NO repair: repaired===false, verdict "healthy" (from this reconciler's
 *    perspective there is nothing to do — a live owner exists; this verdict is
 *    what keeps crash-recovery's notify and the orphan-temp cleanup passive),
 *    and an honest detail that says what did (skip) and did not (repair) happen.
 * 2. No registry entry → repair proceeds exactly as before (the guard must not
 *    over-block genuinely dead runs).
 *
 * Registry isolation: PI_TEAMS_HOME is redirected per test (withIsolatedHome,
 * same pattern as active-run-registry.test.ts) so registerActiveRun writes to a
 * throwaway registry instead of the real user one.
 */

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
// Several pi-crew code paths refuse to write through untrusted symlink paths.
const realTmp = fs.realpathSync(os.tmpdir());
const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

const team: TeamConfig = {
	name: "g24",
	description: "g24",
	source: "builtin",
	filePath: "g24.team.md",
	roles: [{ name: "executor", agent: "executor" }],
};
const workflow: WorkflowConfig = {
	name: "g24",
	description: "g24",
	source: "builtin",
	filePath: "g24.workflow.md",
	steps: [{ id: "do", role: "executor", task: "Do" }],
};

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-g24-home-"));
	// Create .pi/agent directory structure that userPiRoot() requires
	// (userPiRoot validates the path exists and is owned by current user).
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

/** A running task whose heartbeat froze 10 minutes ago with NO recorded pid —
 *  exactly the shape that trips the no_pid_heartbeat_stale repair (>5min)
 *  when unguarded. G25's silent-turn freeze (12m27s observed) makes this shape
 *  reachable for LIVE workers, which is why G24 needs a registry gate BEFORE
 *  the heartbeat-staleness phases. */
function frozenRunningTask(runId: string): TeamTaskState {
	return {
		id: "task-g24-1",
		runId,
		role: "executor",
		agent: "test-agent",
		title: "G24 foreign-LIVE probe",
		status: "running",
		dependsOn: [],
		cwd: "/tmp",
		heartbeat: { workerId: "w-g24", lastSeenAt: iso(NOW - 10 * 60_000) },
	};
}

describe("stale-reconciler: G24 foreign-LIVE skip (SDD-4 WI-2)", () => {
	it("foreign-LIVE run (alive registry entry) is NOT repaired even with frozen heartbeats", () => {
		withIsolatedHome(() => {
			const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-g24-live-"));
			fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
			try {
				const created = createRunManifest({ cwd, team, workflow, goal: "g24 foreign-live" });
				const manifest = { ...created.manifest, status: "running" as const };
				saveRunManifest(manifest);
				const tasks = [frozenRunningTask(manifest.runId)];
				saveRunTasks(manifest, tasks);
				// A live foreign session/runner owns this run right now — the
				// registry entry is fresh, the manifest on disk is running.
				registerActiveRun(manifest);

				const result = reconcileStaleRun(manifest, tasks, NOW);

				assert.equal(result.repaired, false, "foreign-LIVE run must NOT be repaired");
				assert.equal(result.repairedTasks, undefined, "no repaired tasks may be returned for a foreign-LIVE run");
				assert.equal(result.persistTasks, undefined, "nothing to persist for a foreign-LIVE run");
				// verdict "healthy": nothing for THIS reconciler to do — a live
				// owner exists. Keeps callers passive (no crash-recovery notify
				// push, orphan-temp workspace preserved via hasRunning).
				assert.equal(result.verdict, "healthy");
				// Honest detail: states the skip and its reason, and does not
				// claim any repair happened.
				assert.match(result.detail, /registry/i);
				assert.match(result.detail, /skip/i);
				assert.doesNotMatch(result.detail, /repaired/i);
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});
	});

	it("unregistered dead run with the same frozen-heartbeat shape is still repaired (guard does not over-block)", () => {
		withIsolatedHome(() => {
			const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-g24-dead-"));
			fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
			try {
				const created = createRunManifest({ cwd, team, workflow, goal: "g24 unregistered" });
				const manifest = { ...created.manifest, status: "running" as const };
				saveRunManifest(manifest);
				const tasks = [frozenRunningTask(manifest.runId)];
				saveRunTasks(manifest, tasks);
				// NOTE: no registerActiveRun — nobody claims this run, so the
				// registry consult finds nothing and normal repair must proceed.

				const result = reconcileStaleRun(manifest, tasks, NOW);

				assert.equal(result.repaired, true, "unregistered dead run must still be repaired");
				assert.equal(result.verdict, "no_status", "frozen heartbeats + no PID keep the no_status repair path");
				assert.ok(Array.isArray(result.repairedTasks), "repaired tasks are returned for persistence");
			} finally {
				fs.rmSync(cwd, { recursive: true, force: true });
			}
		});
	});
});
