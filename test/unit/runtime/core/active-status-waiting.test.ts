import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { taskStatusToAgentStatus } from "../../../../src/runtime/crew-agent-runtime.ts";
import { isActiveRunStatus } from "../../../../src/runtime/process-status.ts";

describe("Active run status includes waiting", () => {
	it("waiting is an active run status", () => {
		assert.equal(isActiveRunStatus("waiting"), true);
	});

	it("queued is an active run status", () => {
		assert.equal(isActiveRunStatus("queued"), true);
	});

	it("running is an active run status", () => {
		assert.equal(isActiveRunStatus("running"), true);
	});

	it("completed is not an active run status", () => {
		assert.equal(isActiveRunStatus("completed"), false);
	});

	it("failed is not an active run status", () => {
		assert.equal(isActiveRunStatus("failed"), false);
	});
});

describe("taskStatusToAgentStatus maps waiting", () => {
	it("maps waiting task to waiting agent", () => {
		assert.equal(taskStatusToAgentStatus("waiting"), "waiting");
	});

	it("maps running task to running agent", () => {
		assert.equal(taskStatusToAgentStatus("running"), "running");
	});

	it("maps queued task to queued agent", () => {
		assert.equal(taskStatusToAgentStatus("queued"), "queued");
	});

	it("maps completed task to completed agent", () => {
		assert.equal(taskStatusToAgentStatus("completed"), "completed");
	});
});
