import assert from "node:assert/strict";
import test from "node:test";
import { handleTeamTool } from "../../../src/extension/team-tool.ts";
import { firstText } from "../../fixtures/tool-result-helpers.ts";

test("config action shows config path and effective config", async () => {
	const result = await handleTeamTool({ action: "config" }, { cwd: process.cwd() });
	assert.equal(result.isError, false);
	const text = firstText(result);
	assert.match(text, /pi-crew config:/);
	assert.match(text, /Effective config:/);
	assert.match(text, /schema\.json/);
});
