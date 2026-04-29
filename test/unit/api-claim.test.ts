import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("api supports claim, transition, and release task claim", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-api-claim-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "claim api" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const taskId = loadRunManifestById(cwd, runId)?.tasks[0]?.id;
		assert.ok(taskId);
		const claim = await handleTeamTool({ action: "api", runId, config: { operation: "claim-task", taskId, owner: "tester" } }, { cwd });
		assert.equal(claim.isError, false);
		const token = JSON.parse(firstText(claim) || "{}").token as string;
		assert.ok(token);
		const transition = await handleTeamTool({ action: "api", runId, config: { operation: "transition-task-status", taskId, owner: "tester", token, status: "queued" } }, { cwd });
		assert.equal(transition.isError, false);
		const release = await handleTeamTool({ action: "api", runId, config: { operation: "release-task-claim", taskId, owner: "tester", token } }, { cwd });
		assert.equal(release.isError, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

