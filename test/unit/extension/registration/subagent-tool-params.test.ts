import assert from "node:assert/strict";
import test from "node:test";
import { __test__subagentSpawnParams } from "../../../../src/extension/register.ts";

test("subagent spawn params default to an existing pi-crew executor agent", () => {
	const params = __test__subagentSpawnParams({ prompt: "Do it", description: "Run task" }, { cwd: process.cwd() });
	assert.equal(params.type, "executor");
	assert.equal(params.prompt, "Do it");
	assert.equal(params.background, false);
});

test("subagent spawn params parse background and model overrides", () => {
	const params = __test__subagentSpawnParams(
		{
			prompt: "Explore",
			description: "Read",
			subagent_type: "explorer",
			run_in_background: true,
			model: "openai/test",
		},
		{ cwd: process.cwd() },
	);
	assert.equal(params.type, "explorer");
	assert.equal(params.background, true);
	assert.equal(params.model, "openai/test");
});
