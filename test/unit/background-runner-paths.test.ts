/**
 * Issue #55 regression test: the background runner's diagnostic paths
 * (background.log + exit-code.txt) must resolve through the SAME scope-aware
 * chain (createRunPaths → scopeBaseRoot) as run creation and loadRunManifestById.
 *
 * They previously joined projectCrewRoot(cwd) — i.e. <cwd>/.crew/state/runs —
 * which never exists for a run created in a markerless (non-git) cwd routed to
 * USER scope (~/.pi/agent/extensions/pi-crew/). Both writes are best-effort
 * (try/catch swallowed), so the files silently went missing for user-scope
 * runs — degrading exactly the crash evidence needed to diagnose them (#54's
 * open "run failed" toast question).
 *
 * Importing background-runner.ts without --cwd/--run-id auto-runs main(),
 * which throws "Usage: ..." into the module-level catch and sets exitCode=1 —
 * same as background-runner-signal-event-type.test.ts; reset it (line below).
 */
process.exitCode = 0;

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { backgroundExitCodePath, backgroundLogPath } from "../../src/runtime/background-runner.ts";
import { findRepoRoot, userCrewRoot } from "../../src/utils/paths.ts";

test("background diagnostic paths honour USER scope for markerless cwds (issue #55)", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "bg-runner-user-home-"));
	process.env.PI_TEAMS_HOME = home;
	try {
		// Markerless cwd under tmpdir — computeRepoRoot stops at the tmpdir
		// boundary (bug-029), so findRepoRoot is undefined → user scope.
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bg-runner-"));
		assert.equal(findRepoRoot(cwd), undefined, "fixture must be markerless");

		const runId = "bg_paths_user_scope";
		const stateRoot = path.join(userCrewRoot(), "state", "runs", runId);
		assert.equal(backgroundLogPath(cwd, runId), path.join(stateRoot, "background.log"));
		assert.equal(backgroundExitCodePath(cwd, runId), path.join(stateRoot, "exit-code.txt"));
	} finally {
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

test("background diagnostic paths keep PROJECT scope (.crew) for git cwds (issue #29 parity)", () => {
	const proj = fs.mkdtempSync(path.join(os.tmpdir(), "bg-runner-proj-"));
	fs.mkdirSync(path.join(proj, ".git"), { recursive: true });
	try {
		const repoRoot = findRepoRoot(proj);
		assert.ok(repoRoot, "fixture with .git must resolve a repo root");

		// macOS CI: tmpdir is /var/folders/… but projectCrewRoot canonicalizes
		// through realpath (/private/var/…, bug-029 parity) — build the expected
		// path from the realpathed fixture or the comparison fails on darwin.
		const projReal = fs.realpathSync.native(proj);
		const runId = "bg_paths_project_scope";
		const stateRoot = path.join(projReal, ".crew", "state", "runs", runId);
		assert.equal(backgroundLogPath(proj, runId), path.join(stateRoot, "background.log"));
		assert.equal(backgroundExitCodePath(proj, runId), path.join(stateRoot, "exit-code.txt"));
	} finally {
		fs.rmSync(proj, { recursive: true, force: true });
	}
});

test("background diagnostic paths keep the R11-2 runId boundary hardening", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "bg-runner-hardening-"));
	try {
		// createRunPaths → assertSafePathId must reject traversal ids before any
		// path is built (R11-2). The helpers inherit that fail-fast contract.
		assert.throws(() => backgroundLogPath(cwd, "../escape"));
		assert.throws(() => backgroundExitCodePath(cwd, "a/b"));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
