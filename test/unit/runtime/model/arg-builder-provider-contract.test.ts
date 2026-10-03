/**
 * W3 (Pi 1.0.0 adoption — provider/model audit): argv contract tests.
 *
 * Audit result (verified by two independent explorers + this lane's grep):
 * pi-crew emits `--provider` at ZERO sites today. Pi 1.0.0 ERRORS on
 * `--provider` without `--model` (SDK docs/cli.md:63-64), so this suite pins
 * the invariant preventively across EVERY argv-producing path:
 *
 *   1. buildPiWorkerArgs — the single worker-argv flag builder, across an
 *      input matrix (model set/unset, thinking variants, tool loadouts,
 *      session flags — the W2 addition).
 *   2. stripHeadlessModeArgs (surface-spawn.ts) — the only argv-rewriting
 *      step (removes exactly the `--mode json -p` cluster); it must never
 *      introduce `--provider` nor strip `--model` while keeping `--provider`.
 *
 * Invariant: `argv.includes("--provider") ⇒ argv.includes("--model")`.
 * If provider support is added intentionally one day, extend the matrix here
 * so every provider-emitting input also pins its model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { type BuildPiWorkerArgsInput, buildPiWorkerArgs, cleanupTempDir } from "../../../../src/runtime/model/pi-args.ts";
import { stripHeadlessModeArgs } from "../../../../src/runtime/surface/surface-spawn.ts";

function agent(fields: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "contract-agent",
		description: "test",
		source: "dynamic",
		filePath: "/test",
		systemPrompt: "",
		...fields,
	} as AgentConfig;
}

function build(overrides: Partial<BuildPiWorkerArgsInput>): string[] {
	const result = buildPiWorkerArgs({ task: "contract probe", agent: agent(), ...overrides });
	try {
		return result.args;
	} finally {
		cleanupTempDir(result.tempDir);
	}
}

/** The W3 invariant: --provider may never appear without --model. */
function assertProviderModelInvariant(argv: string[], label: string): void {
	const hasProvider = argv.includes("--provider");
	const hasModel = argv.includes("--model");
	assert.ok(!hasProvider || hasModel, `${label}: --provider without --model is a hard error in pi 1.0.0 — argv: ${JSON.stringify(argv)}`);
}

/** Input matrix covering every flag-emitting branch of the builder. */
function builderMatrix(): { label: string; input: Partial<BuildPiWorkerArgsInput> }[] {
	return [
		{ label: "defaults (no model)", input: {} },
		{ label: "model set", input: { model: "anthropic/claude-x" } },
		{ label: "agent-carried model + thinking", input: { agent: agent({ model: "openai/gpt-x", thinking: "high" }) } },
		{ label: "thinking override without model (separate --thinking)", input: { thinkingOverride: "low" } },
		{ label: "disableTools", input: { agent: agent({ disableTools: true }) } },
		{ label: "declared tools + disallowed", input: { agent: agent({ tools: ["read", "grep"], disallowedTools: ["bash"] }) } },
		{ label: "no-skills + skills paths", input: { agent: agent({ inheritSkills: false }), skillPaths: ["/tmp/skill"] } },
		{ label: "extensions + denylist", input: { agent: agent({ extensions: ["/tmp/ext.ts"], excludeExtensions: ["other"] }) } },
		{ label: "system-prompt replace", input: { agent: agent({ systemPrompt: "be brief" }) } },
		{ label: "system-prompt append mode", input: { agent: agent({ systemPrompt: "be brief", systemPromptMode: "append" }) } },
		{ label: "session disabled", input: { sessionEnabled: false } },
		{ label: "W2 session flags", input: { sessionId: "t1", sessionDir: "/tmp/d" } },
		{ label: "role + maxDepth", input: { role: "reviewer", maxDepth: 3 } },
	];
}

test("W3 audit fact: buildPiWorkerArgs never emits --provider (zero sites)", () => {
	for (const { label, input } of builderMatrix()) {
		const argv = build(input);
		assert.equal(argv.includes("--provider"), false, `${label}: builder must not emit --provider (audit: 0 sites in src/)`);
	}
});

test("W3 invariant: no builder output may carry --provider without --model", () => {
	for (const { label, input } of builderMatrix()) {
		assertProviderModelInvariant(build(input), `builder[${label}]`);
	}
});

test("W3 invariant: stripHeadlessModeArgs never introduces --provider and preserves the pairing", () => {
	for (const { label, input } of builderMatrix()) {
		const built = build(input);
		const stripped = stripHeadlessModeArgs(built);
		assert.equal(stripped.includes("--provider"), false, `strip[${label}]: must not introduce --provider`);
		assertProviderModelInvariant(stripped, `strip[${label}]`);
		// The strip removes exactly the `--mode json -p` cluster — anything else
		// it removes/keeps must not change the provider/model relationship.
		if (built.includes("--model")) assert.ok(stripped.includes("--model"), `strip[${label}]: must keep --model`);
	}
});

test("W3 invariant guard: a hypothetical provider-only argv stays detectable through the strip", () => {
	// Defensive probe: if a future builder ever emits provider-without-model,
	// the invariant checker must flag it, and stripHeadlessModeArgs must not
	// accidentally "fix" it by removing --model (it only removes the headless
	// cluster, so the malformed pairing survives visibly to the strip's
	// consumers instead of being silently masked).
	const malformed = ["--mode", "json", "-p", "--provider", "acme", "@/tmp/task.md"];
	const stripped = stripHeadlessModeArgs(malformed);
	assert.ok(stripped.includes("--provider") && !stripped.includes("--model"), "probe fixture must stay provider-only after strip");
	assertProviderModelInvariant(
		stripHeadlessModeArgs(["--mode", "json", "-p", "--provider", "acme", "--model", "m", "@/t.md"]),
		"paired fixture",
	);
});
