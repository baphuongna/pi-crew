import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { listImportedRuns } from "../../src/extension/import-index.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("imports action lists imported run bundles", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-import-list-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "List imported" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		await handleTeamTool({ action: "export", runId }, { cwd });
		const exportPath = path.join(cwd, ".crew", "artifacts", runId!, "export", "run-export.json");
		await handleTeamTool({ action: "import", config: { path: exportPath, scope: "project" } }, { cwd });
		const imports = listImportedRuns(cwd);
		assert.equal(imports.length, 1);
		assert.equal(imports[0]?.runId, runId);
		const listed = await handleTeamTool({ action: "imports" }, { cwd });
		assert.equal(listed.isError, false);
		assert.match(firstText(listed), new RegExp(runId!));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

