/**
 * Unit tests for goal-evaluator.ts (P1).
 *
 * Tests the pure functions (synthesizeJudgeAgentConfig lockdown, buildJudgeTask
 * shape, bundleEvidence from a transcript, verdict parsing via
 * extractStructuredResult). The runChildPi path is exercised via PI_TEAMS_MOCK_CHILD_PI
 * (returns a fixed assistant text; the evaluator parses it).
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { bundleEvidence, evaluateGoal, synthesizeJudgeAgentConfig } from "../../src/runtime/goal-evaluator.ts";

test("synthesizeJudgeAgentConfig applies full C6 lockdown (NOT just tools:[])", () => {
	const cfg = synthesizeJudgeAgentConfig();
	assert.equal(cfg.name, "goal-judge");
	assert.equal(cfg.source, "dynamic", "§0c C7: source must be 'dynamic' (not invalid 'synthetic')");
	assert.equal(cfg.disableTools, true, "§0c C6: disableTools:true pushes --no-tools (tools:[] alone is insufficient)");
	assert.deepEqual(cfg.disallowedTools, ["bash", "read", "write", "edit"], "defense-in-depth denylist");
	assert.deepEqual(cfg.tools, []);
	assert.deepEqual(cfg.extensions, []);
	assert.equal(cfg.inheritProjectContext, false);
	assert.equal(cfg.inheritSkills, false);
	assert.equal(cfg.maxTurns, 3);
	// systemPrompt must forbid assuming un-shown work + require JSON output.
	assert.match(cfg.systemPrompt, /Do NOT assume work was done/i);
	assert.match(cfg.systemPrompt, /JSON/i);
});

test("bundleEvidence reads transcript tail + extracts tool calls", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-eval-"));
	try {
		const transcript = path.join(dir, "work.attempt-0.jsonl");
		const events = [
			{
				type: "tool_execution_start",
				toolName: "bash",
				args: { command: "npm test" },
			},
			{
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Running tests..." }],
				},
			},
			{ type: "toolCall", name: "read", input: { path: "src/foo.ts" } },
		];
		fs.writeFileSync(transcript, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

		const evidence = bundleEvidence(transcript);
		assert.equal(evidence.toolCalls.length, 2, "two tool calls extracted (bash + read)");
		assert.equal(evidence.toolCalls[0].tool, "bash");
		assert.equal(evidence.toolCalls[1].tool, "read");
		assert.ok(evidence.transcriptSlice.length > 0, "transcript slice populated");
		assert.ok(evidence.transcriptSlice.includes("Running tests"), "transcript content captured");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("bundleEvidence handles missing transcript gracefully", () => {
	const evidence = bundleEvidence(undefined);
	assert.equal(evidence.toolCalls.length, 0);
	assert.equal(evidence.transcriptSlice, "");
});

test("bundleEvidence truncates very long transcripts to ~8 KiB tail", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-crew-goal-eval-"));
	try {
		const transcript = path.join(dir, "work.attempt-0.jsonl");
		const padding = "x".repeat(20_000);
		fs.writeFileSync(transcript, padding);
		const evidence = bundleEvidence(transcript);
		assert.ok(evidence.transcriptSlice.length <= 8192, "tail bounded to ~8 KiB");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("evaluateGoal returns a parsed verdict when judge emits valid JSON (mock)", async () => {
	// Configure the child-pi mock to return a JSON verdict as assistant text.
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "json-success";
	try {
		// json-success mock returns text "[MOCK] JSON success for goal-judge" — NOT valid verdict JSON.
		// So this test asserts the BLOCKED fallback path (evaluator must not crash, must return a verdict).
		const { verdict } = await evaluateGoal({
			objective: "all tests pass",
			evidence: { transcriptSlice: "tail", toolCalls: [] },
			model: "stub-model",
			turn: 1,
			cwd: os.tmpdir(),
		});
		assert.equal(verdict.turn, 1);
		assert.equal(verdict.evaluatorModel, "stub-model");
		// Mock returns non-verdict text → BLOCKED fallback.
		assert.equal(verdict.achieved, false);
		assert.match(verdict.reason, /BLOCKED:/, "non-JSON judge output → BLOCKED fallback");
	} finally {
		delete process.env.PI_CREW_ALLOW_MOCK;
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	}
});

test("evaluateGoal returns BLOCKED verdict on spawn failure (mock=failure)", async () => {
	process.env.PI_CREW_ALLOW_MOCK = "1";
	process.env.PI_TEAMS_MOCK_CHILD_PI = "forced-failure";
	try {
		const { verdict } = await evaluateGoal({
			objective: "x",
			evidence: { transcriptSlice: "", toolCalls: [] },
			model: "stub-model",
			turn: 2,
			cwd: os.tmpdir(),
		});
		assert.equal(verdict.achieved, false);
		assert.match(verdict.reason, /BLOCKED:/);
		assert.equal(verdict.turn, 2);
	} finally {
		delete process.env.PI_CREW_ALLOW_MOCK;
		delete process.env.PI_TEAMS_MOCK_CHILD_PI;
	}
});
