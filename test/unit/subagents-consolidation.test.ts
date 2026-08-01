import assert from "node:assert/strict";
import test from "node:test";
import { getBackgroundRunnerCommand } from "../../src/runtime/async-runner.ts";
import { SubagentManager } from "../../src/runtime/subagent-manager.ts";
import { runChildPi } from "../../src/runtime/child-pi.ts";

test("subagents consolidation entrypoints re-export existing runtime APIs", () => {
	assert.equal(typeof runChildPi, "function");
	assert.equal(typeof SubagentManager, "function");
	assert.equal(typeof getBackgroundRunnerCommand, "function");
});
