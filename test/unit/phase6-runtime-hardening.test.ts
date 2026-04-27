import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runChildPi } from "../../src/runtime/child-pi.ts";
import { buildPiWorkerArgs, checkCrewDepth } from "../../src/runtime/pi-args.ts";
import { rewriteTeamWorkerPrompt } from "../../src/prompt/prompt-runtime.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

const agent: AgentConfig = {
	name: "phase6",
	description: "phase6",
	source: "builtin",
	filePath: "phase6.md",
	systemPrompt: "system prompt",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("buildPiWorkerArgs writes long tasks to private @file and emits canonical depth env", () => {
	const result = buildPiWorkerArgs({ task: "x".repeat(9000), agent, sessionEnabled: false, maxDepth: 5, env: { PI_CREW_DEPTH: "1" } as NodeJS.ProcessEnv });
	try {
		const taskArg = result.args.find((arg) => arg.startsWith("@"));
		assert.ok(taskArg);
		const taskPath = taskArg!.slice(1);
		assert.equal(fs.existsSync(taskPath), true);
		assert.equal(fs.readFileSync(taskPath, "utf-8"), "x".repeat(9000));
		assert.equal(result.env.PI_CREW_DEPTH, "2");
		assert.equal(result.env.PI_CREW_MAX_DEPTH, "5");
		assert.equal(result.env.PI_TEAMS_DEPTH, "2");
		assert.equal(result.env.PI_CREW_INHERIT_PROJECT_CONTEXT, "0");
	} finally {
		if (result.tempDir) fs.rmSync(result.tempDir, { recursive: true, force: true });
	}
});

test("crew depth guard blocks child workers at max depth before mock execution", async () => {
	const previousDepth = process.env.PI_CREW_DEPTH;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CREW_DEPTH = "2";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	try {
		assert.deepEqual(checkCrewDepth(2), { depth: 2, maxDepth: 2, blocked: true });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-depth-"));
		try {
			const result = await runChildPi({ cwd: dir, task: "hi", agent, maxDepth: 2 });
			assert.equal(result.exitCode, 1);
			assert.match(result.stderr, /depth guard/);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	} finally {
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
	}
});

test("prompt runtime supports canonical pi-crew inherit env behavior", () => {
	const prompt = "Base\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\nsecret\nCurrent date: now";
	assert.equal(rewriteTeamWorkerPrompt(prompt, { inheritProjectContext: false, inheritSkills: true }).includes("secret"), false);
});
