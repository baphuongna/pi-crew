import assert from "node:assert/strict";
import test from "node:test";
import { type ProgressEventSummary, shouldAppendProgressEventUpdate } from "../../src/runtime/output/progress-event-coalescer.ts";

const base: ProgressEventSummary = {
	eventType: "message_end",
	activityState: "active",
	toolCount: 0,
	tokens: 100,
	turns: 1,
};

test("progress coalescer drops repeated unchanged events inside interval", () => {
	const decision = shouldAppendProgressEventUpdate({
		previous: base,
		next: { ...base },
		nowMs: 120,
		lastAppendMs: 100,
		minIntervalMs: 1000,
	});
	assert.equal(decision.shouldAppend, false);
	assert.equal(decision.reason, "coalesced");
});

test("progress coalescer appends first, force, and meaningful changes", () => {
	assert.equal(
		shouldAppendProgressEventUpdate({
			next: base,
			nowMs: 100,
			minIntervalMs: 1000,
		}).reason,
		"first",
	);
	assert.equal(
		shouldAppendProgressEventUpdate({
			previous: base,
			next: base,
			nowMs: 110,
			lastAppendMs: 100,
			minIntervalMs: 1000,
			force: true,
		}).reason,
		"force",
	);
	assert.equal(
		shouldAppendProgressEventUpdate({
			previous: base,
			next: { ...base, currentTool: "read" },
			nowMs: 120,
			lastAppendMs: 100,
			minIntervalMs: 1000,
		}).reason,
		"tool_changed",
	);
	assert.equal(
		shouldAppendProgressEventUpdate({
			previous: base,
			next: { ...base, toolCount: 1 },
			nowMs: 130,
			lastAppendMs: 100,
			minIntervalMs: 1000,
		}).reason,
		"tool_count_increased",
	);
	assert.equal(
		shouldAppendProgressEventUpdate({
			previous: base,
			next: { ...base, tokens: 356 },
			nowMs: 140,
			lastAppendMs: 100,
			minIntervalMs: 1000,
		}).reason,
		"tokens_increased",
	);
});

test("progress coalescer appends after minimum interval", () => {
	const decision = shouldAppendProgressEventUpdate({
		previous: base,
		next: { ...base },
		nowMs: 1200,
		lastAppendMs: 100,
		minIntervalMs: 1000,
	});
	assert.equal(decision.shouldAppend, true);
	assert.equal(decision.reason, "interval");
});
