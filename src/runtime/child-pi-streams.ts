/**
 * child-pi-streams.ts — Stdout/stderr line parsing + observation for child Pi.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 4). The code is a verbatim
 * copy of what lived in child-pi.ts before this extraction — only the imports
 * were updated to import from child-pi-transcript.ts (compactString,
 * compactValue, appendTranscript, flushPendingTranscriptWrites) and
 * child-pi-constants.ts (MAX_*_CHARS, MAX_LINE_BUFFER_BYTES).
 */

import { logInternalError } from "../utils/internal-error.ts";
import type { ChildPiRunInput } from "./child-pi.ts";
import { MAX_ASSISTANT_TEXT_CHARS, MAX_LINE_BUFFER_BYTES, MAX_TOOL_INPUT_CHARS, MAX_TOOL_RESULT_CHARS } from "./child-pi-constants.ts";
import { appendTranscript, compactString, compactValue, flushPendingTranscriptWrites } from "./child-pi-transcript.ts";
import { extractText } from "./pi-json-output.ts";

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function compactContentPart(part: unknown): unknown | undefined {
	const record = asRecord(part);
	if (!record) return undefined;
	if (record.type === "text")
		return {
			type: "text",
			text:
				typeof record.text === "string"
					? compactString(record.text, MAX_ASSISTANT_TEXT_CHARS, {
							preserveImportant: false,
						})
					: "",
		};
	if (record.type === "toolCall")
		return {
			type: "toolCall",
			name: record.name,
			input: compactValue(typeof record.input === "string" ? compactString(record.input, MAX_TOOL_INPUT_CHARS) : record.input),
		};
	if (record.type === "toolResult")
		return {
			type: "toolResult",
			name: record.name,
			content: compactValue(
				typeof record.content === "string" ? compactString(record.content, MAX_TOOL_RESULT_CHARS) : record.content,
			),
		};
	return undefined;
}

function compactChildPiEvent(event: unknown): unknown | undefined {
	const record = asRecord(event);
	if (!record) return undefined;
	if (record.type === "message_update") return undefined;
	if (record.type === "tool_execution_start" || record.type === "tool_execution_end") {
		return {
			type: record.type,
			toolName: record.toolName,
			args: record.args,
		};
	}
	if (record.type === "tool_result_end" || record.type === "message_end" || record.type === "message") {
		const message = asRecord(record.message);
		if (message?.role === "user" || message?.role === "system") return undefined;
		const content = Array.isArray(message?.content)
			? message.content.map(compactContentPart).filter((part) => part !== undefined)
			: undefined;
		return {
			type: record.type,
			...(typeof record.text === "string" ? { text: record.text } : {}),
			...(message
				? {
						message: {
							role: message.role,
							...(content ? { content } : {}),
							usage: message.usage,
							model: message.model,
							errorMessage: message.errorMessage,
							stopReason: message.stopReason,
						},
					}
				: {}),
			usage: record.usage,
			model: record.model,
			provider: record.provider,
			stopReason: record.stopReason,
		};
	}
	return record.type ? { type: record.type } : undefined;
}

function displayTextFromCompactEvent(event: unknown): string | undefined {
	const record = asRecord(event);
	if (!record) return undefined;
	if (record.type === "tool_execution_start") {
		return typeof record.toolName === "string" ? `tool: ${record.toolName}` : "tool started";
	}
	if (record.type !== "message" && record.type !== "message_end") return undefined;
	const message = asRecord(record.message);
	if (message?.role !== undefined && message.role !== "assistant") return undefined;
	const content = Array.isArray(message?.content) ? message.content : [];
	const text = content
		.flatMap((part) => {
			const item = asRecord(part);
			return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
		})
		.join("\n")
		.trim();
	return text || (typeof record.text === "string" ? record.text : undefined);
}

