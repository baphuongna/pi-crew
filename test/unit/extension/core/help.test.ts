import assert from "node:assert/strict";
import test from "node:test";
import { piTeamsHelp } from "../../../../src/extension/help.ts";
import { handleTeamTool } from "../../../../src/extension/team-tool.ts";
import { firstText } from "../../../fixtures/tool-result-helpers.ts";

test("help includes major commands", async () => {
	const help = piTeamsHelp();
	assert.match(help, /\/team-run/);
	assert.match(help, /\/team-dashboard/);
	assert.match(help, /\/team-transcript/);
	assert.match(help, /\/team-result/);
	assert.match(help, /\/team-export/);
	const result = await handleTeamTool({ action: "help" }, { cwd: process.cwd() });
	assert.equal(result.isError, false);
	assert.match(firstText(result), /pi-crew commands/);
});
