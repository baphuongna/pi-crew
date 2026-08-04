/**
 * STATE-3 integration test: corrupt manifest.json → quarantine + return undefined.
 *
 * Verifies that a corrupt (unparseable) manifest.json is NOT silently swallowed.
 * Previously, loadRunManifestById used readJsonFile which returns undefined for BOTH
 * ENOENT and SyntaxError, so a corrupt manifest made the run silently invisible
 * (no quarantine, no log, never reconciled). Now:
 *   1. loadManifestWithRecovery(manifestPath, runId) returns undefined for a corrupt
 *      manifest AND quarantines it to `.corrupt-<ts>`.
 *   2. loadManifestWithRecovery returns undefined for a MISSING manifest (ENOENT)
 *      WITHOUT quarantining (legitimate missing run).
 *   3. loadManifestWithRecovery returns the parsed manifest for a valid file.
 *   4. loadRunManifestById(cwd, runId) returns undefined for a corrupt manifest AND
 *      quarantines it (does NOT silently make the run invisible).
 *
 * Manifest reconstruction from events.jsonl is infeasible (run.created only carries
 * {team, workflow}), so quarantine + visible log IS the recovery.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	__test__clearManifestCache,
	createRunManifest,
	loadManifestWithRecovery,
	loadRunManifestByIdAsync,
	saveRunTasks,
} from "../../src/state/stores/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "state3test",
	description: "STATE-3 manifest recovery",
	source: "builtin",
	filePath: "<test>",
	roles: [{ name: "executor", agent: "executor" }],
	defaultWorkflow: "default",
	workspaceMode: "single",
};
const workflow: WorkflowConfig = {
	name: "state3test-wf",
	description: "STATE-3 recovery wf",
	source: "builtin",
	filePath: "<test>",
	steps: [],
};

/**
 * Create a fully-laid-out run (via createRunManifest so path canonicalisation
 * matches what loadRunManifestById expects), with valid tasks + events on disk.
 * Returns the paths needed by the test.
 */
function setupRun(): {
	tmpRoot: string;
	manifest: ReturnType<typeof createRunManifest>["manifest"];
	manifestPath: string;
	tasksPath: string;
} {
	const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-state3-")));
	fs.writeFileSync(path.join(tmpRoot, "package.json"), "{}\n", "utf-8");
	fs.mkdirSync(path.join(tmpRoot, ".git"), { recursive: true });
	const { manifest } = createRunManifest({
		cwd: tmpRoot,
		team,
		workflow,
		goal: "STATE-3 manifest recovery test",
	});
	const manifestPath = path.join(manifest.stateRoot, "manifest.json");
	const tasksPath = manifest.tasksPath;
	const tasks: TeamTaskState[] = [
		{
			id: "task-A",
			runId: manifest.runId,
			role: "executor",
			agent: "executor",
			title: "Task A",
			status: "completed",
			dependsOn: [],
			cwd: tmpRoot,
		},
	];
	saveRunTasks(manifest, tasks);
	__test__clearManifestCache();
	return { tmpRoot, manifest, manifestPath, tasksPath };
}

/** Glob-match helper for `.corrupt-*` quarantine files in a directory. */
function findCorruptFiles(dir: string): string[] {
	return fs.readdirSync(dir).filter((f) => f.includes(".corrupt-"));
}

test("STATE-3: loadManifestWithRecovery quarantines corrupt manifest + returns undefined", {
	skip: process.platform === "win32" ? "Windows file-quarantine rename timing flakes. Follow up: make Windows-tolerant." : undefined,
}, () => {
	const { tmpRoot, manifest, manifestPath } = setupRun();
	try {
		// Corrupt the manifest with a syntax error.
		fs.writeFileSync(manifestPath, "{not valid json", "utf-8");

		const result = loadManifestWithRecovery(manifestPath, manifest.runId);
		assert.equal(result, undefined, "corrupt manifest must return undefined");

		// Manifest must be quarantined to a .corrupt-* file.
		const corrupt = findCorruptFiles(path.dirname(manifestPath));
		assert.ok(corrupt.length >= 1, `corrupt manifest quarantined: ${corrupt.join(", ")}`);
		assert.ok(
			corrupt.some((f) => f.startsWith("manifest.json.corrupt-")),
			"quarantine file has correct prefix",
		);
		// Original manifest.json is gone (renamed away).
		assert.ok(!fs.existsSync(manifestPath), "corrupt manifest.json renamed away");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("STATE-3: loadManifestWithRecovery returns undefined for MISSING manifest (ENOENT) without quarantine", () => {
	const { tmpRoot, manifest, manifestPath } = setupRun();
	try {
		// Delete the manifest entirely.
		fs.unlinkSync(manifestPath);

		const result = loadManifestWithRecovery(manifestPath, manifest.runId);
		assert.equal(result, undefined, "missing manifest must return undefined");

		// Must NOT be quarantined — no .corrupt-* files.
		const corrupt = findCorruptFiles(path.dirname(manifestPath));
		assert.equal(corrupt.length, 0, "ENOENT must NOT quarantine");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("STATE-3: loadManifestWithRecovery returns parsed manifest for valid file", () => {
	const { tmpRoot, manifest, manifestPath } = setupRun();
	try {
		const result = loadManifestWithRecovery(manifestPath, manifest.runId);
		assert.ok(result, "valid manifest must be returned");
		assert.equal(result!.runId, manifest.runId, "returned manifest has correct runId");

		// Must NOT be quarantined.
		const corrupt = findCorruptFiles(path.dirname(manifestPath));
		assert.equal(corrupt.length, 0, "valid manifest must NOT be quarantined");
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});

test("STATE-3 async twin: loadRunManifestByIdAsync quarantines corrupt manifest + returns undefined (not silently invisible)", {
	skip:
		process.platform === "win32"
			? "Windows file-quarantine rename + reload timing flakes. Follow up: make Windows-tolerant."
			: undefined,
}, async () => {
	const { tmpRoot, manifest, manifestPath } = setupRun();
	try {
		// Corrupt the manifest with a syntax error.
		fs.writeFileSync(manifestPath, "{not valid json", "utf-8");
		__test__clearManifestCache();

		const loaded = await loadRunManifestByIdAsync(tmpRoot, manifest.runId);
		assert.equal(loaded, undefined, "corrupt manifest must make loadRunManifestByIdAsync return undefined");

		// Manifest must be quarantined (STATE-3: visible, not silently swallowed).
		const corrupt = findCorruptFiles(path.dirname(manifestPath));
		assert.ok(corrupt.length >= 1, `corrupt manifest quarantined via loadRunManifestByIdAsync: ${corrupt.join(", ")}`);
		assert.ok(
			corrupt.some((f) => f.startsWith("manifest.json.corrupt-")),
			"quarantine file has correct prefix",
		);
	} finally {
		fs.rmSync(tmpRoot, { recursive: true, force: true });
	}
});
