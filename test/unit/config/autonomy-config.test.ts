import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { configPath } from "../../../src/config/config.ts";
import { handleTeamTool } from "../../../src/extension/team-tool.ts";
import { firstText } from "../../fixtures/tool-result-helpers.ts";

test("autonomy action shows and toggles autonomous config", async () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-autonomy-"));
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldPiTeamsHome = process.env.PI_TEAMS_HOME;
	process.env.HOME = tmp;
	process.env.USERPROFILE = tmp;
	process.env.PI_TEAMS_HOME = tmp;
	try {
		const status = await handleTeamTool({ action: "autonomy" }, { cwd: tmp });
		assert.equal(status.isError, false);
		assert.match(firstText(status), /Enabled: true/);

		const off = await handleTeamTool({ action: "autonomy", config: { enabled: false } }, { cwd: tmp });
		assert.equal(off.isError, false);
		assert.match(firstText(off), /Enabled: false/);

		const on = await handleTeamTool(
			{
				action: "autonomy",
				config: {
					enabled: true,
					injectPolicy: true,
					preferAsyncForLongTasks: true,
					allowWorktreeSuggestion: false,
				},
			},
			{ cwd: tmp },
		);
		assert.equal(on.isError, false);
		const text = firstText(on);
		assert.match(text, /Enabled: true/);
		assert.match(text, /Prefer async for long tasks: true/);
		assert.match(text, /Allow worktree suggestion: false/);

		const raw = JSON.parse(fs.readFileSync(configPath(), "utf-8")) as {
			autonomous?: { enabled?: boolean };
		};
		assert.equal(raw.autonomous?.enabled, true);
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldPiTeamsHome === undefined) delete process.env.PI_TEAMS_HOME;
		else process.env.PI_TEAMS_HOME = oldPiTeamsHome;
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});
