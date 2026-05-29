import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildPiWorkerArgs, checkCrewDepth } from "../../src/runtime/pi-args.ts";
import { runChildPi } from "../../src/subagents/spawn.ts";
import { SubagentManager } from "../../src/subagents/manager.ts";
import type { AgentConfig } from "../../src/agents/agent-config.ts";

const agent: AgentConfig = {
	name: "executor",
	description: "executor",
	source: "builtin",
	filePath: "executor.md",
	systemPrompt: "executor",
	inheritProjectContext: false,
	inheritSkills: false,
};

function restoreEnv(name: string, previous: string | undefined): void {
	if (previous === undefined) delete process.env[name];
	else process.env[name] = previous;
}

test("worker args increment crew depth and preserve max depth for recursive subagents", () => {
	const result = buildPiWorkerArgs({ task: "recursive", agent, maxDepth: 2, env: { PI_CREW_DEPTH: "1" } as NodeJS.ProcessEnv });
	assert.equal(result.env.PI_CREW_DEPTH, "2");
	assert.equal(result.env.PI_CREW_MAX_DEPTH, "2");
	assert.equal(result.env.PI_TEAMS_DEPTH, "2");
	assert.equal(result.env.PI_TEAMS_MAX_DEPTH, "2");
	assert.equal(result.env.PI_CREW_ROLE, "executor");
});

test("worker args pass safe thinking separately when inheriting parent model", () => {
	const result = buildPiWorkerArgs({ task: "think", agent: { ...agent, thinking: "medium" } });
	assert.equal(result.args.includes("--model"), false);
	const index = result.args.indexOf("--thinking");
	assert.ok(index >= 0);
	assert.equal(result.args[index + 1], "medium");
});

test("worker args pass any valid thinking level when inheriting parent model", () => {
	const result = buildPiWorkerArgs({ task: "think", agent: { ...agent, thinking: "high" } });
	assert.equal(result.args.includes("--model"), false);
	const index = result.args.indexOf("--thinking");
	assert.ok(index >= 0);
	assert.equal(result.args[index + 1], "high");
});

test("worker args ignore invalid thinking levels when inheriting parent model", () => {
	const result = buildPiWorkerArgs({ task: "think", agent: { ...agent, thinking: "wrong" } });
	assert.equal(result.args.includes("--model"), false);
	assert.equal(result.args.includes("--thinking"), false);
});

test("worker args pass selected skill paths explicitly even with inherited skill discovery disabled", () => {
	const result = buildPiWorkerArgs({ task: "skills", agent, skillPaths: ["/tmp/pi-crew-skill-a", "/tmp/pi-crew-skill-b"] });
	assert.ok(result.args.includes("--no-skills"));
	const skillIndexes = result.args.map((value, index) => value === "--skill" ? index : -1).filter((index) => index >= 0);
	assert.deepEqual(skillIndexes.map((index) => result.args[index + 1]), ["/tmp/pi-crew-skill-a", "/tmp/pi-crew-skill-b"]);
});

test("recursive child worker at max depth is blocked before provider execution", async () => {
	const previousDepth = process.env.PI_CREW_DEPTH;
	const previousMax = process.env.PI_CREW_MAX_DEPTH;
	const previousMock = process.env.PI_TEAMS_MOCK_CHILD_PI;
	process.env.PI_CREW_DEPTH = "2";
	process.env.PI_CREW_MAX_DEPTH = "2";
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "success";
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-subagent-depth-"));
	try {
		assert.deepEqual(checkCrewDepth(undefined), { depth: 2, maxDepth: 2, blocked: true });
		const result = await runChildPi({ cwd, task: "should not execute", agent });
		assert.equal(result.exitCode, 1);
		assert.equal(result.stdout, "");
		assert.match(result.stderr, /depth guard blocked child worker: depth 2 >= max 2/);
	} finally {
		restoreEnv("PI_CREW_DEPTH", previousDepth);
		restoreEnv("PI_CREW_MAX_DEPTH", previousMax);
		restoreEnv("PI_TEAMS_MOCK_CHILD_PI", previousMock);
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("subagent manager surfaces recursive depth guard errors from the runner", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-subagent-manager-depth-"));
	try {
		const manager = new SubagentManager();
		const record = manager.spawn({ cwd, type: "executor", description: "recursive depth", prompt: "nested", background: false }, async () => ({ content: [{ type: "text", text: "pi-crew depth guard blocked child worker: depth 2 >= max 2" }], isError: true, details: { action: "run", status: "error" } }));
		await manager.waitForRecord(record.id);
		const final = manager.getRecord(record.id)!;
		assert.equal(final.status, "error");
		assert.match(final.error ?? "", /depth guard blocked child worker/);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
