import assert from "node:assert/strict";
import test from "node:test";
import {
	clearLiveControlRealtimeForTest,
	liveControlRealtimeMessage,
	parseLiveControlRealtimeMessage,
	publishLiveControlRealtime,
	subscribeLiveControlRealtime,
} from "../../src/runtime/live-session/live-control-realtime.ts";

const request = {
	id: "ctrl_test",
	runId: "run",
	taskId: "task",
	agentId: "run:task",
	operation: "steer" as const,
	message: "now",
	createdAt: "2026-04-27T00:00:00.000Z",
};

test("live control realtime bus publishes control requests immediately", () => {
	clearLiveControlRealtimeForTest();
	const seen: unknown[] = [];
	const unsub = subscribeLiveControlRealtime((item) => {
		seen.push(item);
	});
	try {
		publishLiveControlRealtime(request);
		assert.deepEqual(seen, [request]);
	} finally {
		unsub();
		clearLiveControlRealtimeForTest();
	}
});

test("live control realtime envelope parses valid control messages", () => {
	const message = liveControlRealtimeMessage(request);
	assert.deepEqual(parseLiveControlRealtimeMessage(message), request);
});

test("live control realtime envelope accepts follow-up operation", () => {
	const followUp = { ...request, operation: "follow-up" as const };
	assert.deepEqual(parseLiveControlRealtimeMessage(liveControlRealtimeMessage(followUp)), followUp);
});
