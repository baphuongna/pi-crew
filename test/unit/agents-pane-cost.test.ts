import test from "node:test";
import assert from "node:assert/strict";
import { renderAgentsPane } from "../../src/ui/dashboard-panes/agents-pane.ts";
import type { RunUiSnapshot } from "../../src/ui/snapshot-types.ts";

/**
 * Round 17 BS-1: per-agent cost must surface in the dashboard agents pane.
 * The data lives on task.usage.cost; before this fix only tokens+duration
 * were shown, so a user had no idea how much money each agent burned.
 */
function makeSnapshot(agents: Array<{ id: string; status: string; role: string; usage?: { cost?: number; input?: number; output?: number } }>): RunUiSnapshot {
	return {
		runId: "team_test",
		status: "running",
		team: "default",
		workflow: "default",
		goal: "test",
		progress: { total: agents.length, completed: agents.filter((a) => a.status === "completed").length, running: 0, failed: 0, queued: 0 },
		tasks: [],
		agents: agents.map((a) => ({
			id: a.id,
			taskId: a.id,
			status: a.status as "completed",
			role: a.role,
			agent: a.role,
			runtime: "child-process",
			usage: a.usage,
		})),
	} as unknown as RunUiSnapshot;
}

test("agents pane shows per-agent cost when usage.cost > 0", () => {
	const lines = renderAgentsPane(makeSnapshot([
		{ id: "01_ex", status: "completed", role: "explorer", usage: { input: 1000, output: 500, cost: 0.0123 } },
	]));
	const text = lines.join("\n");
	assert.match(text, /\$0\.0123/, "cost should be formatted and shown");
});

test("agents pane still shows tokens even when cost is 0/missing", () => {
	const lines = renderAgentsPane(makeSnapshot([
		{ id: "01_ex", status: "completed", role: "explorer", usage: { input: 5000, output: 1000 } },
	]));
	const text = lines.join("\n");
	assert.match(text, /6\.0k/, "token total should show");
});

test("agents pane omits cost line entirely when usage is absent", () => {
	const lines = renderAgentsPane(makeSnapshot([
		{ id: "01_ex", status: "running", role: "explorer" },
	]));
	const text = lines.join("\n");
	assert.ok(!/\$0\.\d/.test(text), "no fractional dollar amounts when no usage");
});
