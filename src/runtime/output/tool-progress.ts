/**
 * Tool Progress Event System
 *
 * Provides real-time visibility into tool execution within child Pi workers.
 *
 * Event flow:
 * 1. Child Pi emits JSON events on stdout (tool_execution_start, tool_execution_end, etc.)
 * 2. child-pi.ts parses these events and passes them to onJsonEvent callback
 * 3. task-runner.ts calls applyAgentProgressEvent() to update task state
 * 4. This module provides structured types and utilities for the event system
 */

import type { CrewAgentProgress } from "../../state/types.ts";

// ── Event Types ─────────────────────────────────────────────────────────

export interface ToolExecutionStartEvent {
	type: "tool_execution_start";
	toolName: string;
	toolCallId: string;
	args?: Record<string, unknown>;
	timestamp: number;
}

export interface ToolExecutionEndEvent {
	type: "tool_execution_end";
	toolName: string;
	toolCallId: string;
	result?: unknown;
	timestamp: number;
}

export interface ToolExecutionUpdateEvent {
	type: "tool_execution_update";
	toolName: string;
	toolCallId: string;
	partialResult?: unknown;
	timestamp: number;
}

export interface ToolExecutionErrorEvent {
	type: "tool_execution_error" | "tool_execution_failed";
	toolName: string;
	toolCallId: string;
	error?: string;
	timestamp: number;
}

export interface MessageEndEvent {
	type: "message_end";
	message: {
		role: "assistant" | "user" | "system";
		content?: unknown[];
		usage?: UsageStats;
		model?: string;
		stopReason?: string;
	};
	timestamp: number;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total: number };
	turns?: number;
	totalTokens?: number;
}

// Union type of all tool progress events
export type ToolProgressEvent =
	| ToolExecutionStartEvent
	| ToolExecutionEndEvent
	| ToolExecutionUpdateEvent
	| ToolExecutionErrorEvent
	| MessageEndEvent;

// ── Event Utilities ───────────────────────────────────────────────────────

/**
 * Extract tool name from any event type
 */
export function getToolName(event: ToolProgressEvent): string | undefined {
	if ("toolName" in event) return event.toolName;
	return undefined;
}

/**
 * Check if event indicates tool is running
 */
export function isToolRunning(event: ToolProgressEvent): boolean {
	return event.type === "tool_execution_start";
}

/**
 * Check if event indicates tool completed
 */
export function isToolComplete(event: ToolProgressEvent): boolean {
	return event.type === "tool_execution_end";
}

/**
 * Check if event indicates tool failed
 */
export function isToolError(event: ToolProgressEvent): boolean {
	return event.type === "tool_execution_error" || event.type === "tool_execution_failed";
}

/**
 * Get usage stats from message_end event
 */
export function getUsage(event: ToolProgressEvent): UsageStats | undefined {
	if (event.type === "message_end" && event.message?.usage) {
		return event.message.usage as UsageStats;
	}
	return undefined;
}

// ── Progress Display ──────────────────────────────────────────────────────

export interface ToolProgressDisplay {
	/** Current/last tool being executed */
	currentTool?: string;
	/** Preview of tool arguments (truncated) */
	currentToolArgs?: string;
	/** When tool started */
	currentToolStartedAt?: string;
	/** All recent tools with their args */
	recentTools: Array<{
		tool: string;
		args?: string;
		startedAt?: string;
		endedAt?: string;
		status: "running" | "done" | "error";
	}>;
	/** Token usage snapshot */
	tokens?: number;
	/** Context window usage percentage */
	contextPercent?: number;
	/** Total tool count */
	toolCount: number;
	/** Last activity timestamp */
	lastActivityAt?: string;
	/** Activity state */
	activityState: "active" | "idle" | "done";
}

/**
 * Format tool progress for display
 */
