import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";

test("management create/update/delete project team with backups", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-mgmt-test-"));
	fs.mkdirSync(path.join(cwd, ".crew"));
	try {
		const create = await handleTeamTool({
			action: "create",
			resource: "team",
			config: {
				name: "Temp Team",
				description: "Temporary team",
				scope: "project",
				defaultWorkflow: "default",
				roles: [{ name: "planner", agent: "planner" }],
			},
		}, { cwd });
		assert.equal(create.isError, false);
		const filePath = path.join(cwd, ".crew", "teams", "temp-team.team.md");
		assert.ok(fs.existsSync(filePath));

		const update = await handleTeamTool({
			action: "update",
			resource: "team",
			team: "temp-team",
			scope: "project",
			config: { description: "Updated team" },
		}, { cwd });
		assert.equal(update.isError, false);
		assert.match(fs.readFileSync(filePath, "utf-8"), /Updated team/);
		assert.ok(fs.readdirSync(path.dirname(filePath)).some((entry) => entry.startsWith("temp-team.team.md.bak-")));

		const deleted = await handleTeamTool({ action: "delete", resource: "team", team: "temp-team", scope: "project", confirm: true }, { cwd });
		assert.equal(deleted.isError, false);
		assert.equal(fs.existsSync(filePath), false);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
