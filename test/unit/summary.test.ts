import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";


test("summary action and summary artifact are created for runs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-summary-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const run = await handleTeamTool({ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: "Summarize me" }, { cwd });
		const runId = run.details.runId;
		assert.ok(runId);
		const summaryPath = path.join(cwd, ".crew", "artifacts", runId!, "summary.md");
		assert.ok(fs.existsSync(summaryPath));
		assert.match(fs.readFileSync(summaryPath, "utf-8"), /# pi-crew run/);
		const summary = await handleTeamTool({ action: "summary", runId }, { cwd });
		assert.equal(summary.isError, false);
		assert.match(firstText(summary), /Summary for/);
		assert.match(firstText(summary), /Usage:/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

