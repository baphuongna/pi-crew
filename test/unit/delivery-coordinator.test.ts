import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DeliveryCoordinator } from "../../src/runtime/delivery-coordinator.ts";

describe("DeliveryCoordinator", () => {
	it("queues results when inactive", () => {
		const dc = new DeliveryCoordinator({});
		assert.equal(dc.isActive(), false);
		assert.equal(dc.getPendingCount(), 0);
		dc.deliverResult("run1", { status: "completed" });
		assert.equal(dc.getPendingCount(), 1);
		dc.dispose();
	});

	it("delivers results immediately when active", () => {
		const emitted: Array<{ event: string; data: unknown }> = [];
		const dc = new DeliveryCoordinator({
			emit: (event, data) => { emitted.push({ event, data }); },
		});
		dc.activate("session-1");
		assert.equal(dc.isActive(), true);
		dc.deliverResult("run1", { status: "completed" });
		assert.equal(dc.getPendingCount(), 0);
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].event, "pi-crew:run-result");
		dc.dispose();
	});

	it("flushes queued results on activate", () => {
		const emitted: Array<{ event: string; data: unknown }> = [];
		const dc = new DeliveryCoordinator({});
		dc.deliverResult("run1", { status: "completed" });
		dc.deliverResult("run2", { status: "failed" });
		assert.equal(dc.getPendingCount(), 2);

		// Replace deps to capture delivery on activate
		const activeDc = new DeliveryCoordinator({
			emit: (event, data) => { emitted.push({ event, data }); },
			sendFollowUp: () => {},
			sendWakeUp: () => {},
		});
		// Queue on the inactive DC
		activeDc.deliverResult("run1", { status: "completed" });
		activeDc.activate("session-2");
		assert.equal(activeDc.getPendingCount(), 0);
		assert.equal(emitted.length, 1);
		activeDc.dispose();
		dc.dispose();
	});

	it("delivers notifications when active", () => {
		const followUps: string[] = [];
		const dc = new DeliveryCoordinator({
			sendFollowUp: (title, body) => { followUps.push(`${title}: ${body}`); },
		});
		dc.activate("session-1");
		dc.deliverNotification({ id: "n1", severity: "info", source: "test", title: "Test Title", body: "Test Body" });
		assert.equal(followUps.length, 1);
		assert.equal(followUps[0], "Test Title: Test Body");
		assert.equal(dc.getPendingCount(), 0);
		dc.dispose();
	});

	it("queues notifications when inactive", () => {
		const dc = new DeliveryCoordinator({});
		dc.deliverNotification({ id: "n1", severity: "info", source: "test", title: "Test", body: "Body" });
		assert.equal(dc.getPendingCount(), 1);
		dc.dispose();
	});

	it("delivers steer messages when active", () => {
		const wakeUps: string[] = [];
		const dc = new DeliveryCoordinator({
			sendWakeUp: (message) => { wakeUps.push(message); },
		});
		dc.activate("session-1");
		dc.deliverSteer("run1", "continue please");
		assert.equal(wakeUps.length, 1);
		assert.equal(wakeUps[0], "continue please");
		dc.dispose();
	});

	it("queues steer messages when inactive", () => {
		const dc = new DeliveryCoordinator({});
		dc.deliverSteer("run1", "continue please");
		assert.equal(dc.getPendingCount(), 1);
		dc.dispose();
	});

	it("deactivate stops delivery", () => {
		const emitted: unknown[] = [];
		const dc = new DeliveryCoordinator({
			emit: (event, data) => { emitted.push(data); },
		});
		dc.activate("session-1");
		dc.deliverResult("run1", { status: "ok" });
		assert.equal(emitted.length, 1);
		dc.deactivate();
		dc.deliverResult("run2", { status: "ok" });
		assert.equal(emitted.length, 1); // not delivered
		assert.equal(dc.getPendingCount(), 1);
		dc.dispose();
	});

	it("requeues result when active emit throws", () => {
		const dc = new DeliveryCoordinator({ emit: () => { throw new Error("transient"); } });
		dc.activate("session-1");
		dc.deliverResult("run1", { status: "completed" });
		assert.equal(dc.getPendingCount(), 1);
		dc.dispose();
	});

	it("requeues notification when active follow-up throws", () => {
		const dc = new DeliveryCoordinator({ sendFollowUp: () => { throw new Error("transient"); } });
		dc.activate("session-1");
		dc.deliverNotification({ id: "n1", severity: "info", source: "test", title: "Test", body: "Body" });
		assert.equal(dc.getPendingCount(), 1);
		dc.dispose();
	});

	it("drops deliveries queued before a session switch", () => {
		const emitted: unknown[] = [];
		const dc = new DeliveryCoordinator({ emit: (_event, data) => { emitted.push(data); } });
		dc.deliverResult("run-before", { status: "queued-before-switch" });
		assert.equal(dc.getPendingCount(), 1);
		dc.deactivate();
		dc.activate("session-2");
		assert.equal(dc.getPendingCount(), 0);
		assert.equal(emitted.length, 0);
		dc.dispose();
	});

	it("delivers inactive payloads queued during the current generation", () => {
		const emitted: unknown[] = [];
		const dc = new DeliveryCoordinator({ emit: (_event, data) => { emitted.push(data); } });
		dc.deactivate();
		dc.deliverResult("run-after", { status: "queued-after-switch" });
		dc.activate("session-2");
		assert.equal(dc.getPendingCount(), 0);
		assert.equal(emitted.length, 1);
		dc.dispose();
	});

	it("dispose clears all pending", () => {
		const dc = new DeliveryCoordinator({});
		dc.deliverResult("run1", {});
		dc.deliverResult("run2", {});
		assert.equal(dc.getPendingCount(), 2);
		dc.dispose();
		assert.equal(dc.getPendingCount(), 0);
	});
});
