import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { initializeProject } from "../../src/extension/project-init.ts";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { firstText } from "../fixtures/tool-result-helpers.ts";

test("project init creates directories and gitignore entries idempotently", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-init-test-"));
	try {
		const first = initializeProject(cwd);
		assert.ok(first.gitignoreUpdated);
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "agents")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "teams")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "workflows")));
		const gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf-8");
		assert.match(gitignore, /\.crew\/state\//);
		const second = initializeProject(cwd);
		assert.equal(second.gitignoreUpdated, false);
		const tool = await handleTeamTool({ action: "init" }, { cwd });
		assert.equal(tool.isError, false);
		assert.match(firstText(tool), /Initialized pi-crew/);
		const withBuiltins = await handleTeamTool({ action: "init", config: { copyBuiltins: true } }, { cwd });
		assert.equal(withBuiltins.isError, false);
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "teams", "default.team.md")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "workflows", "default.workflow.md")));
		assert.ok(fs.existsSync(path.join(cwd, ".crew", "agents", "explorer.md")));
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

