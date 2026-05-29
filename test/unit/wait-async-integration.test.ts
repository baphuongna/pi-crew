/**
 * wait-async-integration.test.ts
 *
 * Verifies that `team action='wait'` works correctly when a run is executed
 * via the child-process runtime (mocked). This exercises a different code path
 * than wait-action.test.ts which uses the live-session mock.
 *
 * Runtime resolution: PI_TEAMS_MOCK_CHILD_PI forces auto mode → child-process.
 * Task execution: child-pi mock returns immediate success.
 * Wait: waitForRun() fast-path finds the already-completed manifest on disk.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import {
	createTrackedTempDir,
	removeTrackedTempDir,
} from "../fixtures/test-tempdir.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("wait returns completed for child-process mock run", async () => {
	const prevMockLive = process.env.PI_CREW_MOCK_LIVE_SESSION;
	const prevDepth = process.env.PI_CREW_DEPTH;
	const prevMockChild = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const prevAllowMock = process.env.PI_CREW_ALLOW_MOCK;

	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	process.env.PI_CREW_DEPTH = "0";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";

	const cwd = createTrackedTempDir("pi-crew-wait-async-");
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });

		// Start a run — runtime resolver picks child-process because PI_TEAMS_MOCK_CHILD_PI is set.
		const run = await handleTeamTool(
			{
				action: "run",
				team: "fast-fix",
				goal: "wait async integration test",
			},
			{ cwd },
		);
		assert.equal(run.isError, false, `run should succeed: ${firstText(run)}`);
		const runId = run.details.runId!;

		// Wait should find the already-completed manifest on disk.
		const waitResult = await handleTeamTool(
			{ action: "wait", runId, config: { timeoutMs: 5000 } },
			{ cwd },
		);
		assert.equal(waitResult.isError, false, `wait should succeed: ${firstText(waitResult)}`);
		assert.match(firstText(waitResult), /finished: completed/);
	} finally {
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", prevMockLive);
		restoreEnv("PI_CREW_DEPTH", prevDepth);
		restoreEnv("PI_CREW_ALLOW_MOCK", prevAllowMock);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", prevMockChild);
		removeTrackedTempDir(cwd);
	}
});
