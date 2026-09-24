import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { locateRunCwd } from "../../../../src/extension/team-tool.ts";
import { createRunManifest } from "../../../../src/state/stores/state-store.ts";

// Minimal team/workflow stubs needed by createRunManifest
const team = {
	name: "t",
	description: "",
	source: "builtin" as const,
	filePath: "t",
	roles: [],
};
const workflow = {
	name: "w",
	description: "",
	source: "builtin" as const,
	filePath: "w",
	steps: [{ id: "step1", role: "test", task: "test task" }],
};

/**
 * Create a real project structure with a .git marker so projectCrewRoot()
 * places the manifest inside the temp tree rather than in userCrewRoot().
 */
function mkProjectDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

/**
 * Create a directory that is NOT a project (no .git) so scopeBaseRoot()
 * routes state to userCrewRoot() rather than under the cwd tree.
 * Needed for tests where a sibling's state must NOT be reachable
 * from the base directory via locateRunCwd's child-directory scan.
 */
function mkNonProjectDir(prefix: string, base?: string): string {
	return fs.mkdtempSync(path.join(base ?? os.tmpdir(), prefix));
}

test("finds run in same CWD", () => {
	const cwd = mkProjectDir("pi-crew-locate-same-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const { manifest } = createRunManifest({
			cwd,
			team,
			workflow,
			goal: "same",
		});
		assert.equal(locateRunCwd(manifest.runId, cwd), cwd);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("finds run in child directory CWD", () => {
	const base = mkProjectDir("pi-crew-locate-child-");
	const child = path.join(base, "child");
	fs.mkdirSync(path.join(child, ".crew"), { recursive: true });
	try {
		const { manifest } = createRunManifest({
			cwd: child,
			team,
			workflow,
			goal: "child",
		});
		assert.equal(locateRunCwd(manifest.runId, base), child);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});

test("returns undefined for non-existent run", () => {
	const cwd = mkProjectDir("pi-crew-locate-none-");
	try {
		assert.equal(locateRunCwd("does_not_exist_abc123", cwd), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("returns undefined for a cwd unrelated to the run's project root", () => {
	// Isolation boundary that still holds: a run living under project A's root
	// is NOT discoverable from an unrelated cwd B (no ancestor relationship, no
	// user-root hit). The reverse case — a run in a CHILD project being found
	// from the parent — is intended and pinned by "finds run in child directory
	// CWD" above.
	const projectA = mkProjectDir("pi-crew-locate-projA-");
	const unrelated = mkProjectDir("pi-crew-locate-unrelated-");
	try {
		const { manifest } = createRunManifest({
			cwd: projectA,
			team,
			workflow,
			goal: "belongs to A",
		});
		assert.equal(
			manifest.stateRoot,
			// paths.ts canonicalizes the repo-root walk natively (win32 8.3 → long
			// name) — build the expectation from the same form or the lexical
			// mkdtemp path never matches on Windows CI.
			path.join(fs.realpathSync.native(projectA), ".crew", "state", "runs", manifest.runId),
			"precondition: the run lives under project A's own root",
		);
		assert.equal(locateRunCwd(manifest.runId, unrelated), undefined);
	} finally {
		fs.rmSync(projectA, { recursive: true, force: true });
		fs.rmSync(unrelated, { recursive: true, force: true });
	}
});

/**
 * F-L1 completion (2026-09-23): `list` (run-index scopedRunRoots) UNIONS the
 * user root and the project root, and `loadRunManifestById` resolves both —
 * but locateRunCwd only accepted the candidate cwd's PRIMARY root, so every
 * by-ID handler (status/events/summary/artifacts/worktrees/plans/respond/
 * cancel) answered "Run not found" for runs that `list` had just shown.
 *
 * Measured live in the real session: `action='list'` returned 10 user-root
 * runs and `action='status'` failed 10/10 of them.
 */
test("finds a run that lives under the USER root from a project cwd (list/status parity)", () => {
	const prevHome = process.env.PI_CREW_HOME;
	const prevTeams = process.env.PI_TEAMS_HOME;
	const prevOsHome = process.env.HOME;
	const prevUserProfile = process.env.USERPROFILE;
	const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-locate-userhome-"));
	const cwd = mkProjectDir("pi-crew-locate-userroot-");
	delete process.env.PI_TEAMS_HOME;
	process.env.PI_CREW_HOME = fakeHome;
	// Sandbox the PROCESS home too: on win32 os.homedir() reads USERPROFILE (not
	// HOME), so without this the marker walk's home boundary is the machine's real
	// home and the non-project cwd below can be claimed by the real ~/.pi marker.
	process.env.HOME = fakeHome;
	process.env.USERPROFILE = fakeHome;
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		// The run's own cwd is a NON-project dir → its state lands in userCrewRoot().
		// Keep it INSIDE the sandboxed home so the home boundary also stops the walk.
		const nonProject = mkNonProjectDir("pi-crew-locate-nonproj-", fakeHome);
		const { manifest } = createRunManifest({ cwd: nonProject, team, workflow, goal: "user-root run" });
		assert.equal(
			manifest.stateRoot,
			path.join(fakeHome, ".pi", "agent", "extensions", "pi-crew", "state", "runs", manifest.runId),
			"precondition: the run really lives under the user root",
		);
		// A project cwd must still resolve it (this is the regression).
		assert.equal(locateRunCwd(manifest.runId, cwd), cwd);
	} finally {
		if (prevHome === undefined) delete process.env.PI_CREW_HOME;
		else process.env.PI_CREW_HOME = prevHome;
		if (prevTeams === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = prevTeams;
		if (prevOsHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevOsHome;
		if (prevUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = prevUserProfile;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(fakeHome, { recursive: true, force: true });
	}
});
