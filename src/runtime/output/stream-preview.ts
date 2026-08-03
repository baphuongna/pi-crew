// ─── Streaming Preview ───────────────────────────────────────────────────────
// Captures incremental worker output during task execution for live preview.
// Used by the UI layer to show partial results before task completion.

import { TAIL_CAPTURE_STREAM_STAGE } from "../compaction/compact-stages/index.ts";
import type { ParsedPiUsage } from "./pi-json-output.ts";

export interface ToolCallPreview {
	toolName: string;
	inputPreview: string;
	startedAt: number;
}

export interface StreamPreview {
	taskId: string;
	runId: string;
	/** Cumulative text output captured so far */
	textBuffer: string;
	/** Current tool call in progress (if any) */
	activeToolCall: ToolCallPreview | null;
	/** Completed tool calls count */
	toolCallCount: number;
	/** Current turn number (incremented per assistant message) */
	turnCount: number;
	/** Token usage snapshot */
	usage: Partial<ParsedPiUsage> | null;
	/** Wall-clock start time */
	startedAt: number;
	/** Last update timestamp */
	lastUpdatedAt: number;
	/** Whether the task has completed */
	finished: boolean;
}

export function createStreamPreview(taskId: string, runId: string): StreamPreview {
	const now = Date.now();
	return {
		taskId,
		runId,
		textBuffer: "",
		activeToolCall: null,
		toolCallCount: 0,
		turnCount: 0,
		usage: null,
		startedAt: now,
		lastUpdatedAt: now,
		finished: false,
	};
}

/** Max text buffer size — drop oldest content when exceeded */
const MAX_TEXT_BUFFER = 16_384;
/** Max tool input preview length */
const MAX_INPUT_PREVIEW = 512;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
	value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function truncateWithEllipsis(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength - 3) + "...";
}

function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const obj = asRecord(part);
		if (!obj) continue;
		if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
		else if (typeof obj.content === "string") parts.push(obj.content);
	}
	return parts.join("");
}

/**
 * Feed a JSON event from Pi's stdout into the preview, updating it in place.
 * Returns true if the preview was modified.
 */
export function feedJsonEvent(preview: StreamPreview, event: unknown): boolean {
	const obj = asRecord(event);
	if (!obj) return false;

	let modified = false;
	preview.lastUpdatedAt = Date.now();

	// Detect tool calls
	if (obj.type === "tool_call" || obj.type === "tool_use" || obj.type === "toolCall") {
		const toolName = typeof obj.name === "string" ? obj.name : typeof obj.tool === "string" ? obj.tool : "unknown";
		const rawInput = obj.input ?? obj.arguments ?? obj.params ?? "";
		const inputStr = typeof rawInput === "string" ? rawInput : JSON.stringify(rawInput);
		preview.activeToolCall = {
			toolName,
			inputPreview: truncateWithEllipsis(inputStr, MAX_INPUT_PREVIEW),
			startedAt: Date.now(),
		};
		preview.toolCallCount++;
		modified = true;
	}

	// Detect tool results (clear active tool call)
	if (obj.type === "tool_result" || obj.type === "toolResult" || obj.type === "result") {
		preview.activeToolCall = null;
		modified = true;
	}

	// Detect assistant text output
	const message = asRecord(obj.message);
	if (message?.role === "assistant" || obj.role === "assistant") {
		preview.turnCount++;
		const text = extractTextFromContent(message?.content ?? obj.content);
		if (text) {
			const appended = preview.textBuffer.length > 0 ? preview.textBuffer + "\n" + text : text;
			// Sprint 5: refactored onto the stage-chain. TAIL_CAPTURE_STREAM_STAGE
			// is a 16_384-char tail-capture stage with no marker (the UI shows
			// raw text without a prefix). It is bit-equivalent to the inline
			// `appended.slice(appended.length - MAX_TEXT_BUFFER)` for inputs at
			// or below the cap (returns verbatim) and equivalent for over-cap
			// inputs (returns last MAX_TEXT_BUFFER chars).
			preview.textBuffer = TAIL_CAPTURE_STREAM_STAGE.apply(appended);
		}
		modified = true;
	}

	// Detect direct text/final output
	if (typeof obj.text === "string" && obj.text.trim()) {
		const appended = preview.textBuffer.length > 0 ? preview.textBuffer + "\n" + obj.text : obj.text;
		preview.textBuffer = TAIL_CAPTURE_STREAM_STAGE.apply(appended);
		modified = true;
	}

	// Detect usage
	const rawUsage = obj.usage ?? obj.tokenUsage ?? obj.tokens ?? obj.stats;
	if (rawUsage && typeof rawUsage === "object") {
		const u = asRecord(rawUsage);
		if (u) {
			preview.usage = {
				input: typeof u.input === "number" ? u.input : preview.usage?.input,
				output: typeof u.output === "number" ? u.output : preview.usage?.output,
				cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : preview.usage?.cacheRead,
				cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : preview.usage?.cacheWrite,
				cost: typeof u.cost === "number" ? u.cost : preview.usage?.cost,
				turns: typeof u.turns === "number" ? u.turns : preview.usage?.turns,
			};
			modified = true;
		}
	}

	return modified;
}

/** Mark preview as finished */
export function finishStreamPreview(preview: StreamPreview): void {
	preview.finished = true;
	preview.activeToolCall = null;
	preview.lastUpdatedAt = Date.now();
}

/** Render a compact one-line status for the preview */
export function renderPreviewStatus(preview: StreamPreview): string {
	const elapsed = Math.round((Date.now() - preview.startedAt) / 1000);
	const parts: string[] = [];

	if (preview.finished) {
		parts.push("✓ done");
	} else if (preview.activeToolCall) {
		parts.push(`⚙ ${preview.activeToolCall.toolName}`);
	} else {
		parts.push("⟳ thinking");
	}

	parts.push(`T${preview.turnCount}`);
	parts.push(`${preview.toolCallCount} tools`);

	if (preview.usage?.input) {
		const inK = Math.round(preview.usage.input / 1024);
		parts.push(`${inK}k in`);
	}

	parts.push(`${elapsed}s`);

	return parts.join(" | ");
}
