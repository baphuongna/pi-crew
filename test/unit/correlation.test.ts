import test from "node:test";
import assert from "node:assert/strict";
import { childCorrelation, correlatedEvent, getCurrentContext, newSpanId, withCorrelation } from "../../src/observability/correlation.ts";

test("correlation context propagates through async boundaries", async () => {
	const spanId = newSpanId("run-a");
	await withCorrelation({ traceId: spanId, spanId }, async () => {
		await Promise.resolve();
		assert.equal(getCurrentContext()?.traceId, spanId);
		const event = correlatedEvent({ runId: "run-a", data: { ok: true } });
		assert.equal((event.data as Record<string, unknown>)?.traceId, spanId);
	});
});

test("childCorrelation links to parent span", () => {
	const parent = newSpanId("run-b");
	withCorrelation({ traceId: parent, spanId: parent }, () => {
		const child = childCorrelation("run-b", "task-1");
		assert.equal(child.traceId, parent);
		assert.equal(child.parentSpanId, parent);
		assert.match(child.spanId, /^run-b:task-1:/);
	});
});

test("correlatedEvent is a no-op without active context", () => {
	assert.deepEqual(correlatedEvent({ runId: "r", data: { x: 1 } }), { runId: "r", data: { x: 1 } });
});
