import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";
import type { TeamContext } from "../../src/extension/team-tool/context.ts";

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("live-session runtime can inherit parent conversation context", async () => {
	const previousEnable = process.env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION;
	const previousMock = process.env.PI_CREW_MOCK_LIVE_SESSION;
	process.env.PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION = "1";
	process.env.PI_CREW_MOCK_LIVE_SESSION = "success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-context-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const ctx: TeamContext = {
			cwd,
			model: { provider: "test", id: "model" },
			modelRegistry: { find: (_provider: string, _id: string) => ({ provider: "test", id: "model" }) },
			sessionManager: { getBranch: () => [{ type: "message", message: { role: "user", content: [{ type: "text", text: "parent decision abc" }] } }] },
		} as TeamContext;
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "live inherited context", config: { runtime: { mode: "live-session", inheritContext: true } } }, ctx);
		assert.equal(run.isError, false);
		const agentsResult = await handleTeamTool({ action: "api", runId: run.details.runId!, config: { operation: "list-agents" } }, { cwd });
		const first = JSON.parse(firstText(agentsResult))[0];
		const transcript = await handleTeamTool({ action: "api", runId: run.details.runId!, config: { operation: "read-agent-transcript", agentId: first.taskId } }, { cwd });
		assert.match(firstText(transcript), /parent decision abc/);
	} finally {
		restoreEnv("PI_CREW_ENABLE_EXPERIMENTAL_LIVE_SESSION", previousEnable);
		restoreEnv("PI_CREW_MOCK_LIVE_SESSION", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

