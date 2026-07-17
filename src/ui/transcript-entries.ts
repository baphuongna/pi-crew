import { truncate } from "../utils/visual.ts";

export interface TranscriptEntry {
	id: number;
	type: "message" | "tool_call" | "tool_result" | "system";
	role?: string;
	toolName?: string;
	summary: string;
	content: string;
	expanded: boolean;
	timestamp?: number;
}

/** Extract plain text from Pi-style content (string or array of content parts). */
function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: unknown) => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return "";
			const obj = part as Record<string, unknown>;
			if (typeof obj.text === "string") return obj.text;
			if (typeof obj.content === "string") return obj.content;
			if (typeof obj.name === "string") return `[tool:${obj.name}]`;
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Safely cast unknown to a record for property access. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** Detect if an event type is a tool invocation (call/use/start). */
function isToolCallType(type: string): boolean {
	return type === "tool_call" || type === "tool_use" || type === "toolCall" || type === "tool_execution_start";
}

/** Detect if an event type is a tool response (result/end). */
function isToolResultType(type: string): boolean {
	return type === "tool_result" || type === "toolCallEnd" || type === "tool_result_end";
}

/** Extract tool name from various event shapes. */
function extractToolName(obj: Record<string, unknown>): string | undefined {
	const name =
		typeof obj.toolName === "string"
			? obj.toolName
			: typeof obj.name === "string"
				? obj.name
				: typeof obj.tool === "string"
					? obj.tool
					: undefined;
	return name;
}

/** Create a single-line summary from text, truncating if needed. */
function summarize(text: string, maxLength: number): string {
	const oneLine = text.replace(/\r?\n/g, " ").trim();
	if (oneLine.length <= maxLength) return oneLine;
	return oneLine.slice(0, maxLength - 1) + "…";
}

const SUMMARY_MAX = 120;

/** Parse raw JSONL lines into TranscriptEntry[].
 *
 * Grouping rules:
 * - tool_call events are grouped with their subsequent tool_result into one entry.
 * - message events (message_end, etc.) become their own entry.
 * - Everything else becomes a system entry.
 */
