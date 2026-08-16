import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../../../src/state/stores/state-store.ts";
import { sleepSync } from "../../../../src/utils/sleep.ts";

test("cancel marks run cancelled and resume can complete it", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resume-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "Resume me",
			},
			{ cwd },
		);
		const runId = run.details.runId;
		assert.ok(runId);

		const cancelled = await handleTeamTool({ action: "cancel", runId, force: true }, { cwd });
		assert.equal(cancelled.isError, false);
		assert.equal(loadRunManifestById(cwd, runId!)?.manifest.status, "cancelled");

		const resumed = await handleTeamTool({ action: "resume", runId }, { cwd });
		assert.equal(resumed.isError, false);
		assert.equal(loadRunManifestById(cwd, runId!)?.manifest.status, "completed");
	} finally {
		// macOS-CI teardown hardening (2026-08-16): the spawned mock worker's
		// final writes can race the recursive rmdir — rimrafSync throws
		// ENOTEMPTY (not swallowed by force:true) when a file lands between its
		// unlink pass and a directory rmdir. Retry briefly; the worker has
		// exited by now, so the next attempt succeeds. Best-effort: a persistent
		// ENOTEMPTY (rare, macOS) is NOT a test failure — the assertions above
		// already passed, and /tmp is swept by the OS.
		for (let attempt = 0; attempt < 5; attempt++) {
			try {
				fs.rmSync(cwd, { recursive: true, force: true });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOTEMPTY" || attempt === 4) {
					console.error(`resume-cancel teardown: unable to remove ${cwd}: ${String(error)}`);
					break;
				}
				sleepSync(200);
			}
		}
	}
});
