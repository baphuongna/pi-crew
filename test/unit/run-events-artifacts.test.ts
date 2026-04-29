import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("events and artifacts actions inspect a durable run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-inspect-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Inspect run" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const events = await handleTeamTool({ action: "events", runId }, { cwd });
		assert.equal(events.isError, false);
		assert.match(firstText(events), /run.created/);
		assert.match(firstText(events), /task.completed/);
		const artifacts = await handleTeamTool({ action: "artifacts", runId }, { cwd });
		assert.equal(artifacts.isError, false);
		assert.match(firstText(artifacts), /goal.md/);
		assert.match(firstText(artifacts), /sha256=/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

