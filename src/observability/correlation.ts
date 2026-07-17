import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export interface CorrelationContext {
	traceId: string;
	parentSpanId?: string;
	spanId: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export function withCorrelation<T>(ctx: CorrelationContext, fn: () => T): T {
	return storage.run(ctx, fn);
}

export function getCurrentContext(): CorrelationContext | undefined {
	return storage.getStore();
}

export function newSpanId(runId: string, taskId = "main"): string {
	// OBS-4: random 8-hex-char suffix — bounded length, collision-resistant across
	// module reloads (the old monotonic counter collided after HMR and grew unboundedly).
	return `${runId}:${taskId}:${randomBytes(4).toString("hex")}`;
}

export function childCorrelation(runId: string, taskId: string): CorrelationContext {
	const parent = getCurrentContext();
	const spanId = newSpanId(runId, taskId);
	return {
		traceId: parent?.traceId ?? spanId,
		parentSpanId: parent?.spanId,
		spanId,
	};
}

export function correlatedEvent<T extends { runId?: string; data?: Record<string, unknown> }>(
	event: T,
): T & { data: Record<string, unknown> } {
	const ctx = getCurrentContext();
	if (!ctx) return event as T & { data: Record<string, unknown> };
	return {
		...event,
		data: {
			...(event.data ?? {}),
			traceId: ctx.traceId,
			spanId: ctx.spanId,
			parentSpanId: ctx.parentSpanId,
		},
	};
}
