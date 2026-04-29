import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

test("cancel marks run cancelled and resume can complete it", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-resume-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Resume me" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);

		const cancelled = await handleTeamTool({ action: "cancel", runId, force: true }, { cwd });
		assert.equal(cancelled.isError, false);
		assert.equal(loadRunManifestById(cwd, runId!)?.manifest.status, "cancelled");

		const resumed = await handleTeamTool({ action: "resume", runId }, { cwd });
		assert.equal(resumed.isError, false);
		assert.equal(loadRunManifestById(cwd, runId!)?.manifest.status, "completed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
