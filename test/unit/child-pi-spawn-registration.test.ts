/**
 * RT-11: Static verification that every spawn site in child-pi.ts registers
 * the child process with registerChildProcess for host-SIGTERM cleanup.
 *
 * The child-pi.ts spawn path is the SOLE place child processes are created.
 * Previously, registration was guarded by `if (input.runId && input.agentId)`,
 * so callers that omitted runId/agentId (e.g. run-coalesced-task-group,
 * dynamic-workflow-context) spawned children that were invisible to cleanup
 * — they'd survive as orphans when the parent pi process was killed.
 *
 * This test reads the source file (static analysis) because the real spawn
 * path requires the external `pi` binary and is not reachable via mock mode
 * (PI_TEAMS_MOCK_CHILD_PI returns before the spawn() call).
 *
 * Mutation check: if the `if (input.runId && input.agentId)` guard is
 * reintroduced, the "no guard" assertion fails. If the registerChildProcess
 * call is removed entirely, the "registration exists" assertion fails.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const childPiSrc = fs.readFileSync(
	path.join(import.meta.dirname, "..", "..", "src", "runtime", "child-pi.ts"),
	"utf-8",
);

test("RT-11: every spawn() call site is followed by registerChildProcess", () => {
	// Count real spawn() calls (the Node child_process spawn, not helper
	// references like buildFinalChildPiSpawnOptions or import statements).
	const spawnCallPattern = /(^|\s)spawn\s*\(/gm;
	const spawnMatches = childPiSrc.match(spawnCallPattern);
	assert.ok(spawnMatches && spawnMatches.length >= 1, "expected at least one spawn() call in child-pi.ts");

	// registerChildProcess must be called at least once per spawn site.
	const regMatches = childPiSrc.match(/registerChildProcess\s*\(/g);
	assert.ok(regMatches && regMatches.length >= spawnMatches.length,
		`expected ≥${spawnMatches.length} registerChildProcess() calls (one per spawn site), found ${regMatches?.length ?? 0}`);
});

test("RT-11: registerChildProcess is NOT guarded by runId/agentId condition", () => {
	// The old guard `if (input.runId && input.agentId)` allowed callers to
	// spawn children that are invisible to cleanup. After RT-11, registration
	// must be unconditional (with synthetic fallback IDs for untracked runs).
	const hasRunIdAgentGuard = /if\s*\(\s*input\.runId\s*&&\s*input\.agentId\s*\)/.test(childPiSrc);
	assert.equal(hasRunIdAgentGuard, false,
		"registerChildProcess must NOT be guarded by input.runId && input.agentId — "
		+ "every spawned child must be registered for host-SIGTERM cleanup (RT-11)");
});

test("RT-11: registerChildProcess provides fallback IDs when runId/agentId are absent", () => {
	// The registration must handle the case where the caller didn't pass
	// runId/agentId by using synthetic fallback values, so the PID is still
	// tracked for cleanup.
	assert.match(
		childPiSrc,
		/registerChildProcess\s*\(\s*\w+\.pid\s*,\s*\w+\.runId\s*\?\?\s*[^,]+,\s*\w+\.agentId\s*\?\?\s*[^)]+\)/,
		"registerChildProcess must use ?? fallback for runId and agentId so untracked spawns are still registered",
	);
});
