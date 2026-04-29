import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

test("executeWorkers can use mocked child Pi and record model attempts", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mock-child-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	try {
		const run = await handleTeamTool({ action: "run", team: "fast-fix", goal: "Mock execute" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId!);
		assert.equal(loaded?.manifest.status, "completed");
		assert.ok(loaded?.tasks.every((task) => task.modelAttempts && task.modelAttempts.length >= 1));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "artifacts", runId!, "logs", "01_explore.log")));
	} finally {
		if (previousExecute === undefined) delete process.env.PI_TEAMS_EXECUTE_WORKERS;
		else process.env.PI_TEAMS_EXECUTE_WORKERS = previousExecute;
		if (previousMock === undefined) delete process.env.PI_TEAMS_MOCK_CHILD_PI;
		else process.env.PI_TEAMS_MOCK_CHILD_PI = previousMock;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
