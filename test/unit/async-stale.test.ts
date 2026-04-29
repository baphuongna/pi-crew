import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { saveRunManifest, createRunManifest, loadRunManifestById } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

const team: TeamConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.team.md",
	roles: [{ name: "planner", agent: "planner" }],
};

const workflow: WorkflowConfig = {
	name: "default",
	description: "default",
	source: "builtin",
	filePath: "default.workflow.md",
	steps: [{ id: "plan", role: "planner", task: "Plan {goal}" }],
};

test("status marks active async run failed when recorded pid is stale", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-stale-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const created = createRunManifest({ cwd, team, workflow, goal: "stale async" });
		const stalePid = 2147483000;
		saveRunManifest({ ...created.manifest, status: "running", async: { pid: stalePid, logPath: path.join(created.manifest.stateRoot, "background.log"), spawnedAt: new Date().toISOString() } });
		const status = await handleTeamTool({ action: "status", runId: created.manifest.runId }, { cwd });
		assert.equal(status.isError, false);
		assert.match(firstText(status), /alive=false/);
		assert.match(firstText(status), /Status: failed/);
		assert.equal(loadRunManifestById(cwd, created.manifest.runId)?.manifest.status, "failed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

