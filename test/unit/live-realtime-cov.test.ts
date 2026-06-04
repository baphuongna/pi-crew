import { describe, it } from "node:test";
import assert from "node:assert/strict";
import test from "node:test";
import {
	publishLiveControlRealtime,
	subscribeLiveControlRealtime,
	liveControlRealtimeMessage,
	parseLiveControlRealtimeMessage,
	clearLiveControlRealtimeForTest,
} from "../../src/runtime/live-control-realtime.ts";
import type { LiveAgentControlRequest } from "../../src/runtime/live-agent-control.ts";

function makeRequest(overrides: Partial<LiveAgentControlRequest> = {}): LiveAgentControlRequest {
	return {
		id: "ctrl_test",
		runId: "run1",
		taskId: "task1",
		operation: "steer",
		message: "go",
		createdAt: "2026-06-04T00:00:00.000Z",
		...overrides,
	};
}

test.afterEach(() => clearLiveControlRealtimeForTest());

describe("publishLiveControlRealtime / subscribeLiveControlRealtime", () => {
	it("delivers messages to all subscribers", () => {
		const received: LiveAgentControlRequest[][] = [[], []];
		const unsub1 = subscribeLiveControlRealtime((r) => { received[0]!.push(r); });
		const unsub2 = subscribeLiveControlRealtime((r) => { received[1]!.push(r); });
		try {
			const req = makeRequest();
			publishLiveControlRealtime(req);
			assert.equal(received[0]!.length, 1);
			assert.equal(received[1]!.length, 1);
			assert.deepEqual(received[0]![0], req);
		} finally {
			unsub1();
			unsub2();
		}
	});

	it("unsubscribe stops delivery", () => {
		const received: LiveAgentControlRequest[] = [];
		const unsub = subscribeLiveControlRealtime((r) => { received.push(r); });
		unsub();
		publishLiveControlRealtime(makeRequest());
		assert.equal(received.length, 0);
	});

	it("supports multiple subscribers independently", () => {
		const r1: LiveAgentControlRequest[] = [];
		const r2: LiveAgentControlRequest[] = [];
		const u1 = subscribeLiveControlRealtime((r) => { r1.push(r); });
		const u2 = subscribeLiveControlRealtime((r) => { r2.push(r); });
		try {
			publishLiveControlRealtime(makeRequest({ operation: "steer" }));
			publishLiveControlRealtime(makeRequest({ operation: "stop" }));
			assert.equal(r1.length, 2);
			assert.equal(r2.length, 2);
			u1();
			publishLiveControlRealtime(makeRequest({ operation: "resume" }));
			assert.equal(r1.length, 2);
			assert.equal(r2.length, 3);
		} finally {
			u2();
		}
	});
});

describe("liveControlRealtimeMessage", () => {
	it("wraps request in standard envelope", () => {
		const req = makeRequest();
		const msg = liveControlRealtimeMessage(req);
		assert.equal(msg.type, "live-control");
		assert.equal(msg.version, 1);
		assert.equal(msg.request, req);
	});

	it("preserves all request fields", () => {
		const req = makeRequest({ operation: "follow-up", message: "check this" });
		const msg = liveControlRealtimeMessage(req);
		assert.equal(msg.request.operation, "follow-up");
		assert.equal(msg.request.message, "check this");
	});
});

describe("parseLiveControlRealtimeMessage", () => {
	it("parses valid steer message", () => {
		const req = makeRequest({ operation: "steer" });
		const msg = liveControlRealtimeMessage(req);
		const parsed = parseLiveControlRealtimeMessage(msg);
		assert.ok(parsed);
		assert.equal(parsed!.operation, "steer");
		assert.equal(parsed!.id, req.id);
	});

	it("parses valid stop message", () => {
		const req = makeRequest({ operation: "stop" });
		const parsed = parseLiveControlRealtimeMessage(liveControlRealtimeMessage(req));
		assert.ok(parsed);
		assert.equal(parsed!.operation, "stop");
	});

	it("parses valid resume message", () => {
		const req = makeRequest({ operation: "resume" });
		const parsed = parseLiveControlRealtimeMessage(liveControlRealtimeMessage(req));
		assert.ok(parsed);
		assert.equal(parsed!.operation, "resume");
	});

	it("rejects null input", () => {
		assert.equal(parseLiveControlRealtimeMessage(null), undefined);
	});

	it("rejects non-object input", () => {
		assert.equal(parseLiveControlRealtimeMessage("string"), undefined);
		assert.equal(parseLiveControlRealtimeMessage(42), undefined);
	});

	it("rejects array input", () => {
		assert.equal(parseLiveControlRealtimeMessage([]), undefined);
	});

	it("rejects wrong type field", () => {
		const msg = { type: "wrong", version: 1, request: makeRequest() };
		assert.equal(parseLiveControlRealtimeMessage(msg), undefined);
	});

	it("rejects wrong version", () => {
		const msg = { type: "live-control", version: 99, request: makeRequest() };
		assert.equal(parseLiveControlRealtimeMessage(msg), undefined);
	});

	it("rejects missing request object", () => {
		const msg = { type: "live-control", version: 1, request: null };
		assert.equal(parseLiveControlRealtimeMessage(msg), undefined);
	});

	it("rejects invalid operation", () => {
		const req = makeRequest({ operation: "invalid" as LiveAgentControlRequest["operation"] });
		// Manually craft invalid message
		const msg = { type: "live-control", version: 1, request: { ...req, operation: "invalid" } };
		assert.equal(parseLiveControlRealtimeMessage(msg), undefined);
	});
});
