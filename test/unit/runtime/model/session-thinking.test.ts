import assert from "node:assert/strict";
import test from "node:test";
import type { AgentConfig } from "../../../../src/agents/agent-config.ts";
import { buildPiWorkerArgs } from "../../../../src/runtime/model/pi-args.ts";

/**
 * [H1.a] Tests for teamRole.thinking (thinkingOverride) wiring through
 * buildPiWorkerArgs. Team-role thinking must take precedence over
 * agent.thinking, consistent with model precedence.
 *
 * The full dispatch chain (team-runner → task-runner → child-executor →
 * runWorker → prepareSpawnContext → buildPiWorkerArgs) is structurally
 * wired: TaskRunnerInput.teamRoleThinking flows through ChildPiRunInput.
 * thinkingOverride into BuildPiWorkerArgsInput.thinkingOverride. Here we
 * test the pure-function boundary (buildPiWorkerArgs) where the actual
 * arg construction happens.
 */

const baseAgent: AgentConfig = {
	name: "test-agent",
	description: "Test agent",
	source: "builtin",
	filePath: "test.md",
	systemPrompt: "",
};

// ─── thinkingOverride with model resolved → suffix appended ──────────────

test("thinkingOverride=high + agent.thinking=undefined + model set → model suffix is :high", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent, model: "anthropic/claude-sonnet" },
		thinkingOverride: "high",
	});
	const modelIdx = result.args.indexOf("--model");
	assert.notEqual(modelIdx, -1, "--model flag must be present");
	assert.equal(result.args[modelIdx + 1], "anthropic/claude-sonnet:high", "thinkingOverride 'high' should be appended as model suffix");
});

test("thinkingOverride=undefined + agent.thinking=low + model set → model suffix is :low (fallback)", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent, model: "anthropic/claude-sonnet", thinking: "low" },
	});
	const modelIdx = result.args.indexOf("--model");
	assert.notEqual(modelIdx, -1, "--model flag must be present");
	assert.equal(result.args[modelIdx + 1], "anthropic/claude-sonnet:low", "agent.thinking 'low' should be used when no thinkingOverride");
});

test("thinkingOverride=high + agent.thinking=low + model set → model suffix is :high (teamRole wins)", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent, model: "anthropic/claude-sonnet", thinking: "low" },
		thinkingOverride: "high",
	});
	const modelIdx = result.args.indexOf("--model");
	assert.notEqual(modelIdx, -1, "--model flag must be present");
	assert.equal(result.args[modelIdx + 1], "anthropic/claude-sonnet:high", "thinkingOverride 'high' must win over agent.thinking 'low'");
});

// ─── thinkingOverride with NO model resolved → --thinking arg pushed ─────

test("thinkingOverride=high + agent.thinking=undefined + no model → --thinking arg is high", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent }, // no model
		thinkingOverride: "high",
	});
	const thinkingIdx = result.args.indexOf("--thinking");
	assert.notEqual(thinkingIdx, -1, "--thinking flag must be present when no model");
	assert.equal(result.args[thinkingIdx + 1], "high");
});

test("thinkingOverride=high + agent.thinking=low + no model → --thinking is high (teamRole wins)", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent, thinking: "low" }, // no model, agent has thinking
		thinkingOverride: "high",
	});
	const thinkingIdx = result.args.indexOf("--thinking");
	assert.notEqual(thinkingIdx, -1, "--thinking flag must be present when no model");
	assert.equal(result.args[thinkingIdx + 1], "high", "thinkingOverride must win");
});

// ─── no thinking at all → no thinking suffix or flag ────────────────────

test("thinkingOverride=undefined + agent.thinking=undefined + model set → no thinking suffix", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent, model: "anthropic/claude-sonnet" },
	});
	const modelIdx = result.args.indexOf("--model");
	assert.notEqual(modelIdx, -1, "--model flag must be present");
	assert.equal(result.args[modelIdx + 1], "anthropic/claude-sonnet", "no suffix when no thinking configured");
});

// ─── thinkingOverride=off explicitly disables thinking ─────────────────

test("thinkingOverride=off suppresses thinking even when agent.thinking=high", () => {
	const result = buildPiWorkerArgs({
		task: "do thing",
		agent: { ...baseAgent, model: "anthropic/claude-sonnet", thinking: "high" },
		thinkingOverride: "off",
	});
	const modelIdx = result.args.indexOf("--model");
	assert.notEqual(modelIdx, -1, "--model flag must be present");
	assert.equal(result.args[modelIdx + 1], "anthropic/claude-sonnet", "'off' thinking must not append suffix");
});