function nonJsonLineResult(line: string): {
	persistedLine: string;
	event?: unknown;
	displayLine?: string;
	json: boolean;
} {
	return { json: false, persistedLine: line, displayLine: line };
}

function compactChildPiLine(
	line: string,
	preParsed?: unknown,
): {
	persistedLine: string;
	event?: unknown;
	displayLine?: string;
	json: boolean;
} {
	// OPT-PHASE2: when the caller (emitLine) already parsed the line, pass the
	// result via preParsed to avoid a redundant JSON.parse. Standalone callers
	// without a preParsed fall back to their own parse+catch (DRY: single
	// compact+return path for both branches).
	let parsed: unknown;
	if (preParsed !== undefined) {
		parsed = preParsed;
	} else {
		try {
			parsed = JSON.parse(line);
		} catch {
			return nonJsonLineResult(line);
		}
	}
	const compact = compactChildPiEvent(parsed);
	return {
		json: true,
		event: compact,
		persistedLine: compact ? JSON.stringify(compact) : "",
		displayLine: displayTextFromCompactEvent(compact),
	};
}

export class ChildPiLineObserver {
	private buffer = "";
	private readonly input: ChildPiRunInput;
	/** F9: bounded ring buffer for RAW assistant-text fragments. Consumers
	 * (getRawFinalText) only read the last element, but the legacy implementation
	 * accumulated every fragment unconditionally, which let a verbose/long-running
	 * worker grow this array linearly with output. We retain the last 2 entries:
	 * the consumer needs the last; we keep the second-to-last only as a defensive
	 * fence against a race where a final event arrives just after the consumer
	 * read (the previous "last" is still the most-recent pre-final text in that
	 * window). 2 is well below any plausible consumer's "tail-only" need while
	 * bounding memory. */
	private static readonly MAX_RAW_TEXT_EVENTS = 2;
	private readonly rawTextEvents: string[] = [];
	/** F9: bounded ring buffer for intermediate findings. The downstream digest
	 * (getIntermediateFindings) slices the last 20, but the array previously grew
	 * to 1000s of entries. We keep MAX_INTERMEDIATE_DIGEST_LINES + headroom so
	 * the public API behaviour is preserved (still returns "last 20 lines"). */
	private static readonly MAX_INTERMEDIATE_FINDINGS = 32;
	private readonly intermediateFindings: string[] = [];

	constructor(input: ChildPiRunInput) {
		this.input = input;
	}

	observe(text: string): void {
		this.buffer += text;
		// Cap the buffer to prevent unbounded memory growth when a child process
		// produces output without newlines (RT-F8). When exceeded, force-flush
		// the buffer as a single line and log a warning.
		if (this.buffer.length > MAX_LINE_BUFFER_BYTES) {
			logInternalError(
				"child-pi.buffer-overflow",
				new Error(`Line buffer exceeded ${MAX_LINE_BUFFER_BYTES} bytes; force-flushing`),
				`bufferLen=${this.buffer.length}`,
			);
			const line = this.buffer;
			this.buffer = "";
			this.emitLine(line);
			return;
		}
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.emitLine(line);
	}

	flush(): Promise<void> {
		if (this.buffer) {
			const line = this.buffer;
			this.buffer = "";
			this.emitLine(line);
		}
		// OPT-06 follow-up: appendTranscript is fire-and-forget async, so the file
		// may not exist on disk by the time this returns. Drain the module-scoped
		// transcript batch buffer before resolving so callers that immediately read the
		// transcript file (e.g. integration tests at phase4-runtime:37/:68/:103
		// after `await observer.flush()`) see the full content.
		return flushPendingTranscriptWrites();
	}

	/** Last non-empty RAW assistant text (mirrors {@link parsePiJsonOutput}'s
	 *  finalText semantics but uncapped). Undefined when no assistant text was
	 *  seen by this observer. {@link extractText} already drops empty fragments,
	 *  so the last entry is the final assistant utterance. */
	getRawFinalText(): string | undefined {
		return this.rawTextEvents.length > 0 ? this.rawTextEvents[this.rawTextEvents.length - 1] : undefined;
	}

