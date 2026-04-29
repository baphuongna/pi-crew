import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("team run writes progress artifacts and API exposes state", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-runtime-hardening-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Check runtime hardening" }, { cwd });
		assert.equal(run.isError, false);
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId);
		assert.ok(loaded);
		const progress = loaded.manifest.artifacts.find((artifact) => artifact.kind === "progress");
		assert.ok(progress);
		assert.ok(fs.existsSync(progress.path));
		assert.match(fs.readFileSync(progress.path, "utf-8"), /Task counts:/);
		assert.equal(loaded.tasks.some((task) => task.claim !== undefined), false);
		assert.equal(loaded.tasks.every((task) => task.heartbeat !== undefined), true);

		const list = await handleTeamTool({ action: "api", runId, config: { operation: "list-tasks" } }, { cwd });
		assert.equal(list.isError, false);
		assert.match(firstText(list), /01_explore/);

		const heartbeat = await handleTeamTool({ action: "api", runId, config: { operation: "read-heartbeat", taskId: loaded.tasks[0]?.id } }, { cwd });
		assert.equal(heartbeat.isError, false);
		assert.match(firstText(heartbeat), /workerId/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

