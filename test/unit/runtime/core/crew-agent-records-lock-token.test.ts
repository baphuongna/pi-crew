import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { saveCrewAgents } from "../../../../src/runtime/crew-agent-records.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";
import type { TeamRunManifest } from "../../../../src/state/types.ts";

/**
 * Phase 3.1 (decision α) regression: the agents-record lock file now carries a
 * randomUUID `token` and release is token-guarded (mirrors locks.ts
 * `releaseLock`). These tests cover the externally observable contract:
 *   1. normal release removes the lock (stored token === our token);
 *   2. a stale NEW-format lock (with token) is still stolen and cleaned up;
 *   3. a stale LEGACY-format lock (no token, {pid, createdAt}) is still stolen
 *      — `removeStaleAgentsLock` is format-backward-compatible.
 */

function tempCwd(prefix: string): string {
	let cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	try {
		cwd = fs.realpathSync(cwd);
	} catch {
		/* keep as-is */
	}
	fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
	return cwd;
}

function makeManifest(cwd: string): TeamRunManifest {
	const team = {
		name: "lock-token",
		description: "",
		roles: [{ name: "explorer", agent: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const workflow = {
		name: "lock-token",
		description: "",
		steps: [{ id: "explore", role: "explorer" }],
		source: "test",
		filePath: "builtin",
	} as never;
	const { manifest } = createRunManifest({ cwd, team, workflow, goal: "lock-token" });
	return manifest;
}

/** A pid that is guaranteed dead (spawn a process and let it exit). */
function deadPid(): number {
	return spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
}

const records = [
	{
		id: "run:01",
		runId: "run",
		taskId: "explore",
		agent: "explorer",
		role: "explorer",
		runtime: "child-process" as const,
		status: "completed" as const,
		startedAt: new Date().toISOString(),
	},
];

test("crew-agent-records: token-guarded release removes the lock after saveCrewAgents", () => {
	const cwd = tempCwd("pi-crew-agents-lock-release-");
	try {
		const manifest = makeManifest(cwd);
		saveCrewAgents(manifest, records);
		const lockFile = path.join(manifest.stateRoot, "agents.json.lock");
		assert.equal(fs.existsSync(lockFile), false, "lock must be removed after release (token matched)");
		assert.ok(fs.existsSync(path.join(manifest.stateRoot, "agents.json")), "agents.json must exist");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("crew-agent-records: stale NEW-format lock (with token) is stolen and cleaned up", () => {
	const cwd = tempCwd("pi-crew-agents-lock-stale-new-");
	try {
		const manifest = makeManifest(cwd);
		const lockFile = path.join(manifest.stateRoot, "agents.json.lock");
		fs.mkdirSync(path.dirname(lockFile), { recursive: true });
		// Crashed NEW-format holder: token present, old createdAt, dead pid.
		fs.writeFileSync(
			lockFile,
			JSON.stringify({
				pid: deadPid(),
				createdAt: new Date(Date.now() - 60_000).toISOString(),
				token: "dead-holder-token",
			}),
		);
		saveCrewAgents(manifest, records);
		assert.equal(fs.existsSync(lockFile), false, "stale token-bearing lock must be stolen and removed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("crew-agent-records: stale LEGACY-format lock (no token) is still stolen (backward compat)", () => {
	const cwd = tempCwd("pi-crew-agents-lock-stale-legacy-");
	try {
		const manifest = makeManifest(cwd);
		const lockFile = path.join(manifest.stateRoot, "agents.json.lock");
		fs.mkdirSync(path.dirname(lockFile), { recursive: true });
		// Pre-3.1 format: {pid, createdAt}, no token. removeStaleAgentsLock must
		// still recognize it as stale and steal it.
		fs.writeFileSync(
			lockFile,
			JSON.stringify({
				pid: deadPid(),
				createdAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		);
		saveCrewAgents(manifest, records);
		assert.equal(fs.existsSync(lockFile), false, "stale legacy lock must be stolen and removed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
