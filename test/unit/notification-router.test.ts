/**
 * Tests for src/extension/notification-router.ts
 * Coverage:
 * - enqueue with severity filter
 * - dedup window
 * - batch window (single + multiple notifications)
 * - quiet hours
 * - sink error handling
 * - dispose
 */
import test from "node:test";
import assert from "node:assert/strict";
import { NotificationRouter, type NotificationDescriptor, type NotificationRouterOptions } from "../../src/extension/notification-router.ts";

const baseNotification = (overrides: Partial<NotificationDescriptor> = {}): NotificationDescriptor => ({
	severity: "warning",
	source: "test",
	runId: "r1",
	title: "Test",
	body: "body",
	...overrides,
});

// Helper that disables default severity filter
const makeRouter = (
	opts: NotificationRouterOptions,
	deliver: (n: NotificationDescriptor) => void,
) => new NotificationRouter({ severityFilter: ["info", "warning", "error", "critical"], ...opts }, deliver);

test("NotificationRouter delivers a single notification immediately", () => {
	const delivered: NotificationDescriptor[] = [];
	const router = makeRouter({}, (n) => delivered.push(n));
	const result = router.enqueue(baseNotification());
	assert.equal(result, true);
	assert.equal(delivered.length, 1);
	assert.equal(delivered[0].title, "Test");
});

test("NotificationRouter respects severity filter", () => {
	const delivered: NotificationDescriptor[] = [];
	const router = new NotificationRouter({ severityFilter: ["critical"] }, (n) => delivered.push(n));
	const result = router.enqueue(baseNotification({ severity: "warning" }));
	assert.equal(result, false);
	assert.equal(delivered.length, 0);
});

test("NotificationRouter deduplicates within the window", () => {
	const delivered: NotificationDescriptor[] = [];
	const router = makeRouter({ dedupWindowMs: 1000, now: () => 1000 }, (n) => delivered.push(n));
	assert.equal(router.enqueue(baseNotification()), true);
	assert.equal(router.enqueue(baseNotification()), false);
	assert.equal(delivered.length, 1);
});

test("NotificationRouter allows after dedup window expires", () => {
	let now = 1000;
	const delivered: NotificationDescriptor[] = [];
	const router = makeRouter(
		{ dedupWindowMs: 1000, now: () => now },
		(n) => delivered.push(n),
	);
	router.enqueue(baseNotification());
	now = 2500; // Past the dedup window
	router.enqueue(baseNotification());
	assert.equal(delivered.length, 2);
});

test("NotificationRouter batches multiple notifications when batchWindowMs is set", () => {
	const delivered: NotificationDescriptor[] = [];
	const router = makeRouter({ batchWindowMs: 50 }, (n) => delivered.push(n));
	router.enqueue(baseNotification({ title: "A" }));
	router.enqueue(baseNotification({ title: "B" }));
	router.enqueue(baseNotification({ title: "C" }));
	assert.equal(delivered.length, 0, "should be queued, not delivered");
	router.flush();
	assert.equal(delivered.length, 1, "should deliver a single batched notification");
	assert.ok(delivered[0].title.includes("3"));
});

test("NotificationRouter inQuietHours blocks delivery", () => {
	const delivered: NotificationDescriptor[] = [];
	// 22:00 to 23:00 - mock current time at 22:30
	const mockDate = new Date();
	mockDate.setHours(22, 30, 0, 0);
	const router = makeRouter(
		{ quietHours: "22:00-23:00", now: () => mockDate.getTime() },
		(n) => delivered.push(n),
	);
	const result = router.enqueue(baseNotification({ severity: "warning" }));
	assert.equal(result, false);
	assert.equal(delivered.length, 0);
});

test("NotificationRouter.sink errors do not break enqueue", () => {
	const router = makeRouter(
		{ sink: () => { throw new Error("sink broken"); } },
		() => {},
	);
	// Should not throw
	assert.equal(router.enqueue(baseNotification()), true);
});

test("NotificationRouter dispose clears batch and seen", () => {
	const delivered: NotificationDescriptor[] = [];
	const router = makeRouter({ batchWindowMs: 50 }, (n) => delivered.push(n));
	router.enqueue(baseNotification());
	router.enqueue(baseNotification());
	router.dispose();
	router.flush();
	assert.equal(delivered.length, 0, "nothing should be delivered after dispose");
});
