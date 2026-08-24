import type { LiveAgentControlRequest } from "./live-agent-control.ts";

export interface LiveControlRealtimeMessage {
	type: "live-control";
	version: 1;
	request: LiveAgentControlRequest;
}

type Listener = (request: LiveAgentControlRequest) => void | Promise<void>;

const listeners = new Set<Listener>();

export function publishLiveControlRealtime(request: LiveAgentControlRequest): void {
	for (const listener of [...listeners]) void listener(request);
}

export function subscribeLiveControlRealtime(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Task 26 (2026-08-24): poll-interval gate for live-session control polling.
 * True while at least one realtime listener is registered — in that mode
 * in-process control requests are delivered immediately and the file poll is
 * only a cross-process fallback, so the poller can run slower.
 */
export function hasLiveControlRealtimeListeners(): boolean {
	return listeners.size > 0;
}

export function liveControlRealtimeMessage(request: LiveAgentControlRequest): LiveControlRealtimeMessage {
	return { type: "live-control", version: 1, request };
}

export function parseLiveControlRealtimeMessage(raw: unknown): LiveAgentControlRequest | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const message = raw as {
		type?: unknown;
		version?: unknown;
		request?: unknown;
	};
	if (
		message.type !== "live-control" ||
		message.version !== 1 ||
		!message.request ||
		typeof message.request !== "object" ||
		Array.isArray(message.request)
	)
		return undefined;
	const request = message.request as Partial<LiveAgentControlRequest>;
	return typeof request.id === "string" &&
		typeof request.runId === "string" &&
		typeof request.taskId === "string" &&
		(request.operation === "steer" ||
			request.operation === "follow-up" ||
			request.operation === "stop" ||
			request.operation === "resume") &&
		typeof request.createdAt === "string"
		? (request as LiveAgentControlRequest)
		: undefined;
}

export function clearLiveControlRealtimeForTest(): void {
	listeners.clear();
}