export function parseTranscriptEntries(lines: string[]): TranscriptEntry[] {
	const entries: TranscriptEntry[] = [];
	let id = 0;

	// Pre-parse valid JSON lines
	const parsed: Array<{ raw: string; obj: Record<string, unknown> }> = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const json: unknown = JSON.parse(trimmed);
			const obj = asRecord(json);
			if (obj) parsed.push({ raw: trimmed, obj });
		} catch {
			// Non-JSON line → treat as a system entry
			entries.push({
				id: id++,
				type: "system",
				summary: summarize(trimmed, SUMMARY_MAX),
				content: trimmed,
				expanded: false,
			});
		}
	}

	// FIND-18: single linear pass to match each tool_call with the next
	// tool-flavored event after it. Replaces the previous O(n²) lookahead that
	// re-scanned the suffix of the array for every tool_call. The pending slot
	// holds the most recent tool_call awaiting its result. A new tool_call
	// arriving before any result flushes the previous one as no-result (same
	// semantic as the old lookahead hitting the next tool_call). Non-tool
	// events are emitted in order and do not interrupt the pending slot,
	// matching the old lookahead's behaviour of skipping over messages.
	let pending: { obj: Record<string, unknown>; toolName: string; inputText: string; timestamp?: number } | null = null;

	const flushPending = (isError: boolean, resultText: string, resultTimestamp: number | undefined): void => {
		if (!pending) return;
		const callSummary = summarize(
			`🔧 ${pending.toolName}${pending.inputText ? `: ${summarize(pending.inputText, 60)}` : ""}`,
			SUMMARY_MAX,
		);
		const callContent = [
			`[Tool Call: ${pending.toolName}]`,
			pending.inputText || "(no input)",
			`[Result${isError ? " ✗" : " ✓"}]`,
			resultText || "(no output)",
		].join("\n");
		entries.push({
			id: id++,
			type: "tool_call",
			toolName: pending.toolName,
			summary: callSummary,
			content: callContent,
			expanded: false,
			timestamp: resultTimestamp ?? pending.timestamp,
		});
		pending = null;
	};

	for (let i = 0; i < parsed.length; i++) {
		const { obj } = parsed[i]!;
		const type = typeof obj.type === "string" ? obj.type : "";
		const timestamp = typeof obj.timestamp === "number" ? obj.timestamp : undefined;

		if (isToolCallType(type)) {
			// A new tool_call interrupts any pending one (same as the old
			// lookahead breaking on the next tool_call). Flush as no-result.
			if (pending) flushPending(false, "", undefined);
			const inputText = typeof obj.input === "string" ? obj.input : obj.input !== undefined ? JSON.stringify(obj.input) : "";
			pending = {
				obj,
				toolName: extractToolName(obj) ?? "unknown",
				inputText,
				timestamp,
			};
			continue;
		}

		if (isToolResultType(type) || /tool/i.test(type)) {
			const rt =
				typeof obj.text === "string"
					? obj.text
					: typeof obj.result === "string"
						? obj.result
						: obj.result !== undefined
							? JSON.stringify(obj.result)
							: "";
			const isError = obj.isError === true;
			const resultTimestamp = typeof obj.timestamp === "number" ? obj.timestamp : undefined;
			if (pending) {
				flushPending(isError, rt, resultTimestamp);
			} else {
				// Standalone tool result (no preceding tool_call consumed it)
				const toolName = extractToolName(obj) ?? "unknown";
				const summary = summarize(`${isError ? "✗" : "✓"} ${toolName}${rt ? `: ${summarize(rt, 60)}` : ""}`, SUMMARY_MAX);
				const content = [`[Tool Result: ${toolName}${isError ? " (error)" : ""}]`, rt || "(no output)"].join("\n");
				entries.push({
					id: id++,
					type: "tool_result",
					toolName,
					summary,
					content,
					expanded: false,
					timestamp,
				});
			}
			continue;
		}

		// Message events (message_end, message_start, etc.)
		const message = asRecord(obj.message);
		if (message || type.startsWith("message")) {
			const msg = message ?? obj;
			const role = typeof msg.role === "string" ? msg.role : "unknown";
			const text = textFromContent(msg.content);

			const label = role === "assistant" ? "🤖" : role === "user" ? "👤" : "💬";
			const summary = summarize(`${label} ${role}${text ? `: ${summarize(text, 80)}` : ""}`, SUMMARY_MAX);
			const content = `[${role.charAt(0).toUpperCase()}${role.slice(1)}]:\n${text || "(empty)"}`;

			entries.push({
				id: id++,
				type: "message",
				role,
				summary,
				content,
				expanded: false,
				timestamp,
			});
			continue;
		}

		// Everything else → system entry
		const text = textFromContent(obj.content) || (typeof obj.text === "string" ? obj.text : "");
		const displayText = text || type || JSON.stringify(obj);
		entries.push({
			id: id++,
			type: "system",
			summary: summarize(`⚙ ${type ? `[${type}]` : ""} ${summarize(displayText, 80)}`, SUMMARY_MAX),
			content: displayText,
			expanded: false,
			timestamp,
		});
	}

	// End of input: any pending tool_call never received a result.
	if (pending) flushPending(false, "", undefined);

	return entries;
}

/** Toggle expand/collapse for an entry by index. Returns a new array. */
export function toggleEntry(entries: TranscriptEntry[], index: number): TranscriptEntry[] {
	return entries.map((entry, i) => (i === index ? { ...entry, expanded: !entry.expanded } : entry));
}

/** Render entries into display lines, respecting expand/collapse.
 *  Collapsed entries produce 1 line (summary). Expanded entries produce multi-line content.
 *  Every line is truncated to maxWidth.
 */
export function renderEntries(entries: TranscriptEntry[], maxWidth: number): string[] {
	const effectiveWidth = Math.max(1, maxWidth);
	const lines: string[] = [];

	for (const entry of entries) {
		if (entry.expanded) {
			const contentLines = entry.content.split(/\r?\n/);
			if (contentLines.length === 0 || (contentLines.length === 1 && contentLines[0] === "")) {
				lines.push(truncate(`▸ ${entry.summary}`, effectiveWidth));
			} else {
				lines.push(truncate(`▾ ${entry.summary}`, effectiveWidth));
				for (const line of contentLines) {
					lines.push(truncate(`  ${line}`, effectiveWidth));
				}
			}
		} else {
			lines.push(truncate(`▸ ${entry.summary}`, effectiveWidth));
		}
	}

	return lines;
}
