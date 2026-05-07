import { subprocessToolRegistry, type SubprocessToolEvent } from "./subprocess-tool-registry.ts";

export interface YieldResult {
	summary: string;
	artifacts?: Record<string, string>;
	structuredData?: Record<string, unknown>;
	toolCallId: string;
}

export interface YieldConfig {
	enabled: boolean;
	maxReminders: number;
	reminderPrompt: string;
}

export const DEFAULT_YIELD_CONFIG: YieldConfig = {
	enabled: true,
	maxReminders: 3,
	reminderPrompt: "You must call the submit_result tool to return your results.",
};

/** Tool name used by workers to yield their result. */
export const YIELD_TOOL_NAME = "submit_result";

/**
 * Check if a JSON event represents a yield/submit_result tool call.
 * Supports event types: tool_execution_start, toolCall, tool_call.
 */
export function isYieldEvent(event: Record<string, unknown>): boolean {
	const type = event.type;
	if (type !== "tool_execution_start" && type !== "toolCall" && type !== "tool_call") return false;
	const toolName = event.toolName ?? event.name ?? event.tool;
	return toolName === YIELD_TOOL_NAME;
}

/**
 * Extract structured result from a yield event.
 */
export function extractYieldResult(event: Record<string, unknown>): YieldResult | undefined {
	if (!isYieldEvent(event)) return undefined;
	const args = event.args as Record<string, unknown> | undefined;
	if (!args) return undefined;
	const summary = typeof args.summary === "string" ? args.summary : "";
	const toolCallId = typeof event.toolCallId === "string" ? event.toolCallId : "";
	if (!summary) return undefined;
	const result: YieldResult = { summary, toolCallId };
	if (args.artifacts && typeof args.artifacts === "object" && !Array.isArray(args.artifacts)) {
		result.artifacts = args.artifacts as Record<string, string>;
	}
	if (args.structuredData && typeof args.structuredData === "object" && !Array.isArray(args.structuredData)) {
		result.structuredData = args.structuredData as Record<string, unknown>;
	}
	return result;
}

/**
 * Check if a worker output sequence contains a yield.
 */
export function hasYieldInOutput(events: Record<string, unknown>[]): boolean {
	return events.some((event) => isYieldEvent(event));
}

/**
 * Build a reminder prompt for workers that haven't yielded.
 */
export function buildYieldReminder(attempt: number, maxAttempts: number): string {
	return `[Yield Reminder ${attempt}/${maxAttempts}] ${DEFAULT_YIELD_CONFIG.reminderPrompt}`;
}

/**
 * Register the submit_result tool handler in the subprocess tool registry.
 */
export function registerYieldTool(): void {
	subprocessToolRegistry.register<YieldResult>(YIELD_TOOL_NAME, {
		extractData(event: SubprocessToolEvent): YieldResult | undefined {
			const args = event.args;
			if (!args) return undefined;
			const summary = typeof args.summary === "string" ? args.summary : "";
			if (!summary) return undefined;
			const result: YieldResult = { summary, toolCallId: event.toolCallId };
			if (args.artifacts && typeof args.artifacts === "object" && !Array.isArray(args.artifacts)) {
				result.artifacts = args.artifacts as Record<string, string>;
			}
			if (args.structuredData && typeof args.structuredData === "object" && !Array.isArray(args.structuredData)) {
				result.structuredData = args.structuredData as Record<string, unknown>;
			}
			return result;
		},
		shouldTerminate(): boolean {
			return true;
		},
	});
}
