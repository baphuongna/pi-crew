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
