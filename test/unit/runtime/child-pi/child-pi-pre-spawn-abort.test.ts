import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { runChildPi } from "../../../../src/runtime/child-pi/child-pi.ts";

const agent: AgentConfig = {
	name: "executor",
	description: "executor",
	source: "builtin",
	filePath: "executor.md",
	systemPrompt: "executor",
	inheritProjectContext: false,
	inheritSkills: false,
};

test("runChildPi returns cancelled result without spawning when signal already aborted (B5)", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-b5-"));
	try {
		let spawned = false;
		const controller = new AbortController();
		controller.abort();
		const result = await runChildPi({
			cwd,
			task: "should not run",
			agent,
			signal: controller.signal,
			onSpawn: () => {
				spawned = true;
			},
		});
		assert.equal(spawned, false, "must NOT spawn a child process when the signal is already aborted");
		assert.equal(result.aborted, true, "result must be marked aborted");
		assert.match(result.error ?? "", /Aborted before spawn/i);
		assert.equal(result.exitCode, null);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
