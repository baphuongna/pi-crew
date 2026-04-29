import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("mutating api operations respect run locks", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-api-locks-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "api locks" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		fs.writeFileSync(path.join(loaded.manifest.stateRoot, "run.lock"), "locked", "utf-8");
		const taskId = loaded.tasks[0]?.id;
		const locked = await handleTeamTool({ action: "api", runId, config: { operation: "claim-task", taskId, owner: "tester" } }, { cwd });
		assert.equal(locked.isError, true);
		assert.match(firstText(locked), /locked/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

