import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamRunManifest } from "../../state/types.ts";
import { agentStateFile, ensureAgentStateDir } from "../crew-agent-records.ts";

export type LiveAgentControlOperation = "steer" | "follow-up" | "stop" | "resume";

export interface LiveAgentControlRequest {
	id: string;
	runId: string;
	taskId: string;
	agentId?: string;
	operation: LiveAgentControlOperation;
	message?: string;
	createdAt: string;
	processedAt?: string;
	error?: string;
}

export interface LiveAgentControlCursor {
	offset: number;
}

export function liveAgentControlPath(manifest: TeamRunManifest, taskId: string): string {
	return path.join(ensureAgentStateDir(manifest, taskId), "live-control.jsonl");
}

function liveAgentControlFile(manifest: TeamRunManifest, taskId: string): string {
	return agentStateFile(manifest, taskId, "live-control.jsonl");
}

function requestId(): string {
	return `ctrl_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 10)}`;
}

export function appendLiveAgentControlRequest(
	manifest: TeamRunManifest,
	input: {
		taskId: string;
		agentId?: string;
		operation: LiveAgentControlOperation;
		message?: string;
	},
): LiveAgentControlRequest {
	const request: LiveAgentControlRequest = {
		id: requestId(),
		runId: manifest.runId,
		taskId: input.taskId,
		agentId: input.agentId,
		operation: input.operation,
		message: input.message,
		createdAt: new Date().toISOString(),
	};
	const filePath = liveAgentControlFile(manifest, input.taskId);
	fs.appendFileSync(filePath, `${JSON.stringify(request)}\n`, "utf-8");
	return request;
}

export function readLiveAgentControlRequests(
	manifest: TeamRunManifest,
	taskId: string,
	cursor: LiveAgentControlCursor = { offset: 0 },
): { requests: LiveAgentControlRequest[]; cursor: LiveAgentControlCursor } {
	let filePath: string;
	try {
		filePath = liveAgentControlFile(manifest, taskId);
	} catch {
		return { requests: [], cursor };
	}
	if (!fs.existsSync(filePath)) return { requests: [], cursor };
	const text = fs.readFileSync(filePath, "utf-8");
	const lines = text.split(/\r?\n/).filter(Boolean);
	const requests = lines.slice(cursor.offset).flatMap((line) => {
		try {
			const parsed = JSON.parse(line) as LiveAgentControlRequest;
			return parsed && parsed.runId === manifest.runId && parsed.taskId === taskId ? [parsed] : [];
		} catch {
			return [];
		}
	});
	return { requests, cursor: { offset: lines.length } };
}

export async function applyLiveAgentControlRequest(input: {
	request: LiveAgentControlRequest;
	taskId: string;
	agentId: string;
	session: {
		steer?: (text: string) => Promise<void>;
		prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
		abort?: () => Promise<void> | void;
	};
	seenRequestIds?: Set<string>;
}): Promise<boolean> {
	const { request, taskId, agentId, session, seenRequestIds } = input;
	if (seenRequestIds?.has(request.id)) return false;
	if (request.agentId && request.agentId !== agentId && request.agentId !== taskId) return false;
	seenRequestIds?.add(request.id);
	if (request.operation === "steer") await session.steer?.(request.message ?? "Please report current status and wrap up if possible.");
	else if (request.operation === "follow-up")
		await session.prompt?.(request.message ?? "Please continue with the follow-up request.", {
			source: "api",
			expandPromptTemplates: false,
		});
	else if (request.operation === "resume")
		await session.prompt?.(request.message ?? "Please resume and report final status.", {
			source: "api",
			expandPromptTemplates: false,
		});
	else if (request.operation === "stop") await session.abort?.();
	return true;
}

export async function applyLiveAgentControlRequests(input: {
	manifest: TeamRunManifest;
	taskId: string;
	agentId: string;
	session: {
		steer?: (text: string) => Promise<void>;
		prompt?: (text: string, options?: Record<string, unknown>) => Promise<void>;
		abort?: () => Promise<void> | void;
	};
	cursor: LiveAgentControlCursor;
	seenRequestIds?: Set<string>;
}): Promise<LiveAgentControlCursor> {
	const batch = readLiveAgentControlRequests(input.manifest, input.taskId, input.cursor);
	for (const request of batch.requests)
		await applyLiveAgentControlRequest({
			request,
			taskId: input.taskId,
			agentId: input.agentId,
			session: input.session,
			seenRequestIds: input.seenRequestIds,
		});
	return batch.cursor;
}
