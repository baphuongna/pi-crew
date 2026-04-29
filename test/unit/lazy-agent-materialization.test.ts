import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { readCrewAgents } from "../../src/runtime/crew-agent-records.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

function restore(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

test("queued dependency tasks are shown as waiting tasks, not materialized agents", async () => {
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	const previousExecute = process.env.PI_TEAMS_EXECUTE_WORKERS;
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	process.env.PI_TEAMS_EXECUTE_WORKERS = "1";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-lazy-agents-"));
	try {
		fs.mkdirSync(path.join(cwd, ".crew"), { recursive: true });
		let scheduled: ((signal?: AbortSignal) => Promise<void>) | undefined;
		const run = await handleTeamTool({ action: "run", team: "research", goal: "lazy agent materialization" }, { cwd, startForegroundRun: (runner) => { scheduled = runner; } });
		assert.equal(run.isError, false);
		const runId = run.details.runId!;
		const loadedBefore = loadRunManifestById(cwd, runId)!;
		assert.deepEqual(readCrewAgents(loadedBefore.manifest), []);
		const statusBefore = await handleTeamTool({ action: "status", runId }, { cwd });
		assert.match(firstText(statusBefore), /- 02_analyze \[queued\].*waiting for 01_explore/);
		assert.ok(scheduled);
		await scheduled!();
		const loadedAfter = loadRunManifestById(cwd, runId)!;
		assert.equal(readCrewAgents(loadedAfter.manifest).length, 3);
	} finally {
		restore("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		restore("PI_TEAMS_EXECUTE_WORKERS", previousExecute);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

