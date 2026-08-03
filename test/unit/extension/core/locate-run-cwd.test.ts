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
function mkNonProjectDir(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

test("returns undefined when run is in sibling directory", () => {
	const base = mkProjectDir("pi-crew-locate-sibling-");
	// Create sibling as a non-project dir so its state is written to
	// userCrewRoot() — outside the base tree — and locateRunCwd(base) can't
	// reach it via the child-directory scan.
	const sibling = mkNonProjectDir("pi-crew-sibling-nonproj-");
	fs.renameSync(sibling, path.join(base, "sibling"));
	try {
		const { manifest } = createRunManifest({
			cwd: sibling,
			team,
			workflow,
			goal: "sibling",
		});
		// sibling's state is at userCrewRoot, not under base, so it won't be found
		assert.equal(locateRunCwd(manifest.runId, base), undefined);
	} finally {
		fs.rmSync(base, { recursive: true, force: true });
	}
});
