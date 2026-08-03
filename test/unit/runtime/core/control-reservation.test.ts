import assert from "node:assert/strict";
import test from "node:test";
import { reserveControlChannel } from "../../../../src/runtime/agent-control.ts";

test("reserveControlChannel creates a reservation with controller ID", () => {
	const reservation = reserveControlChannel("01_explore", "test-run-1");
	assert.ok(reservation.reservedAt);
	assert.ok(reservation.controllerId.startsWith("ctrl:01_explore:"));
	assert.equal(reservation.acceptsControlEvents, true);
});

test("reserveControlChannel generates unique controller IDs", () => {
	const r1 = reserveControlChannel("01_explore", "test-run-1");
	const r2 = reserveControlChannel("01_explore", "test-run-1");
	assert.notEqual(r1.controllerId, r2.controllerId);
});

test("reserveControlChannel includes task ID and run ID in prefix", () => {
	const reservation = reserveControlChannel("02_execute", "team-abc");
	assert.ok(reservation.controllerId.includes("02_execute"));
});
