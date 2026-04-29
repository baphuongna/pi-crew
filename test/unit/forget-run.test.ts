import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { loadRunManifestById } from "../../src/state/state-store.ts";

test("forget deletes run state and artifacts when confirmed", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-forget-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Forget me" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const loaded = loadRunManifestById(cwd, runId!);
		assert.ok(loaded);
		const stateRoot = loaded!.manifest.stateRoot;
		const artifactsRoot = loaded!.manifest.artifactsRoot;

		const blocked = await handleTeamTool({ action: "forget", runId }, { cwd });
		assert.equal(blocked.isError, true);
		assert.ok(fs.existsSync(stateRoot));

		const forgotten = await handleTeamTool({ action: "forget", runId, confirm: true }, { cwd });
		assert.equal(forgotten.isError, false);
		assert.equal(fs.existsSync(stateRoot), false);
		assert.equal(fs.existsSync(artifactsRoot), false);
		assert.equal(loadRunManifestById(cwd, runId!), undefined);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
