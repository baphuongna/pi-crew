import type { UsageState } from "../../state/types.ts";
import type { CrewAgentProgress } from "../crew-agent-runtime.ts";
import { emptyCrewAgentProgress } from "../crew-agent-records.ts";
import type { ProgressEventSummary } from "../progress-event-coalescer.ts";
import type { TeamTaskState } from "../../state/types.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textFromContent(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const text: string[] = [];
	for (const part of content) {
		const obj = asRecord(part);
		if (!obj) continue;
		if (obj.type === "text" && typeof obj.text === "string") text.push(obj.text);
		else if (typeof obj.content === "string") text.push(obj.content);
	}
	return text;
}

function eventText(event: unknown): string[] {
	const obj = asRecord(event);
	if (!obj) return [];
	const text: string[] = [];
	if (typeof obj.text === "string") text.push(obj.text);
	if (typeof obj.output === "string") text.push(obj.output);
	text.push(...textFromContent(obj.content));
	const message = asRecord(obj.message);
	if (message) text.push(...textFromContent(message.content));
	return text.filter((entry) => entry.trim());
}

function numberField(obj: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = obj[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

function eventUsage(event: unknown): { input?: number; output?: number; turns?: number } | undefined {
	const obj = asRecord(event);
	if (!obj) return undefined;
	const direct = { input: numberField(obj, ["input", "inputTokens", "input_tokens"]), output: numberField(obj, ["output", "outputTokens", "output_tokens"]), turns: numberField(obj, ["turns", "turnCount", "turn_count"]) };
	if (Object.values(direct).some((value) => value !== undefined)) return direct;
	for (const key of ["usage", "tokenUsage", "tokens", "stats"]) {
		const nested = eventUsage(obj[key]);
		if (nested) return nested;
	}
	const message = asRecord(obj.message);
	return message ? eventUsage(message.usage) : undefined;
}

function previewArgs(args: unknown): string | undefined {
	if (!args) return undefined;
	try {
		const text = typeof args === "string" ? args : JSON.stringify(args);
		return text.length > 240 ? `${text.slice(0, 240)}…` : text;
	} catch {
		return undefined;
	}
}

export function applyUsageToProgress(progress: CrewAgentProgress | undefined, usage: UsageState | undefined): CrewAgentProgress | undefined {
	if (!usage) return progress;
	const base = progress ?? emptyCrewAgentProgress();
	return { ...base, tokens: (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), turns: usage.turns ?? base.turns };
}

export function shouldFlushProgressEvent(event: unknown): boolean {
	const type = asRecord(event)?.type;
	return type === "tool_execution_start" || type === "tool_execution_end" || type === "message_end" || type === "tool_result_end";
}

export function progressEventSummary(task: TeamTaskState, event: unknown): ProgressEventSummary {
	const type = asRecord(event)?.type;
	return { eventType: typeof type === "string" ? type : "event", currentTool: task.agentProgress?.currentTool, toolCount: task.agentProgress?.toolCount, tokens: task.agentProgress?.tokens, turns: task.agentProgress?.turns, activityState: task.agentProgress?.activityState, lastActivityAt: task.agentProgress?.lastActivityAt };
}

export function applyAgentProgressEvent(progress: CrewAgentProgress, event: unknown, startedAt: string | undefined): CrewAgentProgress {
	const obj = asRecord(event);
	const now = new Date().toISOString();
	const next: CrewAgentProgress = { ...progress, recentTools: [...progress.recentTools], recentOutput: [...progress.recentOutput], lastActivityAt: now, activityState: "active" };
	if (startedAt) next.durationMs = Date.now() - new Date(startedAt).getTime();
	if (obj?.type === "tool_execution_start") {
		next.toolCount += 1;
		next.currentTool = typeof obj.toolName === "string" ? obj.toolName : typeof obj.name === "string" ? obj.name : "tool";
		next.currentToolArgs = previewArgs(obj.args);
		next.currentToolStartedAt = now;
	}
	if (obj?.type === "tool_execution_end") {
		if (next.currentTool) next.recentTools.push({ tool: next.currentTool, args: next.currentToolArgs, endedAt: now });
		next.currentTool = undefined;
		next.currentToolArgs = undefined;
		next.currentToolStartedAt = undefined;
	}
	if ((obj?.type === "tool_execution_error" || obj?.type === "tool_execution_failed") && next.currentTool) next.failedTool = next.currentTool;
	const usage = eventUsage(event);
	if (usage) {
		next.tokens = (usage.input ?? 0) + (usage.output ?? 0);
		next.turns = usage.turns ?? next.turns;
	}
	const text = eventText(event);
	if (text.length > 0) next.recentOutput.push(...text.flatMap((entry) => entry.split(/\r?\n/)).filter(Boolean).slice(-10));
	if (next.recentTools.length > 25) next.recentTools.splice(0, next.recentTools.length - 25);
	if (next.recentOutput.length > 50) next.recentOutput.splice(0, next.recentOutput.length - 50);
	return next;
}
