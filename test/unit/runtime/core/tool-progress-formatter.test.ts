import assert from "node:assert/strict";
import test from "node:test";
import type { CrewAgentRecord } from "../../../../src/runtime/crew-agent-runtime.ts";
import type { TeamTaskState } from "../../../../src/state/types.ts";
import { asCrewTheme } from "../../../../src/ui/theme-adapter.ts";
import { formatCompactToolProgress, PROGRESS_FORMAT, parseCompactToolProgress } from "../../../../src/ui/tool-progress-formatter.ts";
import { teamToolRenderer } from "../../../../src/ui/tool-renderers/index.ts";

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

// ── M1-12 (audit P1-13): producer ↔ consumer contract ────────────────

function makeTask(id: string, status: TeamTaskState["status"]): TeamTaskState {
	return { id, runId: "run-1", role: "explorer", agent: "explorer", title: id, status, dependsOn: [], cwd: "/tmp" } as TeamTaskState;
}

/** The producer's richest output: header + tally + active worker + tool row. */
function richProgressText(): string {
	return formatCompactToolProgress({
		agentId: "agent_rt",
		status: "running",
		runId: "run-rt",
		// 4.5s of elapsed rounds to 5s and stays 5 for another ~1s, so the
		// assertion below has scheduling slack on a loaded machine.
		startedAt: Date.now() - 4500,
		tasks: [
			makeTask("t1", "completed"),
			makeTask("t2", "completed"),
			makeTask("t3", "running"),
			makeTask("t4", "running"),
			makeTask("t5", "queued"),
		],
		agents: [
			makeAgent({
				status: "running",
				progress: { recentTools: [], recentOutput: [], toolCount: 3, turns: 5, currentTool: "Read", tokens: 2400 },
			}),
		],
	});
}

test("M1-12: round-trip — producer output parses back to every structured field", () => {
	const text = richProgressText();
	const parsed = parseCompactToolProgress(text);
	assert.ok(parsed, `parser returned null for producer output:\n${text}`);
	assert.deepEqual(parsed, {
		elapsedMs: 5000,
		status: "running",
		completed: 2,
		total: 5,
		activeAgent: "explorer/explorer",
		currentTool: "Read",
		turns: 5,
		tokens: 2400,
	});
});

test("M1-12: the emitted wire format is pinned (golden lines)", () => {
	// Trip-wire for "one field of the format changed": producer and parser share
	// PROGRESS_FORMAT, so drift between them is structurally impossible — this
	// golden makes any wire-format change a conscious, reviewed edit instead.
	const lines = richProgressText().split("\n");
	assert.match(lines[0] ?? "", /^agent=agent_rt status=running elapsed=5s$/);
	assert.equal(lines[1], "  tasks 2/5 done completed=2 running=2 queued=1");
	assert.equal(lines[2], "  explorer->explorer turn=5 tokens=2400");
	assert.equal(lines[3], "  tool: Read (#3)");
});

test("M1-12: the producer emits exactly the tokens declared in PROGRESS_FORMAT", () => {
	const text = richProgressText();
	const tokens = [
		PROGRESS_FORMAT.agentKey,
		PROGRESS_FORMAT.statusKey,
		PROGRESS_FORMAT.elapsedKey,
		PROGRESS_FORMAT.tasksKey,
		PROGRESS_FORMAT.doneWord,
		PROGRESS_FORMAT.roleSeparator,
		PROGRESS_FORMAT.turnKey,
		PROGRESS_FORMAT.tokensKey,
		PROGRESS_FORMAT.toolKey,
	];
	for (const token of tokens) {
		assert.ok(text.includes(token), `producer output must contain contract token '${token}':\n${text}`);
	}
	assert.ok(/elapsed=\d+s/.test(text), `elapsed must use the declared unit '${PROGRESS_FORMAT.elapsedUnit}':\n${text}`);
});

test("M1-12: the team renderer consumes the contract (partial card shows the parsed tally)", () => {
	// Drives producer → shared parser → card. If either side changes a format
	// token without the other, the counts disappear from the rendered card.
	const text = richProgressText();
	const component = teamToolRenderer.renderResult(
		{ details: { action: "run" }, content: [{ type: "text", text }] },
		{ isPartial: true },
		asCrewTheme({}),
		{ expanded: false, width: 80 },
	);
	const rendered = ((component as unknown as { render?: (w: number) => string[] }).render?.(80) ?? []).join("\n");
	assert.ok(rendered.includes("2/5"), `partial card lost the task tally:\n${rendered}`);
	assert.ok(rendered.includes("Read"), `partial card lost the current tool:\n${rendered}`);
});

test("M1-12: parser returns null for text with no elapsed/task signal", () => {
	assert.equal(parseCompactToolProgress(""), null);
	assert.equal(parseCompactToolProgress("just some prose"), null);
	// The status-only header still parses (status row in the card).
	assert.deepEqual(parseCompactToolProgress("team status=starting elapsed=11s"), {
		elapsedMs: 11000,
		status: "starting",
		completed: null,
		total: null,
		activeAgent: null,
		currentTool: null,
		turns: null,
		tokens: null,
	});
	// Legacy bucket form (no N/M tally) keeps deriving total = done + remaining.
	const legacy = parseCompactToolProgress("team elapsed=3s\n  tasks completed=2 running=1");
	assert.equal(legacy?.completed, 2);
	assert.equal(legacy?.total, 3);
});
