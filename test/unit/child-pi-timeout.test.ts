import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import test from "node:test";
import type { AgentConfig } from "../../src/agents/agent-config.ts";
import { DEFAULT_CHILD_PI } from "../../src/config/defaults.ts";
import { ChildPiLineObserver } from "../../src/runtime/child-pi.ts";
import { applyThinkingSuffix, buildPiWorkerArgs, checkCrewDepth, cleanupTempDir, currentCrewDepth } from "../../src/runtime/pi-args.ts";

const minimalAgent: AgentConfig = {
	name: "test-agent",
	description: "Test agent",
	source: "builtin",
	filePath: "test.md",
	systemPrompt: "",
};

test("child Pi response timeout allows normal provider think time", () => {
	assert.ok(
		DEFAULT_CHILD_PI.responseTimeoutMs >= 2 * 60_000,
		`expected child response timeout to be at least 2 minutes, got ${DEFAULT_CHILD_PI.responseTimeoutMs}ms`,
	);
});

// --- New tests ---

test("buildPiWorkerArgs includes task in args", () => {
	const result = buildPiWorkerArgs({
		task: "Do the thing",
		agent: minimalAgent,
	});
	assert.ok(result.args.includes("Task: Do the thing"));
	assert.ok(result.args.includes("--mode"));
	assert.ok(result.args.includes("json"));
	assert.ok(result.args.includes("-p"));
});

test("buildPiWorkerArgs includes model from agent config", () => {
	const agentWithModel: AgentConfig = {
		...minimalAgent,
		model: "claude-sonnet-4",
	};
	const result = buildPiWorkerArgs({ task: "test", agent: agentWithModel });
	const modelIdx = result.args.indexOf("--model");
	assert.ok(modelIdx !== -1, "--model flag missing");
	assert.equal(result.args[modelIdx + 1], "claude-sonnet-4");
});

test("buildPiWorkerArgs creates temp file for system prompt", () => {
	const agentWithPrompt: AgentConfig = {
		...minimalAgent,
		systemPrompt: "You are a specialist.",
	};
	const result = buildPiWorkerArgs({ task: "test", agent: agentWithPrompt });
	assert.ok(result.tempDir, "expected tempDir to be created");
	const promptFlagIdx = result.args.indexOf("--system-prompt");
	assert.ok(promptFlagIdx !== -1, "--system-prompt flag missing");
	const promptPath = result.args[promptFlagIdx + 1];
	assert.ok(fs.existsSync(promptPath), "system prompt file should exist");
	assert.equal(fs.readFileSync(promptPath, "utf-8"), "You are a specialist.");
	cleanupTempDir(result.tempDir);
	assert.ok(!fs.existsSync(result.tempDir), "tempDir should be cleaned up");
});

test("buildPiWorkerArgs increments depth in env vars", () => {
	const env = {
		PI_CREW_DEPTH: "1",
		PI_TEAMS_DEPTH: "1",
	} as NodeJS.ProcessEnv;
	const result = buildPiWorkerArgs({
		task: "test",
		agent: minimalAgent,
		env,
	});
	assert.equal(result.env.PI_CREW_DEPTH, "2");
	assert.equal(result.env.PI_TEAMS_DEPTH, "2");
});

test("checkCrewDepth blocks when at max depth", () => {
	const env = {
		PI_CREW_DEPTH: "2",
		PI_CREW_MAX_DEPTH: "2",
	} as NodeJS.ProcessEnv;
	const result = checkCrewDepth(undefined, env);
	assert.equal(result.blocked, true);
	assert.equal(result.depth, 2);
	assert.equal(result.maxDepth, 2);
});

test("checkCrewDepth allows when below max depth", () => {
	const env = {
		PI_CREW_DEPTH: "1",
		PI_CREW_MAX_DEPTH: "3",
	} as NodeJS.ProcessEnv;
	const result = checkCrewDepth(undefined, env);
	assert.equal(result.blocked, false);
	assert.equal(result.depth, 1);
	assert.equal(result.maxDepth, 3);
});

test("checkCrewDepth respects inputMaxDepth when env not set", () => {
	const env = {} as NodeJS.ProcessEnv;
	const result = checkCrewDepth(5, env);
	assert.equal(result.blocked, false);
	assert.equal(result.maxDepth, 5);
});

test("currentCrewDepth parses depth from env", () => {
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "3" } as NodeJS.ProcessEnv), 3);
	assert.equal(currentCrewDepth({ PI_TEAMS_DEPTH: "4" } as NodeJS.ProcessEnv), 4);
	assert.equal(
		currentCrewDepth({
			PI_CREW_DEPTH: "3",
			PI_TEAMS_DEPTH: "4",
		} as NodeJS.ProcessEnv),
		3,
	);
	assert.equal(currentCrewDepth({} as NodeJS.ProcessEnv), 0);
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "abc" } as NodeJS.ProcessEnv), 0);
	assert.equal(currentCrewDepth({ PI_CREW_DEPTH: "-1" } as NodeJS.ProcessEnv), 0);
});

test("applyThinkingSuffix appends valid thinking level", () => {
	assert.equal(applyThinkingSuffix("claude-sonnet-4", "high"), "claude-sonnet-4:high");
	assert.equal(applyThinkingSuffix("claude-sonnet-4", "off"), "claude-sonnet-4");
	assert.equal(applyThinkingSuffix(undefined, "high"), undefined);
	assert.equal(applyThinkingSuffix("model:medium", "high"), "model:medium");
	assert.equal(applyThinkingSuffix("model", "invalid"), "model");
});

test("ChildPiLineObserver emits display text from assistant message", () => {
	const lines: string[] = [];
	const events: unknown[] = [];
	const observer = new ChildPiLineObserver({
		cwd: os.tmpdir(),
		task: "test",
		agent: minimalAgent,
		onStdoutLine: (line) => lines.push(line),
		onJsonEvent: (event) => events.push(event),
	});
	const jsonLine = JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Hello from assistant" }],
		},
	});
	observer.observe(`${jsonLine}\n`);
	observer.flush();
	assert.equal(lines.length, 1);
	assert.equal(lines[0], "Hello from assistant");
	assert.equal(events.length, 1);
});

test("ChildPiLineObserver recognizes final assistant turn end", () => {
	const lines: string[] = [];
	const events: unknown[] = [];
	const observer = new ChildPiLineObserver({
		cwd: os.tmpdir(),
		task: "test",
		agent: minimalAgent,
		onStdoutLine: (line) => lines.push(line),
		onJsonEvent: (event) => events.push(event),
	});
	const messageEnd = JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Done" }],
			stopReason: "stop",
		},
		usage: { input: 10, output: 5 },
	});
	observer.observe(`${messageEnd}\n`);
	observer.flush();
	assert.ok(events.length >= 1, "expected at least one event from message_end");
	const endEvent = events[events.length - 1] as Record<string, unknown>;
	assert.equal(endEvent.type, "message_end");
});
