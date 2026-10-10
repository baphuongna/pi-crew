/**
 * RELIABILITY regression test — bug #2 (2026-10-10, wave-2 chain incident,
 * run team_20261010045718_08e70e2013932886): the foreground run deadline is a
 * WATCH bound, not a cancel.
 *
 * Observed before the fix: a chain step (handleRun async:false → foreground
 * lane) hit the 60-minute DEFAULT_RUN_DEADLINE; the armed deadline timer
 * aborted executeTeamRun's signal, CANCELLING the still-healthy child run,
 * while waitForRun's own timeout made the step report "partial". The chain
 * report said "Step 1 partial (3600171ms)" AND the child run's manifest read
 * cancelled at exactly the same moment.
 *
 * After the fix (watch-only timer in run.ts's foreground lane +
 * isWaitForRunTimeoutError partial-watch result): a watch expiry returns a
 * partial-watch (NOT an error), the run keeps executing in the foreground
 * lane, and a deferred runner that starts AFTER the watch window completes
 * normally instead of starting against an already-aborted signal.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { clearRunPromisesForTest } from "../../../../src/runtime/run-tracker.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

test("foreground run: watch-window expiry reports partial-watch and does NOT cancel the run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-partial-watch-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousAllowMock = process.env.PI_CREW_ALLOW_MOCK;
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	let runnerInvoked = false;
	try {
		const toolResult = await handleTeamTool(
			// timeoutMs is read defensively by resolveRunDeadline (params > config >
			// 1h default) — a short watch window drives the test.
			{ action: "run", team: "fast-fix", goal: "partial-watch regression", timeoutMs: 600 } as never,
			{
				cwd,
				startForegroundRun: (runner) => {
					// Defer the actual execution past the 600ms watch window: with the
					// OLD armed deadline timer, the runner would start against an
					// ALREADY-ABORTED signal and the run would be cancelled. With the
					// watch-only deadline it must complete normally.
					setTimeout(() => {
						runnerInvoked = true;
						runner()
							?.then(() => undefined)
							.catch(() => undefined);
					}, 900);
				},
			},
		);

		assert.equal(toolResult.isError, false, "a watch expiry is not a tool error");
		const text = firstText(toolResult);
		assert.match(text, /still running/, `expected partial-watch wording, got: ${text}`);
		assert.match(text, /NOT cancelled/, `expected explicit not-cancelled wording, got: ${text}`);
		assert.equal(toolResult.details.partialWatch, true, "details carry partialWatch marker");
		assert.notEqual(toolResult.details.status, "error");
		const runId = toolResult.details.runId;
		assert.ok(runId, "runId present");

		// Poll for the deferred runner's terminal state (mock agents are fast
		// once invoked, but first-invocation module load + spawn adds latency —
		// poll instead of a fixed sleep). Bug #2 regression pin: with the OLD
		// armed deadline timer the deferred runner started against an
		// already-aborted signal and the run ended cancelled/failed.
		let terminal: string | undefined;
		const pollDeadline = Date.now() + 20_000;
		while (Date.now() < pollDeadline) {
			const loaded = loadRunManifestById(cwd, runId);
			terminal = loaded?.manifest.status;
			if (terminal && terminal !== "queued" && terminal !== "planning" && terminal !== "running") break;
			await new Promise((r) => setTimeout(r, 300));
		}
		assert.equal(runnerInvoked, true, "deferred runner was invoked after the watch window");
		assert.ok(terminal, "run manifest loadable");
		assert.equal(terminal, "completed", `the run must SURVIVE the watch expiry (bug #2 regression pin) — got ${terminal}`);
	} finally {
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousAllowMock === undefined) delete process.env.PI_CREW_ALLOW_MOCK;
		else process.env.PI_CREW_ALLOW_MOCK = previousAllowMock;
		clearRunPromisesForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
