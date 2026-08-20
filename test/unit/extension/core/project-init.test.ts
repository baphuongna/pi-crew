import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { initializeProject } from "../../../../src/extension/project-init.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

function withIsolatedHome(fn: () => Promise<void> | void): () => Promise<void> {
	return async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-init-test-"));
		const previousHome = process.env.PI_TEAMS_HOME;
		const previousSkipCheck = process.env.PI_CREW_SKIP_HOME_CHECK;
		process.env.PI_TEAMS_HOME = cwd;
		process.env.PI_CREW_SKIP_HOME_CHECK = "1";
		try {
			await fn();
		} finally {
			if (previousHome === undefined) delete process.env.PI_TEAMS_HOME;
			else process.env.PI_TEAMS_HOME = previousHome;
			if (previousSkipCheck === undefined) delete process.env.PI_CREW_SKIP_HOME_CHECK;
			else process.env.PI_CREW_SKIP_HOME_CHECK = previousSkipCheck;
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	};
}

test(
	"project init creates directories and gitignore entries idempotently",
	withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		const first = initializeProject(cwd);
		assert.ok(first.gitignoreUpdated);
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "agents")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "teams")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "workflows")));
		assert.equal(first.configScope, "global");
		assert.equal(first.configCreated, true);
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "agent", "pi-crew.json")));
		assert.equal(fs.existsSync(path.join(cwd, ".pi", "pi-crew.json")), false);
		const config = JSON.parse(fs.readFileSync(path.join(cwd, ".pi", "agent", "pi-crew.json"), "utf-8"));
		assert.equal(config.agents.overrides.explorer.model, false);
		assert.equal(config.agents.overrides.executor.thinking, "medium");
		assert.equal(config.ui.widgetPlacement, "belowEditor");
		assert.equal(config.ui.widgetMaxLines, 8);
		assert.equal(config.ui.dashboardPlacement, "center");
		assert.equal(config.ui.dashboardWidth, 72);
		assert.equal(config.ui.autoOpenDashboard, false);
		assert.equal(config.ui.autoOpenDashboardForForegroundRuns, false);
		assert.equal(config.ui.showModel, true);
		assert.equal(config.ui.showTokens, true);
		assert.equal(config.ui.showTools, true);
		const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf-8");
		assert.match(gitignore, /\.crew\/state\//);
		const second = initializeProject(cwd);
		assert.equal(second.gitignoreUpdated, false);
		assert.equal(second.configScope, "global");
		assert.equal(second.configCreated, false);
		assert.equal(second.configSkipped, true);
		const tool = await handleTeamTool({ action: "init" }, { cwd });
		assert.equal(tool.isError, false);
		assert.match(firstText(tool), /Initialized pi-crew/);
		assert.match(firstText(tool), /Config:.*global/);
		const withBuiltins = await handleTeamTool({ action: "init", config: { copyBuiltins: true } }, { cwd });
		assert.equal(withBuiltins.isError, false);
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "teams", "default.team.md")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "workflows", "default.workflow.md")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "agents", "explorer.md")));
		const projectConfig = initializeProject(cwd, {
			configScope: "project",
		});
		assert.equal(projectConfig.configScope, "project");
		assert.ok(fs.existsSync(path.join(cwd, ".pi", "pi-crew.json")));
	}),
);

test(
	"project init with ignoreMethod=exclude writes to .git/info/exclude",
	withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		// Create .git/info/ to simulate git repo
		fs.mkdirSync(path.join(cwd, ".git", "info"), { recursive: true });
		const result = initializeProject(cwd, { ignoreMethod: "exclude" });
		assert.ok(result.gitignoreUpdated);
		// Should write to .git/info/exclude, NOT .gitignore
		assert.equal(fs.existsSync(path.join(cwd, ".gitignore")), false);
		const exclude = fs.readFileSync(path.join(cwd, ".git", "info", "exclude"), "utf-8");
		assert.match(exclude, /\.crew\/state\//);
		assert.match(exclude, /# pi-crew runtime state/);
		// Idempotent
		const second = initializeProject(cwd, { ignoreMethod: "exclude" });
		assert.equal(second.gitignoreUpdated, false);
	}),
);

test(
	"project init with ignoreMethod=exclude creates .git/info/ if missing",
	withIsolatedHome(async () => {
		const cwd = process.env.PI_TEAMS_HOME!;
		// No .git directory at all
		const result = initializeProject(cwd, { ignoreMethod: "exclude" });
		assert.ok(result.gitignoreUpdated);
		assert.ok(fs.existsSync(path.join(cwd, ".git", "info", "exclude")));
	}),
);
