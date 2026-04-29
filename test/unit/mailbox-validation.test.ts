import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("mailbox supports task-scoped messages and validation repair", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mailbox-validation-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "mailbox validation" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		const taskId = loaded?.tasks[0]?.id;
		assert.ok(taskId);
		await handleTeamTool({ action: "api", runId, config: { operation: "send-message", taskId, direction: "inbox", body: "task hello" } }, { cwd });
		const taskMailbox = await handleTeamTool({ action: "api", runId, config: { operation: "read-mailbox", taskId, direction: "inbox" } }, { cwd });
		const messages = JSON.parse(firstText(taskMailbox) || "[]") as Array<{ taskId?: string }>;
		assert.equal(messages[0]?.taskId, taskId);
		fs.appendFileSync(path.join(loaded!.manifest.stateRoot, "mailbox", "inbox.jsonl"), "not-json\n", "utf-8");
		const invalid = await handleTeamTool({ action: "api", runId, config: { operation: "validate-mailbox" } }, { cwd });
		assert.equal(invalid.isError, true);
		const repaired = await handleTeamTool({ action: "api", runId, config: { operation: "validate-mailbox", repair: true } }, { cwd });
		assert.equal(repaired.isError, false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

