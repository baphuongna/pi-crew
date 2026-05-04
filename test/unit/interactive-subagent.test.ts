import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TEAM_TASK_STATUSES, TEAM_TASK_STATUS_TRANSITIONS, canTransitionTaskStatus, isTerminalTaskStatus } from "../../src/state/contracts.ts";

describe("Interactive subagent task status", () => {
	it("includes waiting in TEAM_TASK_STATUSES", () => {
		assert.ok(TEAM_TASK_STATUSES.includes("waiting"));
	});

	it("running can transition to waiting", () => {
		assert.ok(canTransitionTaskStatus("running", "waiting"));
	});

	it("waiting can transition to running", () => {
		assert.ok(canTransitionTaskStatus("waiting", "running"));
	});

	it("waiting can transition to completed", () => {
		assert.ok(canTransitionTaskStatus("waiting", "completed"));
	});

	it("waiting can transition to failed", () => {
		assert.ok(canTransitionTaskStatus("waiting", "failed"));
	});

	it("waiting can transition to cancelled", () => {
		assert.ok(canTransitionTaskStatus("waiting", "cancelled"));
	});

	it("waiting is not a terminal status", () => {
		assert.equal(isTerminalTaskStatus("waiting"), false);
	});

	it("queued cannot transition to waiting", () => {
		assert.equal(canTransitionTaskStatus("queued", "waiting"), false);
	});

	it("completed cannot transition to waiting", () => {
		assert.equal(canTransitionTaskStatus("completed", "waiting"), false);
	});
});
