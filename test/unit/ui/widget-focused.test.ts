/**
 * Compact dock rendering — the inline panel navigates EVERY agent row, so the
 * dock paints a 3-row SCROLL WINDOW that follows the selection (the ❯ marker
 * must always be on a painted row). Finished agents stay listed while their
 * run is still active, and each row carries the worker's model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { buildWidgetLines, MAX_AGENTS_DISPLAY } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

function agent(taskId: string, overrides: Partial<CrewAgentRecord> = {}): CrewAgentRecord {
	return {
		taskId,
		agent: `agent${taskId.slice(1)}`,
		role: "explorer",
		status: "running",
		startedAt: new Date().toISOString(),
		progress: {},
		...overrides,
	} as CrewAgentRecord;
}

function runWith(agents: CrewAgentRecord[], runStatus = "running"): WidgetRun[] {
	return [
		{
			run: {
				runId: "team_focus_test",
				status: runStatus,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				planApproval: undefined,
			} as never,
			agents,
			snapshot: {} as never,
		},
	];
}

test("idle paint keeps the maxLines cap", () => {
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(Array.from({ length: 12 }, (_, i) => agent(`t${i}`))), 0, 100, {
		rowStyle: "compact",
	});
	assert.ok(lines.length <= 8, `idle must stay within maxLines, got ${lines.length}`);
});

test("dock is a 3-row scroll window that follows the selection", () => {
	const agents = Array.from({ length: 12 }, (_, i) => agent(`t${i + 1}`));
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, {
		rowStyle: "compact",
		focused: true,
		selectedTaskId: "t11", // index 10 — well beyond the first window
	});
	// hint + main + ↑indicator + 3 rows + more-indicator ≤ 7 lines.
	assert.ok(lines.length <= 7, `windowed dock stays compact, got ${lines.length}`);
	const markerRows = lines.filter((line) => line.includes("❯"));
	assert.ok(
		markerRows.some((line) => line.includes("agent11")),
		"marker sits on the selected agent's row (window scrolled to it)",
	);
	assert.ok(
		lines.some((line) => line.includes("↑8 earlier")),
		"earlier rows surface as an ↑ indicator",
	);
	assert.ok(
		lines.some((line) => line.includes("+1 more")),
		"later rows surface as a +more indicator",
	);
	assert.ok(!lines.some((line) => line.includes("agent1 ") || line.includes("agent1·")), "rows above the window are not painted");
	// Exactly MAX_AGENTS_DISPLAY agent rows in the window.
	const agentRows = lines.filter((line) => /agent\d+/.test(line));
	assert.equal(agentRows.length, MAX_AGENTS_DISPLAY, "exactly the 3-row window is painted");
});

test("idle window shows the first 3 agents plus a more indicator", () => {
	const agents = Array.from({ length: 5 }, (_, i) => agent(`t${i + 1}`));
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, { rowStyle: "compact" });
	assert.ok(
		lines.some((line) => line.includes("agent1")),
		"first row painted",
	);
	assert.ok(!lines.some((line) => line.includes("agent4")), "rows past the window are hidden");
	assert.ok(
		lines.some((line) => line.includes("+2 more")),
		"hidden count is indicated",
	);
});

test("finished agents stay in the dock while the run is still active", () => {
	const finished = [agent("t1", { status: "completed", completedAt: new Date(Date.now() - 10 * 60_000).toISOString() })];
	const running = [agent("t2"), agent("t3")];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith([...finished, ...running]), 0, 100, { rowStyle: "compact" });
	// 10-minute-old completion: the old 1-minute linger would have dropped it.
	assert.ok(
		lines.some((line) => line.includes("agent1")),
		"finished agent stays while the run runs",
	);
	assert.ok(
		lines.some((line) => line.includes("✓")),
		"completion glyph painted",
	);
});

test("finished agents age out of the linger window once the run is terminal", () => {
	const finished = [agent("t1", { status: "completed", completedAt: new Date(Date.now() - 10 * 60_000).toISOString() })];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(finished, "completed"), 0, 100, { rowStyle: "compact" });
	assert.ok(!lines.some((line) => line.includes("agent1")), "terminal run: old completion ages out");
});

test("each dock row carries the worker's model", () => {
	const agents = [agent("t1", { model: "zai/glm-5.3" }), agent("t2", { model: "qwencoder/qwen3.7-max" })];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 140, { rowStyle: "compact" });
	assert.ok(
		lines.some((line) => line.includes("glm-5.3")),
		"row shows the short model id",
	);
	assert.ok(
		lines.some((line) => line.includes("qwen3.7-max")),
		"second row shows its own model",
	);
});

test("row falls back to the run-level model when the agent record has none", () => {
	const agents = [agent("t1")];
	const runs = runWith(agents);
	(runs[0]!.run as { modelContext?: { parentModel?: string } }).modelContext = { parentModel: "zai/glm-5.3" };
	const lines = buildWidgetLines("/tmp", 0, 8, runs, 0, 140, { rowStyle: "compact" });
	assert.ok(
		lines.some((line) => line.includes("glm-5.3")),
		"run-level model fills the row",
	);
});

test("viewed agent keeps the ⏺ glyph", () => {
	const agents = [agent("t1"), agent("t2")];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, {
		rowStyle: "compact",
		viewedTaskId: "t2",
	});
	assert.ok(
		lines.some((line) => line.includes("⏺")),
		"viewed agent gets pi-subtask's ⏺ fill glyph",
	);
});

test("compact dock rows use pi-subtask's fixed status icons (no spinner, no tree, no header)", () => {
	const agents = [agent("t1"), agent("t2")];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, { rowStyle: "compact" });
	const joined = lines.join("\n");
	// pi-subtask statusIcon: running ✻, queued ○, done ✓, failed ✗, stopped ■
	assert.ok(joined.includes("✻"), `running agent carries the ✻ icon:\n${joined}`);
	// The dock replaces the legacy header/tree with hint + main.
	assert.ok(!joined.includes("Crew agents"), "no legacy header in compact dock");
	assert.ok(!joined.includes("├─") && !joined.includes("└─"), "no tree branch glyphs in compact dock");
});

test("compact rows render the pi-subtask dock: hint line + main row", () => {
	const agents = [agent("t1"), agent("t2")];

	const idle = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, { rowStyle: "compact" });
	assert.ok(
		idle.some((line) => line.includes("agents (2) — ↓ to select")),
		"idle hint advertises ↓",
	);
	assert.ok(
		idle.some((line) => line.includes("● main")),
		"main row is filled while idle",
	);

	const focusedMain = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, {
		rowStyle: "compact",
		focused: true, // selection === "main": no selectedTaskId
	});
	assert.ok(
		focusedMain.some((line) => line.includes("❯ ● main")),
		"main row carries the cursor marker when selected",
	);
	assert.ok(
		focusedMain.some((line) => line.includes("enter to view · x to stop/cancel · esc back")),
		"focused hint explains the keys",
	);

	const viewed = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, {
		rowStyle: "compact",
		viewedTaskId: "t1",
	});
	assert.ok(
		viewed.some((line) => line.includes("viewing @agent1") && line.includes("↓ switch")),
		"viewing hint names the agent",
	);
	assert.ok(
		viewed.some((line) => line.includes("◯ main")),
		"main row is hollow while viewing an agent",
	);
});

test("detailed rows get no hint/main (no panel navigation there)", () => {
	const agents = [agent("t1"), agent("t2")];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, { rowStyle: "detailed" });
	assert.ok(!lines.some((line) => line.includes("↓ to select")), "no hint in detailed mode");
	assert.ok(!lines.some((line) => line.includes(" main")), "no main row in detailed mode");
});
