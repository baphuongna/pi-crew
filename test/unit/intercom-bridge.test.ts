import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	IntercomQueue,
	getIntercomQueue,
	cleanupIntercomQueue,
} from "../../src/runtime/intercom-bridge.ts";
import type { IntercomMessage } from "../../src/runtime/intercom-bridge.ts";

function makeMessage(overrides?: Partial<IntercomMessage>): IntercomMessage {
	return {
		type: "question",
		taskStepId: "task-01",
		content: "What should I do?",
		urgency: "medium",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("intercom-bridge: IntercomQueue", () => {
	it("enqueues a message and resolves when responded to", async () => {
		const queue = new IntercomQueue();
		const msg = makeMessage();

		const promise = queue.enqueue(msg);

		// Should have 1 pending
		assert.equal(queue.pendingCount, 1);

		// Get pending messages
		const pending = queue.getPending();
		assert.equal(pending.length, 1);
		assert.equal(pending[0].content, "What should I do?");

		// Respond
		const messageId = pending[0].id;
		const responded = queue.respond(messageId, "Do the thing", "orchestrator");
		assert.equal(responded, true);

		// Wait for response
		const response = await promise;
		assert.equal(response.answer, "Do the thing");
		assert.equal(response.source, "orchestrator");
		assert.equal(response.messageId, messageId);

		// Should be empty now
		assert.equal(queue.pendingCount, 0);
	});

	it("resolves with source=timeout when timeout elapses", async () => {
		const queue = new IntercomQueue();
		const msg = makeMessage({ timeout: 50 }); // 50ms timeout

		// Keep event loop alive while unref'd timer fires. Without this, Node's
		// test runner sees the event loop as resolved and cancels the pending
		// promise before the 50ms timeout fires.
		const keepAlive = setInterval(() => {}, 25);
		try {
			const promise = queue.enqueue(msg);
			const response = await promise;
			assert.equal(response.source, "timeout");
			assert.ok(response.answer.includes("timeout"));
		} finally {
			clearInterval(keepAlive);
		}
	});

	it("returns false when responding to unknown message ID", () => {
		const queue = new IntercomQueue();
		const result = queue.respond("nonexistent-id", "nope");
		assert.equal(result, false);
	});

	it("clears all pending messages", async () => {
		const queue = new IntercomQueue();

		// Enqueue two messages without timeout so they stay pending
		const p1 = queue.enqueue(makeMessage());
		const p2 = queue.enqueue(makeMessage());

		assert.equal(queue.pendingCount, 2);

		queue.clear();
		assert.equal(queue.pendingCount, 0);

		// Both promises should resolve with evicted message
		const r1 = await p1;
		const r2 = await p2;
		assert.equal(r1.source, "timeout");
		assert.ok(r1.answer.includes("evicted"));
		assert.equal(r2.source, "timeout");
	});

	it("responds with human source when specified", async () => {
		const queue = new IntercomQueue();
		const promise = queue.enqueue(makeMessage());
		const pending = queue.getPending();
		queue.respond(pending[0].id, "Human answer", "human");

		const response = await promise;
		assert.equal(response.source, "human");
		assert.equal(response.answer, "Human answer");
	});

	it("evicts oldest when queue exceeds MAX_QUEUE_SIZE", async () => {
		const queue = new IntercomQueue();

		// Fill up to MAX_QUEUE_SIZE (100) — these don't have timeout
		const promises: Promise<unknown>[] = [];
		for (let i = 0; i < 100; i++) {
			promises.push(queue.enqueue(makeMessage({ content: `msg-${i}` })));
		}
		assert.equal(queue.pendingCount, 100);

		// Enqueue one more — should evict oldest
		const overflowPromise = queue.enqueue(makeMessage({ content: "overflow" }));
		assert.equal(queue.pendingCount, 100); // still 100 (evicted one, added one)

		// The first promise should resolve with eviction
		const firstResponse = await promises[0];
		assert.ok((firstResponse as { source: string }).source === "timeout");
		assert.ok((firstResponse as { answer: string }).answer.includes("queue_full"));
	});

	it("pending messages include the generated ID", () => {
		const queue = new IntercomQueue();
		queue.enqueue(makeMessage());
		const pending = queue.getPending();
		assert.equal(pending.length, 1);
		assert.ok(pending[0].id.startsWith("icm-"));
	});
});

describe("intercom-bridge: getIntercomQueue singleton", () => {
	it("returns the same queue for the same runId", () => {
		const runId = `test-run-${Date.now()}`;
		const q1 = getIntercomQueue(runId);
		const q2 = getIntercomQueue(runId);
		assert.equal(q1, q2);
		// Cleanup
		cleanupIntercomQueue(runId);
	});

	it("returns different queues for different runIds", () => {
		const q1 = getIntercomQueue(`run-a-${Date.now()}`);
		const q2 = getIntercomQueue(`run-b-${Date.now()}`);
		assert.notEqual(q1, q2);
	});
});

describe("intercom-bridge: cleanupIntercomQueue", () => {
	it("cleans up queue and removes from registry", () => {
		const runId = `cleanup-test-${Date.now()}`;
		const queue = getIntercomQueue(runId);
		queue.enqueue(makeMessage());
		assert.equal(queue.pendingCount, 1);

		cleanupIntercomQueue(runId);
		assert.equal(queue.pendingCount, 0);

		// Getting again should return a new queue
		const queue2 = getIntercomQueue(runId);
		assert.notEqual(queue, queue2);
		// Cleanup the new one
		cleanupIntercomQueue(runId);
	});

	it("does nothing for unknown runId", () => {
		// Should not throw
		cleanupIntercomQueue("nonexistent-run-id");
	});
});
