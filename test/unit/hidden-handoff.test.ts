/**
 * Unit tests for HiddenHandoffService.
 * @see src/runtime/hidden-handoff.ts
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { HandoffSummary } from "../../src/runtime/handoff-manager.ts";
import { createHiddenHandoffService, type HiddenHandoff, HiddenHandoffService } from "../../src/runtime/hidden-handoff.ts";

// Test helpers
function createHandoffSummary(overrides: Partial<HandoffSummary> = {}): HandoffSummary {
	return {
		taskId: "test-task-1",
		runId: "test-run-1",
		timestamp: Date.now(),
		task: "Test task",
		outcome: "success",
		filesCreated: ["file1.ts", "file2.ts"],
		filesModified: ["config.ts"],
		filesDeleted: [],
		decisions: [
			{
				rationale: "Chose approach A",
				outcome: "Successfully implemented",
				alternativesConsidered: ["Approach B"],
			},
		],
		blockers: ["Waiting for approval"],
		nextSteps: ["Deploy to staging", "Run tests"],
		metrics: {
			tokensUsed: 5000,
			duration: 30000,
			iterations: 1,
			toolsUsed: ["read", "write", "bash"],
		},
		contextSnapshot: "Test context snapshot",
		...overrides,
	};
}

// Mock mailbox
function createMockMailbox() {
	const sentMessages: Array<{ recipient: string; message: HiddenHandoff }> = [];
	return {
		sentMessages,
		mailbox: {
			send(recipient: string, message: HiddenHandoff) {
				sentMessages.push({ recipient, message });
			},
		},
	};
}

// Mock event emitter
function createMockEventEmitter() {
	const emittedEvents: Array<{ event: string; data: unknown }> = [];
	return {
		emittedEvents,
		emitter: {
			emit(event: string, data: unknown) {
				emittedEvents.push({ event, data });
			},
		},
	};
}

test("HiddenHandoffService - isEnabled returns true by default", () => {
	const service = new HiddenHandoffService();

	assert.strictEqual(service.isEnabled(), true);
});

test("HiddenHandoffService - setEnabled controls enabled state", () => {
	const service = new HiddenHandoffService();

	service.setEnabled(false);
	assert.strictEqual(service.isEnabled(), false);

	service.setEnabled(true);
	assert.strictEqual(service.isEnabled(), true);
});

test("HiddenHandoffService - sendHandoff with no mailbox doesn't throw", () => {
	const service = new HiddenHandoffService();
	const summary = createHandoffSummary();

	// Should not throw even without mailbox
	service.sendHandoff(summary);

	// No error means success
	assert.ok(true);
});

test("HiddenHandoffService - sendHandoff sends message to mailbox", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary();

	service.sendHandoff(summary, { to: "parent-agent" });

	assert.strictEqual(sentMessages.length, 1);
	assert.strictEqual(sentMessages[0].recipient, "parent-agent");
});

test("HiddenHandoffService - sendHandoff includes correct metadata", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary();

	service.sendHandoff(summary, { to: "recipient" });

	const message = sentMessages[0].message;
	assert.strictEqual(message.type, "boomerang-handoff");
	assert.strictEqual(message.hidden, true);
	assert.strictEqual(message.metadata.taskId, "test-task-1");
	assert.strictEqual(message.metadata.runId, "test-run-1");
	assert.ok(message.metadata.timestamp > 0);
});

test("HiddenHandoffService - sendHandoff with high priority for failures", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({ outcome: "failure" });

	service.sendHandoff(summary, { to: "recipient" });

	assert.strictEqual(sentMessages[0].message.metadata.priority, "high");
});

test("HiddenHandoffService - sendHandoff with normal priority for blockers", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({
		outcome: "success",
		blockers: ["Blocker present"],
	});

	service.sendHandoff(summary, { to: "recipient" });

	assert.strictEqual(sentMessages[0].message.metadata.priority, "normal");
});

test("HiddenHandoffService - sendHandoff with normal priority for high tokens", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({
		outcome: "success",
		blockers: [],
		metrics: {
			tokensUsed: 15000,
			duration: 30000,
			iterations: 1,
			toolsUsed: [],
		},
	});

	service.sendHandoff(summary, { to: "recipient" });

	assert.strictEqual(sentMessages[0].message.metadata.priority, "normal");
});

test("HiddenHandoffService - sendHandoff with low priority for simple tasks", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({
		outcome: "success",
		blockers: [],
		metrics: {
			tokensUsed: 1000,
			duration: 5000,
			iterations: 1,
			toolsUsed: [],
		},
	});

	service.sendHandoff(summary, { to: "recipient" });

	assert.strictEqual(sentMessages[0].message.metadata.priority, "low");
});

test("HiddenHandoffService - sendHandoff includes content from summary", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary();

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.ok(content.summary.includes("Test task"));
	assert.ok(content.summary.includes("success"));
	assert.deepEqual(content.files.created, ["file1.ts", "file2.ts"]);
	assert.deepEqual(content.files.modified, ["config.ts"]);
	assert.strictEqual(content.decisions.length, 1);
	assert.deepEqual(content.nextSteps, ["Deploy to staging", "Run tests"]);
	assert.strictEqual(content.metrics.tokens, 5000);
	assert.strictEqual(content.metrics.duration, 30000);
});

test("HiddenHandoffService - custom priority overrides inferred", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({ outcome: "success" });

	service.sendHandoff(summary, { to: "recipient", priority: "high" });

	assert.strictEqual(sentMessages[0].message.metadata.priority, "high");
});

test("HiddenHandoffService - customType changes message type", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary();

	service.sendHandoff(summary, {
		to: "recipient",
		customType: "task-complete",
	});

	assert.strictEqual(sentMessages[0].message.type, "task-complete");
});

test("HiddenHandoffService - disabled service doesn't send", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	service.setEnabled(false);
	const summary = createHandoffSummary();

	service.sendHandoff(summary, { to: "recipient" });

	assert.strictEqual(sentMessages.length, 0);
});

test("HiddenHandoffService - sendHandoffAsync doesn't throw", () => {
	const service = new HiddenHandoffService();
	const summary = createHandoffSummary();

	// Should not throw
	service.sendHandoffAsync(summary, { to: "recipient" });

	assert.ok(true);
});

test("HiddenHandoffService - getParentAgentId from callback", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({
		mailbox,
		getParentAgentId: () => "callback-parent",
	});
	const summary = createHandoffSummary();

	service.sendHandoff(summary);

	assert.strictEqual(sentMessages[0].recipient, "callback-parent");
});

test("HiddenHandoffService - getParentAgentId falls back to global context", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	(globalThis as Record<string, unknown>).__piCrewContext = {
		parentAgentId: "global-parent",
	};
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary();

	service.sendHandoff(summary);

	assert.strictEqual(sentMessages[0].recipient, "global-parent");

	// Cleanup
	delete (globalThis as Record<string, unknown>).__piCrewContext;
});

test("HiddenHandoffService - emits handoff:sent event", () => {
	const { emitter, emittedEvents } = createMockEventEmitter();
	const { mailbox } = createMockMailbox();
	const service = new HiddenHandoffService({
		mailbox,
		eventEmitter: emitter,
	});
	const summary = createHandoffSummary();

	service.sendHandoff(summary, { to: "recipient" });

	assert.ok(emittedEvents.some((e) => e.event === "handoff:sent"));
});

test("HiddenHandoffService - emits handoff:sent_no_recipient when no parent", () => {
	const { emitter, emittedEvents } = createMockEventEmitter();
	const service = new HiddenHandoffService({ eventEmitter: emitter });
	// No getParentAgentId or mailbox configured
	const summary = createHandoffSummary();

	service.sendHandoff(summary);

	assert.ok(emittedEvents.some((e) => e.event === "handoff:sent_no_recipient"));
});

test("HiddenHandoffService - setMailbox can update mailbox", () => {
	const service = new HiddenHandoffService();
	const { mailbox: mailbox1, sentMessages: sent1 } = createMockMailbox();
	const { mailbox: mailbox2, sentMessages: sent2 } = createMockMailbox();

	service.setMailbox(mailbox1);
	service.sendHandoff(createHandoffSummary(), { to: "r1" });

	service.setMailbox(mailbox2);
	service.sendHandoff(createHandoffSummary(), { to: "r2" });

	assert.strictEqual(sent1.length, 1);
	assert.strictEqual(sent2.length, 1);
	assert.strictEqual(sent1[0].recipient, "r1");
	assert.strictEqual(sent2[0].recipient, "r2");
});

test("HiddenHandoffService - setEventEmitter can update emitter", () => {
	const service = new HiddenHandoffService();
	const { emitter: emitter1, emittedEvents: events1 } = createMockEventEmitter();
	const { emitter: emitter2, emittedEvents: events2 } = createMockEventEmitter();

	service.setEventEmitter(emitter1);
	service.sendHandoff(createHandoffSummary(), { to: "r1" });

	service.setEventEmitter(emitter2);
	service.sendHandoff(createHandoffSummary(), { to: "r2" });

	assert.strictEqual(events1.length, 1);
	assert.strictEqual(events2.length, 1);
});

test("HiddenHandoffService - setGetParentAgentId updates callback", () => {
	const service = new HiddenHandoffService();
	const { mailbox, sentMessages } = createMockMailbox();
	service.setMailbox(mailbox);

	service.setGetParentAgentId(() => "new-parent");
	service.sendHandoff(createHandoffSummary());

	assert.strictEqual(sentMessages[0].recipient, "new-parent");
});

test("HiddenHandoffService - content builds summary text correctly", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary();

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.ok(content.summary.includes("Completed: Test task"));
	assert.ok(content.summary.includes("Outcome: success"));
	assert.ok(content.summary.includes("Files created: file1.ts, file2.ts"));
	assert.ok(content.summary.includes("Decisions: 1"));
});

test("HiddenHandoffService - content includes blockers if present", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({ blockers: ["Important blocker"] });

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.ok(content.summary.includes("Blockers: Important blocker"));
});

test("HiddenHandoffService - content includes next steps if present", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({ nextSteps: ["Step 1", "Step 2"] });

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.ok(content.summary.includes("Next steps: Step 1; Step 2"));
});

test("createHiddenHandoffService factory creates instance", () => {
	const service = createHiddenHandoffService();

	assert.ok(service instanceof HiddenHandoffService);
});

// Edge cases
test("HiddenHandoffService - handles empty files arrays", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
	});

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.deepEqual(content.files.created, []);
	assert.deepEqual(content.files.modified, []);
	assert.deepEqual(content.files.deleted, []);
});

test("HiddenHandoffService - handles empty decisions", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({ decisions: [] });

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.strictEqual(content.decisions.length, 0);
});

test("HiddenHandoffService - handles empty nextSteps and blockers", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({ nextSteps: [], blockers: [] });

	service.sendHandoff(summary, { to: "recipient" });

	const { content } = sentMessages[0].message;
	assert.deepEqual(content.nextSteps, []);
});

test("HiddenHandoffService - priority respects blockers even if outcome is success", () => {
	const { mailbox, sentMessages } = createMockMailbox();
	const service = new HiddenHandoffService({ mailbox });
	const summary = createHandoffSummary({
		outcome: "success",
		blockers: ["Has blockers"],
		metrics: {
			tokensUsed: 500,
			duration: 1000,
			iterations: 1,
			toolsUsed: [],
		},
	});

	service.sendHandoff(summary, { to: "recipient" });

	assert.strictEqual(sentMessages[0].message.metadata.priority, "normal");
});
