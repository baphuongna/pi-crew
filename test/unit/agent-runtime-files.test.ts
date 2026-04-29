import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";


test("child-process runs maintain per-agent status, events, and output files", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-agent-files-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "exercise per-agent files" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		const status = await handleTeamTool({ action: "status", runId }, { cwd });
		assert.match(firstText(status), /status=.*status\.json/);

		const loaded = await handleTeamTool({ action: "api", runId, config: { operation: "list-agents" } }, { cwd });
		const agents = JSON.parse(firstText(loaded));
		assert.ok(Array.isArray(agents));
		assert.ok(agents.length > 0);
		const first = agents[0];
		assert.equal(first.runtime, "child-process");
		assert.ok(first.statusPath.endsWith("status.json"));
		assert.ok(first.eventsPath.endsWith("events.jsonl"));
		assert.ok(first.outputPath.endsWith("output.log"));
		assert.ok(first.progress.toolCount >= 0);
		assert.equal(fs.existsSync(first.statusPath), true);
		assert.equal(fs.existsSync(first.eventsPath), true);
		assert.equal(fs.existsSync(first.outputPath), true);

		const statusApi = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-status", agentId: first.taskId } }, { cwd });
		assert.equal(JSON.parse(firstText(statusApi)).taskId, first.taskId);
		const eventsApi = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-events", agentId: first.taskId } }, { cwd });
		assert.match(firstText(eventsApi), /message_end/);
		const transcriptApi = await handleTeamTool({ action: "api", runId, config: { operation: "read-agent-transcript", agentId: first.taskId } }, { cwd });
		assert.match(firstText(transcriptApi), /Mock JSON success/);
		assert.equal(path.basename(path.dirname(first.statusPath)), first.taskId);
	} finally {
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

