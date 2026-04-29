import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("worker prompts include read-only contract and mailbox coordination bridge", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gap-prompt-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "inspect prompt contracts" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		const artifacts = await handleTeamTool({ action: "artifacts", runId }, { cwd });
		assert.match(firstText(artifacts), /coordination-bridge\.md/);
		const promptPath = path.join(cwd, ".crew", "artifacts", runId, "prompts", "01_explore.md");
		const prompt = fs.readFileSync(promptPath, "utf-8");
		assert.match(prompt, /READ-ONLY ROLE CONTRACT/);
		assert.match(prompt, /Crew Coordination Channel/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("nudge-agent records a mailbox message for the target agent", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-gap-nudge-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "nudge smoke" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		const agents = JSON.parse(firstText(await handleTeamTool({ action: "api", runId, config: { operation: "list-agents" } }, { cwd })));
		const first = agents[0];
		const nudged = await handleTeamTool({ action: "api", runId, config: { operation: "nudge-agent", agentId: first.taskId, message: "status please" } }, { cwd });
		assert.equal(nudged.isError, false);
		assert.match(firstText(nudged), /status please/);
		const mailbox = await handleTeamTool({ action: "api", runId, config: { operation: "read-mailbox", direction: "inbox", taskId: first.taskId } }, { cwd });
		assert.match(firstText(mailbox), /status please/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

