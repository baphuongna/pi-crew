import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HandoffSummary } from "../../src/runtime/handoff-manager.ts";
import type { HiddenHandoff } from "../../src/runtime/hidden-handoff.ts";
import { createHiddenHandoffService, HiddenHandoffService } from "../../src/runtime/hidden-handoff.ts";

function makeSummary(overrides: Partial<HandoffSummary> = {}): HandoffSummary {
	return {
		taskId: "task-01",
		runId: "run-01",
		timestamp: Date.now(),
		task: "Test task",
		outcome: "success",
		filesCreated: [],
		filesModified: [],
		filesDeleted: [],
		decisions: [],
		blockers: [],
		nextSteps: [],
		metrics: {
			tokensUsed: 500,
			duration: 1000,
			iterations: 1,
			toolsUsed: ["bash"],
		},
		contextSnapshot: "ctx",
		...overrides,
	};
}

// ── isEnabled / setEnabled ──

describe("HiddenHandoffService.isEnabled / setEnabled", () => {
	it("is enabled by default", () => {
		const svc = new HiddenHandoffService();
		assert.strictEqual(svc.isEnabled(), true);
	});

	it("can be disabled and re-enabled", () => {
		const svc = new HiddenHandoffService();
		svc.setEnabled(false);
		assert.strictEqual(svc.isEnabled(), false);
		svc.setEnabled(true);
		assert.strictEqual(svc.isEnabled(), true);
	});
});

// ── setMailbox / sendHandoff ──

describe("HiddenHandoffService.sendHandoff", () => {
	it("does nothing when disabled", () => {
		const sent: HiddenHandoff[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (_r, m) => {
					sent.push(m);
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.setEnabled(false);
		svc.sendHandoff(makeSummary());
		assert.strictEqual(sent.length, 0);
	});

	it("sends handoff to parent agent via mailbox", () => {
		const sent: { recipient: string; message: HiddenHandoff }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (recipient, message) => {
					sent.push({ recipient, message });
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary());
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].recipient, "parent-001");
		assert.strictEqual(sent[0].message.type, "boomerang-handoff");
		assert.strictEqual(sent[0].message.hidden, true);
		assert.strictEqual(sent[0].message.metadata.taskId, "task-01");
		assert.strictEqual(sent[0].message.metadata.priority, "low");
	});

	it("sends to explicit recipient when specified", () => {
		const sent: { recipient: string }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (r, _m) => {
					sent.push({ recipient: r });
				},
			},
		});
		svc.sendHandoff(makeSummary(), { to: "other-agent" });
		assert.strictEqual(sent.length, 1);
		assert.strictEqual(sent[0].recipient, "other-agent");
	});

	it("emits handoff:sent_no_recipient when no parent and no recipient", () => {
		const events: { event: string }[] = [];
		const svc = new HiddenHandoffService({
			eventEmitter: {
				emit: (e, _d) => {
					events.push({ event: e });
				},
			},
		});
		svc.sendHandoff(makeSummary());
		assert.ok(events.some((e) => e.event === "handoff:sent_no_recipient"));
	});

	it("rejects invalid recipient format", () => {
		const events: { event: string }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: { send: () => {} },
			eventEmitter: {
				emit: (e, _d) => {
					events.push({ event: e });
				},
			},
		});
		svc.sendHandoff(makeSummary(), { to: "invalid recipient!" });
		assert.ok(events.some((e) => e.event === "handoff:invalid_recipient"));
	});

	it("sets high priority for failure outcomes", () => {
		const sent: { message: HiddenHandoff }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (_r, m) => {
					sent.push({ message: m });
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary({ outcome: "failure" }));
		assert.strictEqual(sent[0].message.metadata.priority, "high");
	});

	it("sets normal priority when blockers exist", () => {
		const sent: { message: HiddenHandoff }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (_r, m) => {
					sent.push({ message: m });
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary({ blockers: ["blocked on X"] }));
		assert.strictEqual(sent[0].message.metadata.priority, "normal");
	});

	it("uses custom handoff type when specified", () => {
		const sent: { message: HiddenHandoff }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (_r, m) => {
					sent.push({ message: m });
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary(), { customType: "task-complete" });
		assert.strictEqual(sent[0].message.type, "task-complete");
	});

	it("emits handoff:sent event on successful send", () => {
		const events: { event: string }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: { send: () => {} },
			eventEmitter: {
				emit: (e, _d) => {
					events.push({ event: e });
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary());
		assert.ok(events.some((e) => e.event === "handoff:sent"));
	});
});

