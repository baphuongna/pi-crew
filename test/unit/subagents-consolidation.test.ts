import test from "node:test";
import assert from "node:assert/strict";
import { runChildPi } from "../../src/subagents/spawn.ts";
import { SubagentManager } from "../../src/subagents/manager.ts";
import { getBackgroundRunnerCommand } from "../../src/subagents/async-entry.ts";

test("subagents consolidation entrypoints re-export existing runtime APIs", () => {
	assert.equal(typeof runChildPi, "function");
	assert.equal(typeof SubagentManager, "function");
	assert.equal(typeof getBackgroundRunnerCommand, "function");
});
