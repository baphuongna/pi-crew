import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("team run creates durable artifacts and status", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "default", goal: "Test durable run" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		const stateRoot = path.join(cwd, ".crew", "state", "runs", runId!);
		const artifactsRoot = path.join(cwd, ".crew", "artifacts", runId!);
		assert.ok(fs.existsSync(path.join(stateRoot, "manifest.json")));
		assert.ok(fs.existsSync(path.join(stateRoot, "tasks.json")));
		assert.ok(fs.existsSync(path.join(stateRoot, "events.jsonl")));
		assert.ok(fs.existsSync(path.join(artifactsRoot, "goal.md")));
		assert.ok(fs.existsSync(path.join(artifactsRoot, "prompts", "01_explore.md")));

		const status = await handleTeamTool({ action: "status", runId }, { cwd });
		assert.equal(status.isError, false);
		assert.match(firstText(status), /Status: completed/);
		assert.match(firstText(status), /Recent events:/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

