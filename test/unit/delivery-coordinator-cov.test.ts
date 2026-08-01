import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NotificationDescriptor } from "../../src/extension/notification-router.ts";
import { DeliveryCoordinator } from "../../src/runtime/delivery-coordinator.ts";

function makeNotification(overrides: Partial<NotificationDescriptor> = {}): NotificationDescriptor {
	return {
		severity: "info",
		source: "test",
		title: "Test notification",
		...overrides,
	};
}

describe("DeliveryCoordinator", () => {
	it("starts inactive", () => {
		const dc = new DeliveryCoordinator({});
		assert.equal(dc.isActive(), false);
		assert.equal(dc.getPendingCount(), 0);
		dc.dispose();
	});

	describe("activate / deactivate", () => {
		it("activates with sessionId", () => {
			const dc = new DeliveryCoordinator({});
			dc.activate("session-1");
			assert.equal(dc.isActive(), true);
			dc.dispose();
		});

		it("deactivates and clears active state", () => {
			const dc = new DeliveryCoordinator({});
			dc.activate("session-1");
			dc.deactivate();
			assert.equal(dc.isActive(), false);
			dc.dispose();
		});

		it("dispose cleans up", () => {
			const dc = new DeliveryCoordinator({});
			dc.activate("session-1");
			dc.dispose();
			assert.equal(dc.isActive(), false);
			assert.equal(dc.getPendingCount(), 0);
		});
	});

	describe("deliverResult", () => {
		it("emits result when active", () => {
			let emitted = false;
			const dc = new DeliveryCoordinator({
				emit: (event: string, _data: unknown) => {
					if (event === "pi-crew:run-result") emitted = true;
				},
			});
			dc.activate("session-1");
			dc.deliverResult("run-1", { status: "ok" });
			assert.ok(emitted);
			assert.equal(dc.getPendingCount(), 0);
			dc.dispose();
		});

		it("queues result when inactive", () => {
			const dc = new DeliveryCoordinator({});
			dc.deliverResult("run-1", { status: "ok" });
			assert.equal(dc.getPendingCount(), 1);
			dc.dispose();
		});

		it("flushes queued results on activate", () => {
			let emitCount = 0;
			const dc = new DeliveryCoordinator({
				emit: (event: string, _data: unknown) => {
					if (event === "pi-crew:run-result") emitCount++;
				},
			});
			dc.deliverResult("run-1", { status: "ok" });
			dc.deliverResult("run-2", { status: "ok" });
			assert.equal(dc.getPendingCount(), 2);
			dc.activate("session-1");
			assert.equal(emitCount, 2);
			assert.equal(dc.getPendingCount(), 0);
			dc.dispose();
		});
	});

	describe("deliverNotification", () => {
		it("sends follow-up when active", () => {
			let sent = false;
			const dc = new DeliveryCoordinator({
				sendFollowUp: (_title: string, _body: string) => {
					sent = true;
				},
			});
			dc.activate("session-1");
			dc.deliverNotification(makeNotification());
			assert.ok(sent);
			dc.dispose();
		});

		it("queues notification when inactive", () => {
			const dc = new DeliveryCoordinator({});
			dc.deliverNotification(makeNotification());
			assert.equal(dc.getPendingCount(), 1);
			dc.dispose();
		});

		it("emits secondary event when active and follow-up succeeds", () => {
			let emitted = false;
			const dc = new DeliveryCoordinator({
				sendFollowUp: () => undefined,
				emit: (event: string) => {
					if (event === "pi-crew:notification") emitted = true;
				},
			});
			dc.activate("session-1");
			dc.deliverNotification(makeNotification());
			assert.ok(emitted);
			dc.dispose();
		});
	});

	describe("deliverSteer", () => {
		it("sends wake-up when active", () => {
			let woken = false;
			const dc = new DeliveryCoordinator({
				sendWakeUp: (_msg: string) => {
					woken = true;
				},
			});
			dc.activate("session-1");
			dc.deliverSteer("run-1", "wake up!");
			assert.ok(woken);
			dc.dispose();
		});

		it("queues steer when inactive", () => {
			const dc = new DeliveryCoordinator({});
			dc.deliverSteer("run-1", "steer msg");
			assert.equal(dc.getPendingCount(), 1);
			dc.dispose();
		});

		it("flushes queued steer on activate", () => {
			let steered = false;
			const dc = new DeliveryCoordinator({
				sendWakeUp: (_msg: string) => {
					steered = true;
				},
			});
			dc.deliverSteer("run-1", "steer msg");
			dc.activate("session-1");
			assert.ok(steered);
			dc.dispose();
		});
	});

	describe("generation tracking", () => {
		it("stale steers from previous generation are dropped on flush", () => {
			let steerCount = 0;
			const dc = new DeliveryCoordinator({
				sendWakeUp: () => {
					steerCount++;
				},
			});
			// Enqueue while inactive (generation 0)
			dc.deliverSteer("run-1", "stale steer");
			// Activate then deactivate bumps generation
			dc.activate("session-1");
			dc.deactivate();
			// Now at generation 1, activate again — the stale steer should be skipped
			dc.activate("session-1");
			assert.equal(steerCount, 1); // delivered once during first activate
			dc.dispose();
		});
	});
});
