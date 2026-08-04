import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listRuns } from "../../../../src/extension/run-index.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { projectCrewRoot } from "../../../../src/utils/paths.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

test("prune removes old finished runs after confirmation", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prune-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		for (let i = 0; i < 3; i++) {
			const run = await handleTeamTool(
				{
					action: "run",
					config: { runtime: { mode: "scaffold" } },
					team: "fast-fix",
					goal: `Prune ${i}`,
				},
				{ cwd },
			);
			assert.equal(run.isError, false);
		}
		const ownRuns = () => listRuns(cwd).filter((run) => run.cwd === cwd);
		assert.equal(ownRuns().length, 3);
		const blocked = await handleTeamTool({ action: "prune", keep: 1 }, { cwd });
		assert.equal(blocked.isError, true);
		assert.equal(ownRuns().length, 3);
		const pruned = await handleTeamTool(
			{
				action: "prune",
				keep: 1,
				confirm: true,
				config: { intent: "keep only latest completed smoke run" },
			},
			{ cwd },
		);
		assert.equal(pruned.isError, false);
		assert.equal(pruned.details.intent, "keep only latest completed smoke run");
		assert.equal(ownRuns().length, 1);
		const auditPath = path.join(projectCrewRoot(cwd), "audit", "prune.jsonl");
		assert.equal(fs.existsSync(auditPath), true);
		const auditLines = fs.readFileSync(auditPath, "utf-8").trim().split(/\r?\n/);
		const audit = JSON.parse(auditLines.at(-1) ?? "{}");
		assert.equal(audit.intent, "keep only latest completed smoke run");
		assert.equal(audit.keep, 1);
		assert.equal(audit.removed.length, 2);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

// dryRun must be a TRUE preview: compute the removal list WITHOUT deleting any
// state/artifacts, running worktree cleanup, or writing an audit. Regression
// guard for the data-safety bug where handlePrune ignored dryRun entirely and
// deleted runs even when the caller only asked for a preview.
test("prune dryRun previews without deleting (no confirm required)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-prune-dryrun-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		for (let i = 0; i < 3; i++) {
			const run = await handleTeamTool(
				{ action: "run", config: { runtime: { mode: "scaffold" } }, team: "fast-fix", goal: `Dry ${i}` },
				{ cwd },
			);
			assert.equal(run.isError, false);
		}
		const ownRuns = () => listRuns(cwd).filter((run) => run.cwd === cwd);
		assert.equal(ownRuns().length, 3);
		// dryRun WITHOUT confirm must succeed (non-destructive preview is always allowed).
		const preview = await handleTeamTool({ action: "prune", keep: 1, dryRun: true }, { cwd });
		assert.equal(preview.isError, false);
		assert.match(firstText(preview), /Preview:/);
		// CRITICAL: nothing was deleted — all 3 runs survive.
		assert.equal(ownRuns().length, 3);
		// No audit written for a dry-run preview.
		const auditPath = path.join(projectCrewRoot(cwd), "audit", "prune.jsonl");
		assert.equal(fs.existsSync(auditPath), false);
		// A real prune after the preview still works and removes as expected.
		const real = await handleTeamTool({ action: "prune", keep: 1, confirm: true }, { cwd });
		assert.equal(real.isError, false);
		assert.equal(ownRuns().length, 1);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
