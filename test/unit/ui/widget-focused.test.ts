/**
 * Compact dock rendering — the inline panel navigates EVERY agent row, so the
 * dock paints a 3-row SCROLL WINDOW that follows the selection (the ❯ marker
 * must always be on a painted row). Finished agents stay listed while their
 * run is still active, and each row carries the worker's model.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { CrewAgentRecord } from "../../../src/runtime/crew-agent-runtime.ts";
import { buildWidgetLines } from "../../../src/ui/widget/widget-renderer.ts";
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
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(Array.from({ length: 12 }, (_, i) => agent(`t${i}`))), 0, 100, {});
	assert.ok(lines.length <= 8, `idle must stay within maxLines, got ${lines.length}`);
});

test("finished agents age out of the linger window once the run is terminal", () => {
	const finished = [agent("t1", { status: "completed", completedAt: new Date(Date.now() - 10 * 60_000).toISOString() })];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(finished, "completed"), 0, 100, {});
	assert.ok(!lines.some((line) => line.includes("agent1")), "terminal run: old completion ages out");
});

test("detailed rows get no hint/main (no panel navigation there)", () => {
	const agents = [agent("t1"), agent("t2")];
	const lines = buildWidgetLines("/tmp", 0, 8, runWith(agents), 0, 100, {});
	assert.ok(!lines.some((line) => line.includes("↓ to select")), "no hint in detailed mode");
	assert.ok(!lines.some((line) => line.includes(" main")), "no main row in detailed mode");
});