// ── rate limiting ──

describe("HiddenHandoffService rate limiting", () => {
	it("rate limits after max sends to same recipient", () => {
		const events: { event: string }[] = [];
		const svc = new HiddenHandoffService({
			mailbox: { send: () => {} },
			eventEmitter: {
				emit: (e, _d) => {
					events.push({ event: e });
				},
			},
			getParentAgentId: () => "parent-001",
		});
		// Send 10 times (the max)
		for (let i = 0; i < 10; i++) {
			svc.sendHandoff(makeSummary());
		}
		// 11th should be rate limited
		const beforeRate = events.filter((e) => e.event === "handoff:rate_limited").length;
		svc.sendHandoff(makeSummary());
		const afterRate = events.filter((e) => e.event === "handoff:rate_limited").length;
		assert.ok(afterRate > beforeRate, "Should have emitted rate_limited event");
	});
});

// ── sendHandoffAsync ──

describe("HiddenHandoffService.sendHandoffAsync", () => {
	it("sends handoff without throwing", () => {
		const sent: HiddenHandoff[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (_r, m) => {
					sent.push(m);
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoffAsync(makeSummary());
		assert.strictEqual(sent.length, 1);
	});
});

// ── setMailbox / setEventEmitter / setGetParentAgentId ──

describe("HiddenHandoffService setters", () => {
	it("setMailbox updates the mailbox", () => {
		const sent1: HiddenHandoff[] = [];
		const sent2: HiddenHandoff[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (_r, m) => {
					sent1.push(m);
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary());
		assert.strictEqual(sent1.length, 1);

		svc.setMailbox({
			send: (_r, m) => {
				sent2.push(m);
			},
		});
		svc.sendHandoff(makeSummary());
		assert.strictEqual(sent2.length, 1);
	});

	it("setEventEmitter updates the emitter", () => {
		const events1: string[] = [];
		const events2: string[] = [];
		const svc = new HiddenHandoffService({
			eventEmitter: {
				emit: (e, _d) => {
					events1.push(e);
				},
			},
			getParentAgentId: () => "parent-001",
		});
		svc.sendHandoff(makeSummary());
		assert.strictEqual(events1.length, 1);

		svc.setEventEmitter({
			emit: (e, _d) => {
				events2.push(e);
			},
		});
		svc.sendHandoff(makeSummary());
		assert.strictEqual(events2.length, 1);
	});

	it("setGetParentAgentId updates the callback", () => {
		const sent: string[] = [];
		const svc = new HiddenHandoffService({
			mailbox: {
				send: (r, _m) => {
					sent.push(r);
				},
			},
			getParentAgentId: () => "old-parent",
		});
		svc.sendHandoff(makeSummary());
		assert.strictEqual(sent[0], "old-parent");

		svc.setGetParentAgentId(() => "new-parent");
		svc.sendHandoff(makeSummary());
		assert.strictEqual(sent[1], "new-parent");
	});
});

// ── dispose ──

describe("HiddenHandoffService.dispose", () => {
	it("clears internal state", () => {
		const svc = new HiddenHandoffService();
		svc.dispose();
		// After disposal, sending should still work but mailbox is null
		assert.strictEqual(svc.isEnabled(), true); // enabled flag unchanged
	});
});

// ── createHiddenHandoffService ──

describe("createHiddenHandoffService", () => {
	it("creates a HiddenHandoffService instance", () => {
		const svc = createHiddenHandoffService();
		assert.ok(svc instanceof HiddenHandoffService);
	});

	it("creates with options", () => {
		const svc = createHiddenHandoffService({
			getParentAgentId: () => "p1",
		});
		assert.ok(svc instanceof HiddenHandoffService);
	});
});
