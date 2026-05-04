import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canTransitionTaskStatus, isTerminalTaskStatus } from "../../src/state/contracts.ts";

describe("interactive subagent edge cases", () => {
	// Negative transitions — these should be false
	it("failed cannot transition to waiting", () => {
		assert.equal(canTransitionTaskStatus("failed", "waiting"), false);
	});

	it("cancelled cannot transition to waiting", () => {
		assert.equal(canTransitionTaskStatus("cancelled", "waiting"), false);
	});

	it("completed cannot transition to waiting", () => {
		assert.equal(canTransitionTaskStatus("completed", "waiting"), false);
	});

	// Identity transitions
	it("waiting to waiting is allowed (identity)", () => {
		assert.equal(canTransitionTaskStatus("waiting", "waiting"), true);
	});

	// Invalid transition from waiting
	it("waiting cannot transition to queued", () => {
		assert.equal(canTransitionTaskStatus("waiting", "queued"), false);
	});

	it("waiting cannot transition to skipped", () => {
		assert.equal(canTransitionTaskStatus("waiting", "skipped"), false);
	});

	// isTerminalTaskStatus for all terminal statuses
	it("failed is terminal", () => {
		assert.equal(isTerminalTaskStatus("failed"), true);
	});

	it("cancelled is terminal", () => {
		assert.equal(isTerminalTaskStatus("cancelled"), true);
	});

	it("skipped is terminal", () => {
		assert.equal(isTerminalTaskStatus("skipped"), true);
	});

	it("completed is terminal", () => {
		assert.equal(isTerminalTaskStatus("completed"), true);
	});

	it("running is not terminal", () => {
		assert.equal(isTerminalTaskStatus("running"), false);
	});

	it("waiting is not terminal", () => {
		assert.equal(isTerminalTaskStatus("waiting"), false);
	});

	it("queued is not terminal", () => {
		assert.equal(isTerminalTaskStatus("queued"), false);
	});
});
