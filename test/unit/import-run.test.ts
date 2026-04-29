import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";

test("import action stores exported run bundles", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-import-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Import me" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		await handleTeamTool({ action: "export", runId }, { cwd });
		const exportPath = path.join(cwd, ".crew", "artifacts", runId!, "export", "run-export.json");
		const imported = await handleTeamTool({ action: "import", config: { path: exportPath, scope: "project" } }, { cwd });
		assert.equal(imported.isError, false);
		const importRoot = path.join(cwd, ".crew", "imports", runId!);
		assert.ok(fs.existsSync(path.join(importRoot, "run-export.json")));
		assert.ok(fs.existsSync(path.join(importRoot, "README.md")));
		assert.match(fs.readFileSync(path.join(importRoot, "README.md"), "utf-8"), /Imported pi-crew run/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
