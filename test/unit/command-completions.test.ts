import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { suggestAgents, suggestRunIds, suggestTaskIds, suggestTeams, suggestWorkflows } from "../../src/extension/command-completions.ts";
import { createRunManifest } from "../../src/state/state-store.ts";
import type { TeamConfig } from "../../src/teams/team-config.ts";
import type { WorkflowConfig } from "../../src/workflows/workflow-config.ts";
import { createTrackedTempDir } from "../fixtures/test-tempdir.ts";

const team: TeamConfig = {
	name: "test-team",
	description: "test team",
	source: "builtin",
	filePath: "test.team.md",
	roles: [{ name: "explorer", agent: "explorer" }],
};
const workflow: WorkflowConfig = {
	name: "test-wf",
	description: "test workflow",
	source: "builtin",
	filePath: "test.workflow.md",
	steps: [{ id: "explore", role: "explorer", task: "Explore" }],
};

let tmpCwd: string;
let previousHome: string | undefined;

function beforeEachFn() {
	tmpCwd = createTrackedTempDir("pi-crew-completions-");
	// Isolate the home dir so user-config team discovery doesn't leak in.
	previousHome = process.env.PI_TEAMS_HOME;
	const home = createTrackedTempDir("pi-crew-comp-home-");
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	process.env.PI_TEAMS_HOME = home;
	// NOTE: do NOT process.chdir() — node:test runs files concurrently and
	// mutating the global cwd corrupts sibling test files. Pass cwd explicitly.
}

function afterEachFn() {
	if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
	else process.env.PI_TEAMS_HOME = previousHome;
	try {
		fs.rmSync(tmpCwd, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

describe("suggestRunIds", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("returns null when no runs exist", () => {
		assert.equal(suggestRunIds("", tmpCwd), null);
		assert.equal(suggestRunIds("team_", tmpCwd), null);
	});

	it("suggests run IDs for created runs", () => {
		const created = createRunManifest({
			cwd: tmpCwd,
			team,
			workflow,
			goal: "test goal",
		});
		const result = suggestRunIds("", tmpCwd);
		assert.ok(result, "expected run-id suggestions");
		const match = result.find((item) => item.value === created.manifest.runId);
		assert.ok(match, "created run should appear in suggestions");
		assert.ok(match.description);
	});

	it("filters by prefix", () => {
		const created = createRunManifest({
			cwd: tmpCwd,
			team,
			workflow,
			goal: "filterable",
		});
		// Correct prefix → matches
		assert.ok(suggestRunIds(created.manifest.runId.slice(0, 10), tmpCwd));
		// Wrong prefix → no matches → null
		assert.equal(suggestRunIds("nonexistent_prefix_xyz", tmpCwd), null);
	});
});

describe("suggestTeams / suggestWorkflows / suggestAgents", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("suggestTeams returns null or valid items without throwing", () => {
		const result = suggestTeams("", tmpCwd);
		if (result) for (const item of result) assert.ok(item.value.length > 0);
	});

	it("suggestWorkflows returns null or valid items without throwing", () => {
		const result = suggestWorkflows("", tmpCwd);
		if (result) for (const item of result) assert.ok(item.value.length > 0);
	});

	it("suggestAgents returns null or valid items without throwing", () => {
		const result = suggestAgents("", tmpCwd);
		if (result) for (const item of result) assert.ok(item.value.length > 0);
	});
});

describe("suggestTaskIds", () => {
	beforeEach(beforeEachFn);
	afterEach(afterEachFn);

	it("returns null for non-existent run", async () => {
		const result = await suggestTaskIds("team_nonexistent", "", tmpCwd);
		assert.equal(result, null);
	});

	it("suggests task IDs for a real run", async () => {
		const created = createRunManifest({
			cwd: tmpCwd,
			team,
			workflow,
			goal: "task test",
		});
		const result = await suggestTaskIds(created.manifest.runId, "", tmpCwd);
		assert.ok(result, "expected task-id suggestions");
		assert.ok(result.length > 0, "workflow has at least one task");
		for (const item of result) {
			assert.ok(item.value.length > 0);
			assert.ok(item.description);
		}
	});
});
