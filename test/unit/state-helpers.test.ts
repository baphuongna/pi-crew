/**
 * state-helpers.test.ts — Tests for persistSingleTaskUpdate (FIX-01b, FIX-05).
 *
 * FIX-01b: CAS convergence failure and write-error logInternalError calls
 *           upgraded to severity="error".
 * FIX-05:  CAS retry loop runs 100 iterations but error messages said "50".
 *           Fixed to use a MAX_CAS_ATTEMPTS constant (=100) in the loop bound
 *           and both error messages.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { persistSingleTaskUpdate } from "../../src/runtime/task-runner/state-helpers.ts";
import { flushPendingAtomicWrites } from "../../src/state/atomic-write.ts";
import { __test__clearManifestCache, createRunManifest, loadRunManifestById } from "../../src/state/state-store.ts";
import type { TeamTaskState } from "../../src/state/types.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

/** Create a temp dir with .git marker so useProjectState(dir) keeps state inside <dir>/.crew/. */
function makeTempDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

function withIsolatedHome<T>(fn: () => T): T {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = makeTempDir("pi-crew-state-helpers-home-");
	process.env.PI_TEAMS_HOME = home;
	try {
		return fn();
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
}

test("persistSingleTaskUpdate: happy path — updates task status and persists to disk", () => {
	withIsolatedHome(() => {
		const cwd = makeTempDir("pi-crew-state-helpers-happy-");
		try {
			const created = createRunManifest({ cwd, team, workflow, goal: "test happy path" });
			const originalTask = created.tasks[0];
			assert.ok(originalTask, "expected at least one task from createRunManifest");

			const updatedTask: TeamTaskState = {
				...originalTask,
				status: "completed",
				finishedAt: new Date().toISOString(),
			};

			const result = persistSingleTaskUpdate(created.manifest, created.tasks, updatedTask);
			flushPendingAtomicWrites();

			// Return value should reflect the update
			assert.equal(result.length, created.tasks.length);
			const returned = result.find((t) => t.id === originalTask.id);
			assert.ok(returned, "updated task should be in result");
			assert.equal(returned.status, "completed");

			// Verify it actually landed on disk. Retry briefly on Windows
			// (CI) where the file system can take a few ms to surface a
			// newly-written manifest. Linux/macOS resolve on the first read.
			__test__clearManifestCache();
			let reloaded: ReturnType<typeof loadRunManifestById>;
			for (let attempt = 0; attempt < 10; attempt++) {
				reloaded = loadRunManifestById(cwd, created.manifest.runId);
				if (reloaded) break;
				const end = Date.now() + 25;
				while (Date.now() < end) {
					/* brief spin for Windows AV-scan window */
				}
			}
			assert.ok(reloaded, "manifest should reload");
			const diskTask = reloaded!.tasks.find((t) => t.id === originalTask.id);
			assert.ok(diskTask, "task should exist on disk");
			assert.equal(diskTask!.status, "completed");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});

test("FIX-05: convergence error message references 100 attempts, not 50", () => {
	const sourcePath = fileURLToPath(new URL("../../src/runtime/task-runner/state-helpers.ts", import.meta.url));
	const source = fs.readFileSync(sourcePath, "utf-8");

	// The old buggy messages said "50 attempts" — they must be gone.
	assert.ok(!source.includes("50 attempts"), "source must not contain the stale '50 attempts' error message");

	// The fix extracts a MAX_CAS_ATTEMPTS constant and uses it in the loop
	// bound and both error messages (logInternalError + thrown Error).
	assert.ok(source.includes("MAX_CAS_ATTEMPTS"), "source should define and use MAX_CAS_ATTEMPTS constant");

	// The loop bound should use the constant, not a bare literal.
	assert.ok(source.includes("attempt < MAX_CAS_ATTEMPTS"), "loop bound should reference MAX_CAS_ATTEMPTS");
});

test("FIX-01b: persistSingleTaskUpdate logInternalError calls upgraded to severity='error'", () => {
	const sourcePath = fileURLToPath(new URL("../../src/runtime/task-runner/state-helpers.ts", import.meta.url));
	const source = fs.readFileSync(sourcePath, "utf-8");

	// The convergence-failure logInternalError should pass severity="error".
	// This call uses the template literal with MAX_CAS_ATTEMPTS.
	const convergeCall = source.match(/logInternalError\([\s\S]*?"persistSingleTaskUpdate"[\s\S]*?"error"/);
	assert.ok(convergeCall, "convergence-failure logInternalError should include severity='error'");

	// Both catch-block logInternalError calls (write failure + outer catch)
	// should also pass severity="error".
	const errorSeverityCount = (source.match(/undefined,\s*"error"/g) ?? []).length;
	assert.ok(
		errorSeverityCount >= 3,
		`expected at least 3 logInternalError calls with severity='error' in persistSingleTaskUpdate, found ${errorSeverityCount}`,
	);
});
