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
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		for (let i = 0; i < 5; i++) createRunManifest({ cwd, team, workflow, goal: `run ${i}` });
		const recent = listRecentRuns(cwd, 2);
		assert.equal(recent.length, 2);
		assert.ok(recent[0]!.createdAt >= recent[1]!.createdAt);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("listRecentRuns in project scope ignores user-global runs", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-home-"));
	process.env.PI_TEAMS_HOME = home;
	const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-project-"));
	const userCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-user-"));
	fs.mkdirSync(path.join(projectCwd, ".crew"), { recursive: true });
	try {
		const userRun = createRunManifest({ cwd: userCwd, team, workflow, goal: "user scope run" });
		const projectRun = createRunManifest({ cwd: projectCwd, team, workflow, goal: "project scope run" });
		const recent = listRecentRuns(projectCwd, 10);
		assert.equal(recent.some((run) => run.runId === projectRun.manifest.runId), true);
		assert.equal(recent.some((run) => run.runId === userRun.manifest.runId), false);
		assert.ok(recent.every((run) => run.cwd === projectCwd));
	} finally {
		fs.rmSync(projectCwd, { recursive: true, force: true });
		fs.rmSync(userCwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});

test("listRecentRuns outside project reads user-global runs only", () => {
	const previousHome = process.env.PI_TEAMS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-home-"));
	process.env.PI_TEAMS_HOME = home;
	const userCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-user-"));
	const projectCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-run-index-project-"));
	fs.mkdirSync(path.join(projectCwd, ".crew"), { recursive: true });
	try {
		const userRun = createRunManifest({ cwd: userCwd, team, workflow, goal: "user scope run" });
		const projectRun = createRunManifest({ cwd: projectCwd, team, workflow, goal: "project scope run" });
		const recent = listRecentRuns(userCwd, 10);
		assert.equal(recent.some((run) => run.runId === userRun.manifest.runId), true);
		assert.equal(recent.some((run) => run.runId === projectRun.manifest.runId), false);
	} finally {
		fs.rmSync(userCwd, { recursive: true, force: true });
		fs.rmSync(projectCwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
		if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = previousHome;
	}
});