	/** #7 hardening: returns a bounded digest of intermediate findings accumulated
	 *  during the run. This is NOT the final answer — it is a best-effort capture
	 *  of the last assistant text or tool-result display lines before budget
	 *  exhaustion. Only populated when getRawFinalText() would return undefined.
	 *  @param maxChars - maximum total characters to return (default 500). */
	getIntermediateFindings(maxChars = 500): string {
		const MAX_INTERMEDIATE_DIGEST_LINES = 20;
		if (this.intermediateFindings.length === 0) return "";
		// Take the last N lines and join, then cap.
		const lines = this.intermediateFindings.slice(-MAX_INTERMEDIATE_DIGEST_LINES);
		const joined = lines.join("\n");
		if (joined.length <= maxChars) return joined;
		// Return the tail within the budget.
		return joined.slice(-maxChars);
	}

	private emitLine(line: string): void {
		if (!line.trim()) return;
		// OPT-PHASE2: parse the line EXACTLY ONCE. The parsed value feeds both
		// (a) raw assistant-text extraction for the authoritative result and
		// (b) compaction for the telemetry transcript — previously each path
		// called JSON.parse independently (2 parses/line). When the line is not
		// valid JSON, parsed stays undefined and compactChildPiLine runs its own
		// catch path to produce the json:false fallback.
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			parsed = undefined;
		}
		if (parsed !== undefined) {
			const rawTexts = extractText(parsed);
			if (rawTexts.length > 0) {
				// F9: trim from the front if the push would exceed the cap. Slice's
				// second arg excludes the index, so this drops the oldest entries
				// while keeping the freshly pushed tail.
				this.rawTextEvents.push(...rawTexts);
				const rawOverflow = this.rawTextEvents.length - ChildPiLineObserver.MAX_RAW_TEXT_EVENTS;
				if (rawOverflow > 0) this.rawTextEvents.splice(0, rawOverflow);
				// Also capture raw assistant text as intermediate findings — the last raw
				// text may be a partial answer before the worker ran out of budget.
				const last = rawTexts[rawTexts.length - 1];
				if (last.trim().length > 0) {
					this.intermediateFindings.push(last.trim());
					const findingsOverflow = this.intermediateFindings.length - ChildPiLineObserver.MAX_INTERMEDIATE_FINDINGS;
					if (findingsOverflow > 0) this.intermediateFindings.splice(0, findingsOverflow);
				}
			}
		}
		// OPT-PHASE2: construct the non-JSON fallback directly when parsing failed,
		// so a broken line triggers exactly ONE (failed) parse instead of two.
		const compact = parsed !== undefined ? compactChildPiLine(line, parsed) : nonJsonLineResult(line);
		if (compact.event !== undefined) {
			try {
				this.input.onJsonEvent?.(compact.event);
			} catch (error) {
				logInternalError("child-pi.on-json-event", error, `line=${compact.persistedLine ?? compact.displayLine ?? ""}`);
			}
		}
		if (compact.persistedLine) appendTranscript(this.input, compact.persistedLine);
		if (compact.displayLine?.trim()) {
			try {
				this.input.onStdoutLine?.(compact.displayLine);
			} catch (error) {
				logInternalError("child-pi.on-stdout-line", error, `line=${compact.displayLine}`);
			}
			// #7 hardening: capture display lines (tool results, stdout) as intermediate
			// findings. This ensures we capture tool output even when no assistant text
			// is emitted (budget exhausted on tool calls).
			this.intermediateFindings.push(compact.displayLine!.trim());
			const findingsOverflow = this.intermediateFindings.length - ChildPiLineObserver.MAX_INTERMEDIATE_FINDINGS;
			if (findingsOverflow > 0) this.intermediateFindings.splice(0, findingsOverflow);
		}
	}
}
