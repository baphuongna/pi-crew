import { AsyncLocalStorage } from "node:async_hooks";

export interface CorrelationContext {
	traceId: string;
	parentSpanId?: string;
	spanId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();
let spanCounter = 0;

export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

export function getCurrentContext(): CorrelationContext | undefined {
	return storage.getStore();
}

export function newSpanId(runId: string, taskId = "main"): string {
	spanCounter += 1;
	return `${runId}:${taskId}:${spanCounter}`;
}

export function childCorrelation(runId: string, taskId: string): CorrelationContext {
	const parent = getCurrentContext();
	const spanId = newSpanId(runId, taskId);
	return { traceId: parent?.traceId ?? spanId, parentSpanId: parent?.spanId, spanId };
}

export function correlatedEvent<T extends { runId?: string; data?: Record<string, unknown> }>(event: T): T {
	const ctx = getCurrentContext();
	if (!ctx) return event;
	return { ...event, data: { ...(event.data ?? {}), traceId: ctx.traceId, spanId: ctx.spanId, parentSpanId: ctx.parentSpanId } };
}
