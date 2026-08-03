import assert from "node:assert/strict";
import { test } from "node:test";
import { buildWidgetLines } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

const FAKE_CWD = "/tmp/pi-crew-widget-truncate-test";

function makeFakeRun(overrides?: { description?: string; recentOutput?: string[] }): WidgetRun {
	// Minimal mock — only fields exercised by buildWidgetLines are real.
	// Other required TeamRunManifest / CrewAgentRecord fields are filled with
	// stubs that the renderer never reads; cast to satisfy the type checker.
	const run = {
		schemaVersion: 1,
		runId: "run_e56753a9abcdef00",
		team: "parallel-research",
		workflow: "parallel-research",
		goal: "Read harness archives",
		status: "running" as const,
		startedAt: new Date().toISOString(),
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		workspaceMode: "single" as const,
		ownerSessionId: "session_test",
		sessionGeneration: 1,
		conversationId: "conv_test",
		cwd: FAKE_CWD,
		stateRoot: FAKE_CWD,
		artifactsRoot: FAKE_CWD,
		tasksPath: "/tmp/tasks.jsonl",
		eventsPath: "/tmp/events.jsonl",
		pendingTasks: [],
		artifacts: {} as never,
	};
	const agents = [
		{
			id: "agent_a",
			runId: run.runId,
			agent: "explorer",
			role: "explorer",
			taskId: "task_1",
			status: "running" as const,
			startedAt: new Date(Date.now() - 180_000).toISOString(),
			prompt: overrides?.description ?? "explore",
			runtime: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
			} as never,
			progress: overrides?.recentOutput ? { currentTool: "read", recentOutput: overrides.recentOutput } : { currentTool: "bash" },
		},
	];
	return { run, agents, snapshot: undefined } as unknown as WidgetRun;
}

test("buildWidgetLines: every rendered line is <= width (no TUI overflow)", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	const width = 100;
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, width);
	for (const [i, line] of lines.entries()) {
		const visible = stripAnsi(line).length;
		assert.ok(visible <= width, `line ${i} width ${visible} exceeds terminal width ${width}: ${JSON.stringify(line.slice(0, 80))}…`);
	}
});

test("buildWidgetLines: 200-char task description does NOT overflow width", () => {
	// Reproduces the actual crash: pi-audit task with `| S7: ... | ⬜ pending | |`
	// style description that escaped the 60-char agentActivity cap.
	const longDesc = "| S7: pi-audit security test | ⬜ pending | | " + "A".repeat(180);
	const runs: WidgetRun[] = [
		makeFakeRun({
			description: longDesc,
			recentOutput: ["reading file: " + "x".repeat(80)],
		}),
	];
	const width = 159; // matches the actual crash terminal width
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, width);
	assert.ok(lines.length > 0);
	for (const [i, line] of lines.entries()) {
		const visible = stripAnsi(line).length;
		assert.ok(visible <= width, `CRASH-GUARD: line ${i} width ${visible} > terminal ${width}: ${JSON.stringify(line.slice(0, 80))}…`);
	}
});

test("buildWidgetLines: monotone in width (wider = never shorter content)", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	const narrow = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 60);
	const wide = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0, 160);
	assert.ok(stripAnsi(narrow[0]!).length <= 60, "narrow header fits");
	assert.ok(stripAnsi(wide[0]!).length <= 160, "wide header fits");
	assert.ok(stripAnsi(wide[0]!).length >= stripAnsi(narrow[0]!).length, "wider width never produces a shorter visible header");
});

test("buildWidgetLines: missing width param still works (default fallback)", () => {
	const runs: WidgetRun[] = [makeFakeRun()];
	// No width passed -> falls back to DEFAULT_WIDGET_WIDTH (100).
	const lines = buildWidgetLines(FAKE_CWD, 0, 20, runs, 0);
	assert.ok(lines.length > 0);
	for (const [i, line] of lines.entries()) {
		const visible = stripAnsi(line).length;
		assert.ok(visible <= 100, `default-width fallback: line ${i} = ${visible} > 100: ${JSON.stringify(line.slice(0, 80))}…`);
	}
});

import { DEFAULT_WIDGET_WIDTH, getRenderWidth } from "../../../src/ui/widget/index.ts";

test("getRenderWidth: explicit positive width wins over everything", () => {
	assert.equal(getRenderWidth(80), 80);
	assert.equal(getRenderWidth(159), 159);
	assert.equal(getRenderWidth(80.7), 80, "floors fractional values");
});

test("getRenderWidth: undefined width falls back to process.stdout.columns", () => {
	const cols = (globalThis as { process?: { stdout?: { columns?: number } } }).process?.stdout?.columns;
	if (typeof cols === "number" && cols > 0) {
		assert.equal(getRenderWidth(), Math.floor(cols));
	} else {
		// No real stdout (test runner pipes) → falls through to DEFAULT_WIDGET_WIDTH.
		assert.equal(getRenderWidth(), DEFAULT_WIDGET_WIDTH);
	}
});

test("getRenderWidth: invalid (NaN/0/negative) input falls back to DEFAULT_WIDGET_WIDTH", () => {
	assert.equal(getRenderWidth(NaN), DEFAULT_WIDGET_WIDTH);
	assert.equal(getRenderWidth(0), DEFAULT_WIDGET_WIDTH);
	assert.equal(getRenderWidth(-5), DEFAULT_WIDGET_WIDTH);
	assert.equal(getRenderWidth(undefined), getRenderWidth(), "undefined is also invalid → same fallback");
});

// Cheap ANSI stripper for visible-width assertion. Sufficient for the
// widget's output which uses a known subset of SGR codes + OSC 8.
function stripAnsi(s: string): string {
	return s
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\u001b\]\d+;[^\u0007]*\u0007/g, "")
		.replace(/\u0007/g, "");
}
