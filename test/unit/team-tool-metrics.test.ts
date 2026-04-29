import test from "node:test";
import assert from "node:assert/strict";
import { handleTeamTool } from "../../src/extension/team-tool.ts";
import { createMetricRegistry } from "../../src/observability/metric-registry.ts";
import { textFromToolResult } from "../../src/extension/tool-result.ts";

test("team api metrics-snapshot returns current registry without runId", async () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc({ status: "completed" });
	const result = await handleTeamTool({ action: "api", config: { operation: "metrics-snapshot" } }, { cwd: process.cwd(), metricRegistry: registry });
	const text = textFromToolResult(result);
	assert.match(text, /crew\.run\.count/);
});

test("team api metrics-snapshot filters by glob", async () => {
	const registry = createMetricRegistry();
	registry.counter("crew.run.count", "runs").inc();
	registry.counter("crew.task.count", "tasks").inc();
	const result = await handleTeamTool({ action: "api", config: { operation: "metrics-snapshot", filter: "crew.task.*" } }, { cwd: process.cwd(), metricRegistry: registry });
	const text = textFromToolResult(result);
	assert.match(text, /crew\.task\.count/);
	assert.doesNotMatch(text, /crew\.run\.count/);
});

test("team api metrics-snapshot filters by runId labels", async () => {
	const registry = createMetricRegistry();
	registry.gauge("crew.heartbeat.staleness_ms", "staleness").set({ runId: "run-a", taskId: "task-a" }, 1);
	registry.gauge("crew.task.duration_ms", "duration").set({ runId: "run-b", taskId: "task-b" }, 2);
	const result = await handleTeamTool({ action: "api", config: { operation: "metrics-snapshot", runId: "run-a" } }, { cwd: process.cwd(), metricRegistry: registry });
	const text = textFromToolResult(result);
	assert.match(text, /run-a/);
	assert.doesNotMatch(text, /run-b/);
});
