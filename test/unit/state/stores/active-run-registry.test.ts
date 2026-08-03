import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { activeRunRoots, readActiveRunRegistry, registerActiveRun, unregisterActiveRun } from "../../../../src/state/stores/active-run-registry.ts";
import { createRunManifest, updateRunStatus } from "../../../../src/state/stores/state-store.ts";
import type { TeamConfig } from "../../../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../../../src/workflows/workflow-config.ts";

// Use realpath to resolve symlinks (macOS /var/folders → /private/var/folders).
// Several pi-crew code paths refuse to write through untrusted symlink paths.
const realTmp = fs.realpathSync(os.tmpdir());

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
	const home = fs.mkdtempSync(path.join(realTmp, "pi-crew-active-reg-home-"));
	// Create .pi/agent directory structure that userPiRoot() requires
	// (userPiRoot validates the path exists and is owned by current user)
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

test("active-run registry starts empty", () => {
	withIsolatedHome(() => {
		assert.deepEqual(readActiveRunRegistry(), []);
		assert.deepEqual(activeRunRoots(), []);
	});
});

test("register and unregister active run", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-active-reg-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "test active run",
			});
			registerActiveRun(created.manifest);
			const entries = readActiveRunRegistry();
			assert.equal(entries.length, 1);
			assert.equal(entries[0]!.runId, created.manifest.runId);
			assert.equal(entries[0]!.cwd, cwd);
			assert.equal(activeRunRoots().length, 1);
			unregisterActiveRun(created.manifest.runId);
			assert.equal(readActiveRunRegistry().length, 0);
			assert.equal(activeRunRoots().length, 0);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("register deduplicates by runId", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-active-dedup-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "dedup test",
			});
			registerActiveRun(created.manifest);
			registerActiveRun(created.manifest);
			assert.equal(readActiveRunRegistry().length, 1);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("registry ignores invalid entries", () => {
	withIsolatedHome(() => {
		const registryFile = path.join(process.env.PI_TEAMS_HOME!, ".crew", "state", "runs", "active-run-index.json");
		fs.mkdirSync(path.dirname(registryFile), { recursive: true });
		// Write garbage entries mixed with valid
		fs.writeFileSync(
			registryFile,
			JSON.stringify([
				{
					runId: "../escape",
					cwd: "/tmp",
					stateRoot: "/tmp/x",
					manifestPath: "/tmp/m",
					updatedAt: "2026-01-01",
				},
				"not-an-object",
				{ runId: "no-cwd", stateRoot: "/x" },
			]),
		);
		assert.equal(readActiveRunRegistry().length, 0);
	});
});

test("activeRunRoots skips entries with missing stateRoot", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-active-missing-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "missing roots",
			});
			registerActiveRun(created.manifest);
			assert.equal(activeRunRoots().length, 1);
			// Remove the state root to simulate cleanup
			fs.rmSync(created.manifest.stateRoot, {
				recursive: true,
				force: true,
			});
			assert.equal(activeRunRoots().length, 0);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("blocked runs remain visible in active-run registry roots", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-active-blocked-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "blocked is terminal",
			});
			registerActiveRun(created.manifest);
			assert.equal(activeRunRoots().length, 1);
			const running = updateRunStatus(created.manifest, "running", "started");
			updateRunStatus(running, "blocked", "blocked terminal state");
			assert.equal(activeRunRoots().length, 1);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("register recovers stale active-run registry lock", () => {
	withIsolatedHome(() => {
		const cwd = fs.mkdtempSync(path.join(realTmp, "pi-crew-active-stale-lock-"));
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		try {
			const registryFile = path.join(
				process.env.PI_TEAMS_HOME!,
				".pi",
				"agent",
				"extensions",
				"pi-crew",
				"state",
				"runs",
				"active-run-index.json",
			);
			const lockFile = `${registryFile}.lock`;
			fs.mkdirSync(path.dirname(lockFile), { recursive: true });
			fs.writeFileSync(
				lockFile,
				JSON.stringify({
					pid: 0,
					createdAt: "2000-01-01T00:00:00.000Z",
				}),
			);
			const created = createRunManifest({
				cwd,
				team,
				workflow,
				goal: "stale lock",
			});
			registerActiveRun(created.manifest);
			assert.equal(readActiveRunRegistry().length, 1);
			assert.equal(fs.existsSync(lockFile), false);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("unregister with invalid runId is a no-op", () => {
	withIsolatedHome(() => {
		unregisterActiveRun("../escape");
		assert.equal(readActiveRunRegistry().length, 0);
	});
});
