import assert from "node:assert/strict";
import test from "node:test";
import { getBackgroundRunnerCommand } from "../../../../src/runtime/async-runner.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";
import { SubagentManager } from "../../../../src/runtime/subagent-manager.ts";

test("subagents consolidation entrypoints re-export existing runtime APIs", () => {
	assert.equal(typeof runChildPi, "function");
	assert.equal(typeof SubagentManager, "function");
	assert.equal(typeof getBackgroundRunnerCommand, "function");
});
