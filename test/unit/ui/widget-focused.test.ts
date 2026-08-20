/**
 * Focused-mode widget rendering — the inline panel navigates EVERY agent
 * row, so focused paint must list them all and keep the cursor marker (❯)
 * on rows that are shown. Idle paint keeps the historical maxLines cap.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { buildWidgetLines } from "../../../src/ui/widget/widget-renderer.ts";
import type { WidgetRun } from "../../../src/ui/widget/widget-types.ts";

function agent(taskId: string): CrewAgentRecord {
	return {
		taskId,
		agent: `agent${taskId.slice(1)}`,
		role: "explorer",
		status: "running",
		startedAt: new Date().toISOString(),
		progress: {},
	} as CrewAgentRecord;
}

function runWith(agents: CrewAgentRecord[]): WidgetRun[] {
	return [
		{
			run: {
				runId: "team_focus_test",
				status: "running",
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

test("focused paint lists EVERY agent and keeps the marker reachable", () => {
	const agents = Array.from({ length: 12 }, (_, i) => agent(`t${i + 1}`));
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, {
		rowStyle: "compact",
		focused: true,
		selectedTaskId: "t11", // a row well beyond the idle cap of 3
	});
	// 1 header + 1 run line + 12 agents = 14; focusing must not slice to 8.
	assert.ok(lines.length > 8, `focused must uncap, got ${lines.length} lines`);
	assert.ok(
		lines.some((line) => line.includes("agent11")),
		"the far agent row is painted",
	);
	const markerRows = lines.filter((line) => line.includes("❯"));
	assert.ok(markerRows.length >= 1, `cursor marker must be visible for the selected agent: ${JSON.stringify(lines.slice(0, 3))}`);
	assert.ok(
		markerRows.some((line) => line.includes("agent11")),
		"marker sits on the selected agent's row",
	);
});

test("focused paint still respects the marker for the viewed agent glyph", () => {
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
