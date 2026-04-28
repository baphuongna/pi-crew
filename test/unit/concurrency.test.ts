import test from "node:test";
import assert from "node:assert/strict";
import { defaultWorkflowConcurrency, resolveBatchConcurrency } from "../../src/runtime/concurrency.ts";

test("default workflow concurrency preserves existing workflow defaults", () => {
	assert.equal(defaultWorkflowConcurrency("parallel-research"), 4);
	assert.equal(defaultWorkflowConcurrency("research"), 2);
	assert.equal(defaultWorkflowConcurrency("implementation"), 2);
	assert.equal(defaultWorkflowConcurrency("review"), 2);
	assert.equal(defaultWorkflowConcurrency("default"), 2);
	assert.equal(defaultWorkflowConcurrency("unknown"), 1);
	assert.equal(defaultWorkflowConcurrency("review", 6), 6);
	assert.equal(defaultWorkflowConcurrency("unknown", 7), 7);
});

test("limits override team concurrency and ready count caps selected tasks", () => {
	const decision = resolveBatchConcurrency({ workflowName: "parallel-research", teamMaxConcurrency: 4, limitMaxConcurrentWorkers: 1, readyCount: 3 });
	assert.equal(decision.maxConcurrent, 1);
	assert.equal(decision.selectedCount, 1);
	assert.match(decision.reason, /^limit:1/);
});

test("workflow maxConcurrency can replace built-in workflow default when provided", () => {
	const decision = resolveBatchConcurrency({ workflowName: "implementation", workflowMaxConcurrency: 4, readyCount: 10 });
	assert.equal(decision.defaultConcurrency, 4);
	assert.equal(decision.maxConcurrent, 4);
	assert.equal(decision.selectedCount, 4);
	assert.match(decision.reason, /^workflow:4/);
});

test("team concurrency can raise workflow-constrained default when no limit is set", () => {
	const decision = resolveBatchConcurrency({ workflowName: "implementation", workflowMaxConcurrency: 2, teamMaxConcurrency: 4, readyCount: 10 });
	assert.equal(decision.defaultConcurrency, 2);
	assert.equal(decision.maxConcurrent, 4);
	assert.equal(decision.selectedCount, 4);
	assert.match(decision.reason, /^team:4/);
});

test("zero ready tasks selects zero while positive ready tasks select at least one", () => {
	assert.equal(resolveBatchConcurrency({ workflowName: "unknown", readyCount: 0 }).selectedCount, 0);
	assert.equal(resolveBatchConcurrency({ workflowName: "unknown", readyCount: 2 }).selectedCount, 1);
});

test("worker concurrency is capped by default", () => {
	const decision = resolveBatchConcurrency({ workflowName: "parallel-research", limitMaxConcurrentWorkers: 64, readyCount: 64 });
	assert.equal(decision.maxConcurrent, 8);
	assert.equal(decision.selectedCount, 8);
	assert.match(decision.reason, /capped:8/);
});

test("worker concurrency can be explicitly unbounded", () => {
	const decision = resolveBatchConcurrency({ workflowName: "parallel-research", limitMaxConcurrentWorkers: 64, allowUnboundedConcurrency: true, readyCount: 64 });
	assert.equal(decision.maxConcurrent, 64);
	assert.equal(decision.selectedCount, 64);
	assert.match(decision.reason, /unbounded:8/);
});