export function formatToolProgress(progress: CrewAgentProgress, maxContextTokens = 128000): ToolProgressDisplay {
	const recentTools: Array<{
		tool: string;
		args?: string;
		startedAt?: string;
		endedAt?: string;
		status: "running" | "done" | "error";
	}> = progress.recentTools.map((t) => ({
		tool: t.tool,
		args: t.args,
		startedAt: t.startedAt,
		endedAt: t.endedAt,
		status: t.endedAt ? ("done" as const) : ("running" as const),
	}));

	// If there's a currentTool but no endedAt, it's still running
	const currentRunning = progress.recentTools.find((t) => !t.endedAt && t.tool === progress.currentTool);
	if (currentRunning && progress.currentTool) {
		recentTools.push({
			tool: progress.currentTool,
			args: progress.currentToolArgs,
			startedAt: progress.currentToolStartedAt,
			endedAt: undefined as string | undefined,
			status: "running" as const,
		});
	}

	const tokens = progress.tokens ?? 0;
	const contextPercent = maxContextTokens > 0 ? Math.round((tokens / maxContextTokens) * 100) : 0;

	return {
		currentTool: progress.currentTool,
		currentToolArgs: progress.currentToolArgs,
		currentToolStartedAt: progress.currentToolStartedAt,
		recentTools,
		tokens,
		contextPercent,
		toolCount: progress.toolCount,
		lastActivityAt: progress.lastActivityAt,
		activityState: progress.activityState as "active" | "idle" | "done",
	};
}

/**
 * Format a single line summary of current tool
 */
export function formatCurrentToolLine(progress: CrewAgentProgress): string {
	if (!progress.currentTool) return "";

	const args = progress.currentToolArgs
		? ` ${progress.currentToolArgs.slice(0, 50)}${progress.currentToolArgs.length > 50 ? "..." : ""}`
		: "";

	const toolCount = progress.toolCount > 0 ? ` (${progress.toolCount})` : "";

	return `${progress.currentTool}${args}${toolCount}`;
}

/**
 * Format token usage for display
 */
export function formatTokenUsage(progress: CrewAgentProgress, maxTokens = 128000): string {
	const tokens = progress.tokens ?? 0;
	const percent = maxTokens > 0 ? Math.round((tokens / maxTokens) * 100) : 0;
	return `${tokens.toLocaleString()} / ${maxTokens.toLocaleString()} (${percent}%)`;
}

// ── Progress Bar Rendering ────────────────────────────────────────────────

export interface ProgressBarOptions {
	width?: number;
	showPercent?: boolean;
	showCount?: boolean;
}

/**
 * Render a progress bar for tool execution
 */
export function renderProgressBar(progress: CrewAgentProgress, options: ProgressBarOptions = {}): string {
	const width = options.width ?? 20;
	const showPercent = options.showPercent ?? true;
	const showCount = options.showCount ?? true;

	// Calculate based on recent tools (max 10)
	const recentCount = Math.min(progress.recentTools.length, 10);
	const filled = Math.round((recentCount / 10) * width);
	const empty = width - filled;

	const bar = "█".repeat(filled) + "░".repeat(empty);
	const percent = showPercent ? ` ${progress.toolCount} tools` : "";
	const tokens = progress.tokens ? ` | ${(progress.tokens / 1000).toFixed(1)}k tokens` : "";

	return `[${bar}]${percent}${tokens}`;
}

// ── Event Filtering ──────────────────────────────────────────────────────

/**
 * Filter events to only tool execution events
 */
export function filterToolEvents(events: ToolProgressEvent[]): ToolProgressEvent[] {
	return events.filter(
		(e) =>
			e.type === "tool_execution_start" ||
			e.type === "tool_execution_end" ||
			e.type === "tool_execution_update" ||
			e.type === "tool_execution_error" ||
			e.type === "tool_execution_failed",
	);
}

/**
 * Get events for a specific tool
 */
export function getEventsForTool(events: ToolProgressEvent[], toolName: string): ToolProgressEvent[] {
	return events.filter((e) => {
		if ("toolName" in e) return e.toolName === toolName;
		return false;
	});
}

/**
 * Check if any event indicates an error
 */
export function hasError(events: ToolProgressEvent[]): boolean {
	return events.some(isToolError);
}
