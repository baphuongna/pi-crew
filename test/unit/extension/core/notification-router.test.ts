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

import assert from "node:assert/strict";
import test from "node:test";
import {
	type NotificationDescriptor,
	NotificationRouter,
	type NotificationRouterOptions,
} from "../../../../src/extension/notification-router.ts";

const baseNotification = (overrides: Partial<NotificationDescriptor> = {}): NotificationDescriptor => ({
	severity: "warning",
	source: "test",
	runId: "r1",
	title: "Test",
	body: "body",
	...overrides,
});

// Helper that disables default severity filter
const makeRouter = (opts: NotificationRouterOptions, deliver: (n: NotificationDescriptor) => void) =>
	new NotificationRouter({ severityFilter: ["info", "warning", "error", "critical"], ...opts }, deliver);

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
	const router = makeRouter({ dedupWindowMs: 1000, now: () => now }, (n) => delivered.push(n));
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
	const router = makeRouter({ quietHours: "22:00-23:00", now: () => mockDate.getTime() }, (n) => delivered.push(n));
	const result = router.enqueue(baseNotification({ severity: "warning" }));
	assert.equal(result, false);
	assert.equal(delivered.length, 0);
});

test("NotificationRouter.sink errors do not break enqueue", () => {
	const router = makeRouter(
		{
			sink: () => {
				throw new Error("sink broken");
			},
		},
		() => undefined,
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

test("NotificationRouter clear removes id from seen and allows re-notification", () => {
	const delivered: NotificationDescriptor[] = [];
	const now = 1000;
	const router = makeRouter({ dedupWindowMs: 60_000, now: () => now }, (n) => delivered.push(n));
	// 1. Enqueue with id "x" -> delivered.
	assert.equal(router.enqueue(baseNotification({ id: "x" })), true);
	assert.equal(delivered.length, 1);
	// 2. Re-enqueue within the dedup window -> deduped (NOT delivered).
	assert.equal(router.enqueue(baseNotification({ id: "x" })), false);
	assert.equal(delivered.length, 1);
	// 3. Clear for the same id -> removes id from `seen` and delivers the clear.
	assert.equal(router.enqueue(baseNotification({ id: "x", clear: true, severity: "info" })), true);
	assert.equal(delivered.length, 2);
	assert.equal(delivered[1].clear, true);
	// 4. Re-enqueue the original -> NOT deduped now (the clear purged `seen`).
	assert.equal(router.enqueue(baseNotification({ id: "x" })), true);
	assert.equal(delivered.length, 3);
});

test("NotificationRouter clear bypasses severity filter and quiet hours", () => {
	const delivered: NotificationDescriptor[] = [];
	const mockDate = new Date();
	mockDate.setHours(10, 30, 0, 0); // outside quiet hours
	// Default severity filter (warning/error/critical) excludes "info".
	const router = new NotificationRouter({ quietHours: "22:00-23:00", now: () => mockDate.getTime() }, (n) => delivered.push(n));
	// 1. Enqueue a warning notification outside quiet hours -> delivered, in seen.
	assert.equal(router.enqueue(baseNotification({ id: "y", severity: "warning" })), true);
	assert.equal(delivered.length, 1);
	// 2. Move into quiet hours — a new normal notification is now blocked.
	mockDate.setHours(22, 30, 0, 0);
	assert.equal(router.enqueue(baseNotification({ id: "z", severity: "warning" })), false);
	assert.equal(delivered.length, 1);
	// 3. A clear for "y" must bypass quiet hours AND the severity filter (it is
	//    "info") so the dashboard can always drop the previously-emitted alert.
	assert.equal(router.enqueue(baseNotification({ id: "y", severity: "info", clear: true })), true);
	assert.equal(delivered.length, 2);
	assert.equal(delivered[1].clear, true);
});

test("NotificationRouter clear is idempotent (double-clear delivers only once)", () => {
	const delivered: NotificationDescriptor[] = [];
	const now = 1000;
	const router = makeRouter({ dedupWindowMs: 60_000, now: () => now }, (n) => delivered.push(n));
	// 1. Enqueue with id "d" -> delivered, in seen.
	assert.equal(router.enqueue(baseNotification({ id: "d" })), true);
	assert.equal(delivered.length, 1);
	// 2. First clear -> delivered (id was in seen).
	assert.equal(router.enqueue(baseNotification({ id: "d", clear: true, severity: "info" })), true);
	assert.equal(delivered.length, 2);
	// 3. Second clear for the same id -> silent no-op (id already removed from
	//    seen by the first clear). Prevents notificationCount drift on repeated
	//    render ticks for the same terminal run.
	assert.equal(router.enqueue(baseNotification({ id: "d", clear: true, severity: "info" })), true);
	assert.equal(delivered.length, 2);
});
