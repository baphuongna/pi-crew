import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { liveAgentControlPath, readLiveAgentControlRequests } from "../../src/runtime/live-agent-control.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("agent control queues durable live-agent request when agent is in another process", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-control-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "control bridge smoke" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		const agentsResult = await handleTeamTool({ action: "api", runId, config: { operation: "list-agents" } }, { cwd });
		const first = JSON.parse(firstText(agentsResult))[0];
		const queued = await handleTeamTool({ action: "api", runId, config: { operation: "steer-agent", agentId: first.taskId, message: "durable steer" } }, { cwd });
		assert.equal(queued.isError, false);
		assert.match(firstText(queued), /"queued": true/);
		const loaded = loadRunManifestById(cwd, runId)!;
		assert.equal(fs.existsSync(liveAgentControlPath(loaded.manifest, first.taskId)), true);
		const batch = readLiveAgentControlRequests(loaded.manifest, first.taskId);
		assert.equal(batch.requests[0]?.operation, "steer");
		assert.equal(batch.requests[0]?.message, "durable steer");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

