import assert from "node:assert/strict";
import test from "node:test";
import { clearAllTaskUsage, getRunUsage, getTaskUsage, trackTaskUsage } from "../../../../src/runtime/usage-tracker.ts";

test("trackTaskUsage accumulates usage for same taskId", () => {
	clearAllTaskUsage();
	trackTaskUsage("task-1", { input: 10, output: 20, cacheWrite: 5 });
	trackTaskUsage("task-1", { input: 5, output: 10, cacheWrite: 3 });
	const usage = getTaskUsage("task-1");
	assert.equal(usage.input, 15);
	assert.equal(usage.output, 30);
	assert.equal(usage.cacheWrite, 8);
});

test("getTaskUsage returns zeros when no usage tracked", () => {
	clearAllTaskUsage();
	const usage = getTaskUsage("nonexistent-task");
	assert.equal(usage.input, 0);
	assert.equal(usage.output, 0);
	assert.equal(usage.cacheWrite, 0);
});

test("getRunUsage aliases getTaskUsage", () => {
	clearAllTaskUsage();
	trackTaskUsage("task-2", { input: 100, output: 50, cacheWrite: 25 });
	assert.deepEqual(getRunUsage("task-2"), getTaskUsage("task-2"));
});

test("clearAllTaskUsage resets all tracked data", () => {
	clearAllTaskUsage();
	trackTaskUsage("task-a", { input: 1 });
	trackTaskUsage("task-b", { output: 2 });
	clearAllTaskUsage();
	assert.deepEqual(getTaskUsage("task-a"), {
		input: 0,
		output: 0,
		cacheWrite: 0,
	});
	assert.deepEqual(getTaskUsage("task-b"), {
		input: 0,
		output: 0,
		cacheWrite: 0,
	});
});

test("concurrent tracking does not lose increments (simulate rapid sequential calls)", () => {
	clearAllTaskUsage();
	const taskId = "rapid-task";
	for (let i = 0; i < 1000; i++) {
		trackTaskUsage(taskId, { input: 1, output: 1, cacheWrite: 1 });
	}
	const usage = getTaskUsage(taskId);
	assert.equal(usage.input, 1000);
	assert.equal(usage.output, 1000);
	assert.equal(usage.cacheWrite, 1000);
});
