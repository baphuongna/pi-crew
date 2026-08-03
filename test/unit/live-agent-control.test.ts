import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { clearLiveAgentsForTest, registerLiveAgent } from "../../src/runtime/live-session/live-agent-manager.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("api rejects direct live-agent control for a different run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-control-run-boundary-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "run boundary",
			},
			{ cwd },
		);
		const runId = run.details.runId!;
		registerLiveAgent({
			agentId: "other-agent-1",
			runId: "other-run",
			taskId: "task",
			status: "running",
			session: { steer: async () => undefined },
			workspaceId: cwd,
		});
		const rejected = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "steer-agent",
					agentId: "other-agent-1",
					message: "no",
				},
			},
			{ cwd },
		);
		assert.equal(rejected.isError, true);
		assert.match(firstText(rejected), /does not belong to run/);
	} finally {
		clearLiveAgentsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("api rejects steer for live agent with mismatched workspaceId", async () => {
	// This tests the core security check: a live agent from workspace A
	// should not be steerable when the manifest is from workspace B.
	// We register an agent with workspaceId=X but try to steer it when
	// the loaded manifest has workspaceId=Y. The workspaceId mismatch
	// is the primary isolation boundary (agents are not cross-workspace).
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-live-workspace-mismatch-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		const run = await handleTeamTool(
			{
				action: "run",
				config: { runtime: { mode: "scaffold" } },
				team: "fast-fix",
				goal: "workspace isolation",
			},
			{ cwd },
		);
		const runId = run.details.runId!;
		// Register an agent with a DIFFERENT workspaceId than the run's cwd
		const otherWorkspace = "/completely/different/workspace/path";
		registerLiveAgent({
			agentId: `${runId}:cross-workspace`,
			runId,
			taskId: "task",
			status: "running",
			session: { steer: async () => undefined },
			workspaceId: otherWorkspace,
		});
		const rejected = await handleTeamTool(
			{
				action: "api",
				runId,
				config: {
					operation: "steer-agent",
					agentId: `${runId}:cross-workspace`,
					message: "no",
				},
			},
			{ cwd },
		);
		// The agent's workspaceId doesn't match the manifest's cwd — should reject
		assert.equal(rejected.isError, true);
	} finally {
		clearLiveAgentsForTest();
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
