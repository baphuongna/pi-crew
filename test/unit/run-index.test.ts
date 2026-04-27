import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { listRecentRuns } from "../../src/extension/run-index.ts";

const team: TeamConfig = { name: "idx", description: "idx", source: "builtin", filePath: "idx.team.md", roles: [{ name: "explorer", agent: "explorer" }] };
const workflow: WorkflowConfig = { name: "idx", description: "idx", source: "builtin", filePath: "idx.workflow.md", steps: [{ id: "explore", role: "explorer", task: "Explore" }] };

test("listRecentRuns limits manifest scans for widget hot paths", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-"));
	fs.mkdirSync(path.join(cwd, ".pi"));
	try {
		for (let i = 0; i < 5; i++) createRunManifest({ cwd, team, workflow, goal: `run ${i}` });
		const recent = listRecentRuns(cwd, 2);
		assert.equal(recent.length, 2);
		assert.ok(recent[0]!.createdAt >= recent[1]!.createdAt);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
