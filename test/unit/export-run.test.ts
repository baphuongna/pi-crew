import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";

test("export action writes JSON and markdown run bundles", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-export-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Export me" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const exported = await handleTeamTool({ action: "export", runId }, { cwd });
		assert.equal(exported.isError, false);
		const exportRoot = path.join(cwd, ".crew", "artifacts", runId!, "export");
		const jsonPath = path.join(exportRoot, "run-export.json");
		const mdPath = path.join(exportRoot, "run-export.md");
		assert.ok(fs.existsSync(jsonPath));
		assert.ok(fs.existsSync(mdPath));
		const bundle = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as { manifest?: { runId?: string }; tasks?: unknown[]; events?: unknown[] };
		assert.equal(bundle.manifest?.runId, runId);
		assert.ok((bundle.tasks?.length ?? 0) > 0);
		assert.ok((bundle.events?.length ?? 0) > 0);
		assert.match(fs.readFileSync(mdPath, "utf-8"), /# pi-crew export/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
