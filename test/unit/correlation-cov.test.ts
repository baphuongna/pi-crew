import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childCorrelation, correlatedEvent, getCurrentContext, newSpanId, withCorrelation } from "../../src/observability/correlation.ts";

describe("withCorrelation", () => {
	it("sets context within callback", () => {
		const ctx = { traceId: "trace-1", spanId: "span-1" };
		withCorrelation(ctx, () => {
			assert.deepEqual(getCurrentContext(), ctx);
		});
	});

	it("clears context after callback", () => {
		const ctx = { traceId: "trace-2", spanId: "span-2" };
		withCorrelation(ctx, () => {
			// context is active
		});
		assert.equal(getCurrentContext(), undefined);
	});

	it("restores previous context after nested callback", () => {
		const outer = { traceId: "outer", spanId: "outer-span" };
		const inner = { traceId: "inner", spanId: "inner-span" };
		withCorrelation(outer, () => {
			assert.equal(getCurrentContext()?.traceId, "outer");
			withCorrelation(inner, () => {
				assert.equal(getCurrentContext()?.traceId, "inner");
			});
			assert.equal(getCurrentContext()?.traceId, "outer");
		});
	});
});

describe("getCurrentContext", () => {
	it("returns undefined outside of withCorrelation", () => {
		assert.equal(getCurrentContext(), undefined);
	});
});

describe("newSpanId", () => {
	it("generates span ID with runId and taskId", () => {
		const spanId = newSpanId("run-abc", "task-1");
		// OBS-4: 8-hex-char random suffix (was numeric counter)
		assert.match(spanId, /^run-abc:task-1:[0-9a-f]{8}$/);
	});

	it("defaults taskId to 'main'", () => {
		const spanId = newSpanId("run-xyz");
		assert.match(spanId, /^run-xyz:main:[0-9a-f]{8}$/);
	});

	it("produces unique span IDs across calls", () => {
		const a = newSpanId("r", "t");
		const b = newSpanId("r", "t");
		assert.notEqual(a, b, "random suffix should differ");
	});
});

describe("childCorrelation", () => {
	it("creates child with parent span linkage", () => {
		const parentCtx = { traceId: "parent-trace", spanId: "parent-span" };
		withCorrelation(parentCtx, () => {
			const child = childCorrelation("run-1", "subtask");
			assert.equal(child.traceId, "parent-trace");
			assert.equal(child.parentSpanId, "parent-span");
			assert.match(child.spanId, /^run-1:subtask:[0-9a-f]{8}$/);
		});
	});

	it("uses spanId as traceId when no parent context", () => {
		const child = childCorrelation("run-2", "orphan");
		assert.equal(child.parentSpanId, undefined);
		// traceId should be the spanId itself since no parent
		assert.equal(child.traceId, child.spanId);
	});

	it("generates different span IDs for different task IDs", () => {
		const parentCtx = { traceId: "trace", spanId: "span" };
		withCorrelation(parentCtx, () => {
			const child1 = childCorrelation("run", "task-a");
			const child2 = childCorrelation("run", "task-b");
			assert.notEqual(child1.spanId, child2.spanId);
			assert.ok(child1.spanId.includes("task-a"));
			assert.ok(child2.spanId.includes("task-b"));
		});
	});
});

describe("correlatedEvent", () => {
	it("adds correlation data when context is active", () => {
		const ctx = { traceId: "my-trace", spanId: "my-span" };
		withCorrelation(ctx, () => {
			const event = correlatedEvent({ runId: "run-1" });
			assert.equal(event.data.traceId, "my-trace");
			assert.equal(event.data.spanId, "my-span");
		});
	});

	it("preserves existing data when adding correlation", () => {
		const ctx = { traceId: "t", spanId: "s", parentSpanId: "p" };
		withCorrelation(ctx, () => {
			const event = correlatedEvent({ runId: "r", data: { foo: "bar" } });
			assert.equal(event.data.foo, "bar");
			assert.equal(event.data.traceId, "t");
			assert.equal(event.data.spanId, "s");
			assert.equal(event.data.parentSpanId, "p");
		});
	});

	it("returns event unchanged when no context", () => {
		const event = correlatedEvent({ runId: "r", data: { x: 1 } });
		assert.equal(event.data.x, 1);
		// traceId and spanId should not be added
		assert.equal(event.data.traceId, undefined);
		assert.equal(event.data.spanId, undefined);
	});

	it("initializes data if not provided", () => {
		const ctx = { traceId: "t", spanId: "s" };
		withCorrelation(ctx, () => {
			const event = correlatedEvent({ runId: "r" });
			assert.equal(event.data.traceId, "t");
			assert.equal(event.data.spanId, "s");
		});
	});
});
