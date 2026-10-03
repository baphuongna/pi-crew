/**
 * W2 (Pi 1.0.0 adoption — session-file recovery): builder flag emission.
 *
 * buildPiWorkerArgs must emit `--session-id`/`--session-dir` when the caller
 * provides them (flags predate the tested host floor 0.99.2 — session-id
 * 0.76.0, session-dir 0.30.0 — so NO capability gate, same policy as the
 * existing --no-session/--model emissions), skip them under --no-session
 * (nothing persists → flags meaningless), and leave the argv shape untouched
 * when absent (zero behavior change for legacy callers).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { type BuildPiWorkerArgsInput, buildPiWorkerArgs, cleanupTempDir } from "../../../../src/runtime/model/pi-args.ts";

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

function build(overrides: Partial<BuildPiWorkerArgsInput>) {
	const result = buildPiWorkerArgs({ task: "do the thing", agent: agent(), ...overrides });
	try {
		return result;
	} finally {
		// tempDir cleanup is the caller's job in prod; tests always release it.
		cleanupTempDir(result.tempDir);
	}
}

function argValue(args: string[], flag: string): string | undefined {
	const idx = args.indexOf(flag);
	return idx === -1 ? undefined : args[idx + 1];
}

test("emits --session-id and --session-dir with the provided values", () => {
	const { args } = build({ sessionId: "01_01-agent", sessionDir: "/tmp/run/artifacts/sessions/01_01-agent" });
	assert.equal(argValue(args, "--session-id"), "01_01-agent");
	assert.equal(argValue(args, "--session-dir"), "/tmp/run/artifacts/sessions/01_01-agent");
});

test("flags sit after the --mode json -p cluster and before the task positional", () => {
	const { args } = build({ sessionId: "t1", sessionDir: "/d" });
	const clusterEnd = args.indexOf("-p");
	const flagIdx = args.indexOf("--session-id");
	assert.ok(clusterEnd !== -1 && flagIdx === clusterEnd + 1, "--session-id must directly follow the headless cluster");
	assert.ok(args.findIndex((a) => a.startsWith("@")) > flagIdx, "flags must not trail the task file positional");
});

test("absent session fields leave the argv shape untouched (legacy callers unchanged)", () => {
	const withSession = build({ sessionId: "t1", sessionDir: "/d" }).args;
	const without = build({}).args;
	// Two builds create two task.md temp dirs — normalize the @file token.
	const dropTaskFile = (argv: string[]) => argv.filter((a) => !a.startsWith("@"));
	const expected = [...dropTaskFile(without).slice(0, 3), "--session-id", "t1", "--session-dir", "/d", ...dropTaskFile(without).slice(3)];
	assert.deepEqual(dropTaskFile(withSession), expected);
	assert.equal(without.includes("--session-id"), false);
	assert.equal(without.includes("--session-dir"), false);
});

test("sessionEnabled:false (--no-session) skips the session flags — nothing persists to recover", () => {
	const { args } = build({ sessionEnabled: false, sessionId: "t1", sessionDir: "/d" });
	assert.ok(args.includes("--no-session"));
	assert.equal(args.includes("--session-id"), false);
	assert.equal(args.includes("--session-dir"), false);
});
