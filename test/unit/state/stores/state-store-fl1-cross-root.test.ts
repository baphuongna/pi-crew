import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { projectCrewRoot, userCrewRoot } from "../../../../src/utils/paths.ts";

/**
 * F-L1 (2026-09-22): run listing (run-index scopedRunRoots) UNIONS the user
 * and project run roots, but resolveRunStateRoot resolved by ID against
 * scopeBaseRoot's single XOR pick. A run living under the OTHER root listed
 * fine yet every by-ID lookup (team status / prune / forget / scheduler
 * provenance via loadRunManifestById) returned "not found". Resolution must
 * try the primary root first, then fall back — seeing exactly what listing
 * sees.
 *
 * Env isolation (pattern: manifest-cache-list-active.test.ts): userCrewRoot
 * honors PI_CREW_HOME; PI_TEAMS_HOME has precedence and must be deleted.
 */

const envBackup = new Map<string, string | undefined>();
test.beforeEach(() => {
	envBackup.clear();
	for (const key of Object.keys(process.env)) envBackup.set(key, process.env[key]);
	delete process.env.PI_TEAMS_HOME;
	process.env.PI_CREW_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fl1-home-"));
});
test.afterEach(() => {
	for (const key of Object.keys(process.env)) {
		if (!envBackup.has(key)) delete process.env[key];
	}
	for (const [key, value] of envBackup) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function writeRunFixture(runsRoot: string, runId: string): { stateRoot: string } {
	const stateRoot = path.join(runsRoot, runId);
	// createRunPaths puts artifacts under the SAME base root as state.
	const baseRoot = path.resolve(stateRoot, "..", "..", "..");
	fs.mkdirSync(stateRoot, { recursive: true });
	const manifest = {
		runId,
		schemaVersion: 1,
		status: "completed",
		stateRoot,
		tasksPath: path.join(stateRoot, "tasks.json"),
		eventsPath: path.join(stateRoot, "events.jsonl"),
		artifactsRoot: path.join(baseRoot, "artifacts", runId),
		team: { name: "fl1", source: "builtin" },
		workflow: { name: "fl1", source: "builtin" },
		goal: "fl1 probe",
		createdAt: new Date().toISOString(),
	};
	fs.writeFileSync(path.join(stateRoot, "manifest.json"), JSON.stringify(manifest));
	fs.writeFileSync(path.join(stateRoot, "tasks.json"), "[]");
	fs.writeFileSync(path.join(stateRoot, "events.jsonl"), "");
	return { stateRoot };
}

function makeProjectCwd(): string {
	// .crew marker → findRepoRoot hits → useProjectState true → primary root
	// is projectCrewRoot(cwd) = <cwd>/.crew.
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-fl1-proj-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	return cwd;
}

test("F-L1: run under USER root resolves by ID from a project cwd (listed ⇒ findable)", () => {
	const cwd = makeProjectCwd();
	const runId = "team_20260922_fl1user0123456789";
	const { stateRoot } = writeRunFixture(path.join(userCrewRoot(), "state", "runs"), runId);
	try {
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded, "run listed by scopedRunRoots must resolve by ID (was: not found)");
		assert.equal(loaded.manifest.runId, runId);
		assert.equal(loaded.manifest.stateRoot, stateRoot);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(path.dirname(path.dirname(path.dirname(stateRoot))), { recursive: true, force: true });
	}
});

test("F-L1: run under PROJECT root still resolves first (primary path unchanged)", () => {
	const cwd = makeProjectCwd();
	const runId = "team_20260922_fl1proj0123456789";
	writeRunFixture(path.join(projectCrewRoot(cwd), "state", "runs"), runId);
	try {
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded, "primary-root run must keep resolving");
		assert.equal(loaded.manifest.runId, runId);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("F-L1: same runId under BOTH roots — primary (project) wins, no ambiguity", () => {
	const cwd = makeProjectCwd();
	const runId = "team_20260922_fl1both0123456789";
	const projRoot = path.join(projectCrewRoot(cwd), "state", "runs");
	writeRunFixture(projRoot, runId);
	writeRunFixture(path.join(userCrewRoot(), "state", "runs"), runId);
	try {
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded, "duplicate-id run must resolve");
		assert.equal(loaded.manifest.stateRoot, path.join(projRoot, runId), "primary root must take precedence");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(path.join(userCrewRoot(), "state", "runs"), { recursive: true, force: true });
	}
});

test("F-L1: unknown runId resolves to undefined (fallback miss is a real miss)", () => {
	const cwd = makeProjectCwd();
	fs.mkdirSync(path.join(userCrewRoot(), "state", "runs"), { recursive: true });
	try {
		assert.equal(loadRunManifestById(cwd, "team_20260922_fl1none012345678"), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(path.join(userCrewRoot(), "state", "runs"), { recursive: true, force: true });
	}
});
