// R3-1 (Pi 1.0.0 deep-learn round 3): the run-static worker header (Protocol
// block, mailbox contract, workspace structure, runtime context) moves from the
// user-message concatenation to the `--append-system-prompt` channel, because
// compaction summarizes the user-message span while the system prompt survives
// (compaction.md:150-160). Channel move ONLY — content is preserved byte-for-
// byte; the task text + dependency context stay in the user message (they
// SHOULD be summarizable).
//
// Probe evidence (2026-10-04, /tmp/pi-r3impl): `--append-system-prompt` and
// AGENTS.md discovery coexist in one system message (addendum + project_context
// sections), exit 0 — the coexistence condition from the review is satisfied.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildPiWorkerArgs, cleanupTempDir } from "../../../../src/runtime/model/pi-args.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "test-agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

const HEADER = ["# pi-crew Worker Runtime Context", "Run ID: run_x", "Protocol:", "- Do not claim completion without evidence."].join("\n");
const TASK = "Task ID: 01_agent\n\nTask:\nDo the work.";

function readArgValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx === -1 ? undefined : (args[idx + 1] as string | undefined);
}

test("R3-1: systemPromptAppend rides its own --append-system-prompt file", () => {
	const built = buildPiWorkerArgs({ task: TASK, agent: agent(), systemPromptAppend: HEADER });
	try {
		const headerPath = readArgValue(built.args, "--append-system-prompt");
		assert.ok(headerPath, "--append-system-prompt flag must be present");
		assert.equal(fs.readFileSync(headerPath, "utf8"), HEADER, "header file content must be byte-identical (channel move, not rewrite)");
		// The user message (task.md inclusion) must NOT carry the header anymore.
		const taskPath = built.args.find((a) => a.startsWith("@"))?.slice(1);
		assert.ok(taskPath, "task @-inclusion must exist");
		const taskContent = fs.readFileSync(taskPath, "utf8");
		assert.equal(taskContent, TASK, "user message = task text only");
		assert.ok(!taskContent.includes("Run ID: run_x"), "run-static header must not ride the user message");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});

test("R3-1: replace-mode agent.systemPrompt keeps its semantics; header appends AFTER it", () => {
	const built = buildPiWorkerArgs({
		task: TASK,
		agent: agent({ systemPrompt: "AGENT-PROMPT-BODY", systemPromptMode: "replace" }),
		systemPromptAppend: HEADER,
	});
	try {
		const agentPath = readArgValue(built.args, "--system-prompt");
		assert.ok(agentPath, "replace-mode agent keeps --system-prompt");
		assert.equal(fs.readFileSync(agentPath, "utf8"), "AGENT-PROMPT-BODY");
		const headerPath = readArgValue(built.args, "--append-system-prompt");
		assert.ok(headerPath, "header still rides the append channel in replace mode");
		// pi parses the two flags independently; appends join in argv order →
		// final order: agent prompt (replacing builtin) → run-static header.
		assert.ok(built.args.indexOf("--system-prompt") < built.args.indexOf("--append-system-prompt"), "agent flag precedes header flag");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});

test("R3-1: append-mode agent.systemPrompt + header → two append flags in order", () => {
	const built = buildPiWorkerArgs({
		task: TASK,
		agent: agent({ systemPrompt: "AGENT-PROMPT-BODY", systemPromptMode: "append" }),
		systemPromptAppend: HEADER,
	});
	try {
		const agentPath = readArgValue(built.args, "--append-system-prompt");
		assert.ok(agentPath && fs.readFileSync(agentPath, "utf8") === "AGENT-PROMPT-BODY", "agent append flag present");
		// Exactly two --append-system-prompt occurrences (agent + header), agent first.
		const positions = built.args.flatMap((a, i) => (a === "--append-system-prompt" ? [i] : []));
		assert.equal(positions.length, 2, "agent append + header append");
		const headerPath = built.args[positions[1]! + 1] as string;
		assert.equal(fs.readFileSync(headerPath, "utf8"), HEADER, "second append flag carries the header");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});

test("R3-1: no systemPromptAppend → argv unchanged (back-compat)", () => {
	const built = buildPiWorkerArgs({ task: TASK, agent: agent() });
	try {
		assert.ok(!built.args.includes("--append-system-prompt"), "no header input → no append flag");
		assert.ok(!built.args.includes("--system-prompt"), "no agent prompt → no replace flag");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});

test("R3-1: whitespace-only systemPromptAppend is ignored", () => {
	const built = buildPiWorkerArgs({ task: TASK, agent: agent(), systemPromptAppend: "   \n\t " });
	try {
		assert.ok(!built.args.includes("--append-system-prompt"), "blank header must not create a flag");
	} finally {
		cleanupTempDir(built.tempDir);
	}
});
