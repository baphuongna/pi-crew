import assert from "node:assert/strict";
import test from "node:test";
import type { CrewAgentRecord } from "../../../../src/runtime/crew-agent-runtime.ts";
import { formatCompactToolProgress } from "../../../../src/ui/tool-progress-formatter.ts";

function makeAgent(overrides: Partial<CrewAgentRecord> = {}): CrewAgentRecord {
	return {
		id: "agent_test_1",
		runId: "run-1",
		taskId: "task-1",
		agent: "explorer",
		role: "explorer",
		runtime: "child-process",
		status: "running",
		startedAt: new Date().toISOString(),
		...overrides,
	} as CrewAgentRecord;
}

test("formatCompactToolProgress renders 'waiting for run' when no run yet", () => {
	const text = formatCompactToolProgress({
		agentId: "agent_a",
		status: "running",
		startedAt: Date.now(),
	});
	const lines = text.split("\n");
	assert.equal(lines[0]?.startsWith("agent=agent_a status=running"), true);
	assert.match(lines[1] ?? "", /waiting for run to start/);
});

test("formatCompactToolProgress renders run header before agent record materializes", () => {
	const text = formatCompactToolProgress({
		agentId: "agent_b",
		status: "running",
		runId: "run-xyz",
		startedAt: Date.now(),
		tasks: [],
	});
	assert.match(text, /run=run-xyz \(starting\)/);
});

test("formatCompactToolProgress surfaces active agent role, turn count, current tool", () => {
	const text = formatCompactToolProgress({
		agentId: "agent_c",
		status: "running",
		runId: "run-1",
		startedAt: Date.now(),
		agents: [
			makeAgent({
				status: "running",
				progress: {
					recentTools: [],
					recentOutput: [],
					toolCount: 3,
					turns: 5,
					currentTool: "Read",
					tokens: 1234,
				},
			}),
		],
	});
	const lines = text.split("\n");
	assert.match(lines[1] ?? "", /explorer->explorer turn=5 tokens=1234/);
	assert.match(lines[2] ?? "", /tool: Read \(#3\)/);
});

test("formatCompactToolProgress trims long recent output and falls back to usage tokens", () => {
	const longText = "a".repeat(200);
	const text = formatCompactToolProgress({
		agentId: "agent_d",
		status: "running",
		runId: "run-1",
		startedAt: Date.now(),
		agents: [
			makeAgent({
				progress: {
					recentTools: [],
					recentOutput: [longText],
					toolCount: 1,
					turns: 1,
				},
				usage: { input: 100, output: 50, cost: 0, turns: 1 } as never,
			}),
		],
	});
	const lines = text.split("\n");
	assert.match(lines[1] ?? "", /tokens=150/);
	const last = lines.at(-1) ?? "";
	assert.equal(last.endsWith("..."), true);
	assert.ok(last.length <= 84);
});

test("formatCompactToolProgress shows error when no active agent and no run", () => {
	const text = formatCompactToolProgress({
		agentId: "agent_e",
		status: "error",
		startedAt: Date.now(),
		error: "spawn failed: pi binary not found",
	});
	assert.match(text, /error: spawn failed: pi binary not found/);
});
