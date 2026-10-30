/**
 * agent-transcript.ts — per-agent event JSONL → typed transcript items.
 *
 * The source of truth is the on-disk per-agent event log
 * (`<stateRoot>/agents/<taskId>/events.jsonl`), written by
 * `appendCrewAgentEventBuffered` from the single `onJsonEvent` funnel in
 * `child-executor.ts`. Events are already compacted upstream
 * (`child-pi-streams.ts:52-101`), so each record is small and shaped for
 * display.
 *
 * Disk is chosen over a pure in-memory feed because child-executor only lives
 * in the extension process for **foreground** runs; async runs execute in a
 * detached spawner, so a memory feed would show an empty pane for exactly the
 * runs users background. Disk works for both with one parser.
 *
 * Per run::task (F3), a module-level ring buffer accumulates parsed items across
 * reads (cursor + persisted parse state), mirroring pi-subtask's `fork.transcript`.
 * This matters for two reasons the naive delta-read gets wrong:
 *  - tool `start`/`end` events can straddle a read boundary, so the
 *    unmatched-start map must survive between reads;
 *  - the pane renders the FULL recent history on every tick, not just the
 *    new tail.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { readCrewAgentEventsCursor } from "../../runtime/crew-agent-records.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { stripTerminalSequences } from "../../utils/safe-terminal-text.ts";

const MAX_TRANSCRIPT_ITEMS = 500;

/** Normalize a raw usage record to pi's shape (footer/dashboard consumers
 *  read usage.input / usage.cost.total unconditionally). */
export function normalizeUsage(raw: unknown): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
} {
	const usage = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
	const toNum = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const costRaw = usage ? usage.cost : undefined;
	const costRecord = costRaw && typeof costRaw === "object" && !Array.isArray(costRaw) ? (costRaw as Record<string, unknown>) : undefined;
	return {
		input: toNum(usage?.input),
		output: toNum(usage?.output),
		cacheRead: toNum(usage?.cacheRead),
		cacheWrite: toNum(usage?.cacheWrite),
		cost: { total: toNum(costRecord?.total ?? costRaw) },
	};
}

export type CrewTranscriptItem =
	| { type: "user"; text: string; seq: number }
	| {
			type: "assistant";
			text: string;
			seq: number;
			/** The compacted assistant message (content/usage/model/stopReason),
			 *  retained so the pane can render with pi's own
			 *  AssistantMessageComponent instead of plain markdown. Usage is
			 *  normalized to pi's shape (footer/dashboard consumers read
			 *  usage.input / usage.cost.total unconditionally). */
			message?: Record<string, unknown>;
			/** Usage normalized for the pane's own footer line (parallels the
			 *  view-session builder; absent when the event carried none). */
			usage?: ReturnType<typeof normalizeUsage>;
	  }
	| {
			type: "tool";
			name: string;
			toolCallId: string;
			args: Record<string, unknown>;
			/** Normalized to ToolExecutionComponent.updateResult's shape:
			 *  `{ content: parts[], isError }` (pi's own tool-result envelope). */
			result?: { content: Array<{ type: string; text?: string }>; isError: boolean };
			isError?: boolean;
			seq: number;
	  }
	| { type: "system"; text: string; seq: number };

type PendingTool = CrewTranscriptItem & { type: "tool" };

/** Per-run::task parse state, persisted across reads (F3: keyed by run —
 *  task ids are positional per run, so a taskId-only key would let the same
 *  task name in a LATER run reuse the earlier run's cursor/buffer). */
const buffers = new Map<string, CrewTranscriptItem[]>();
const pendingByTask = new Map<string, Map<string, PendingTool>>();
const cursors = new Map<string, number>();
/** Run::task keys whose worker prompt has been prepended to the buffer. */
const promptSeeded = new Set<string>();

/** F3 (DR-02 wave 2): module-state key — `${runId}::${taskId}`. */
function transcriptStateKey(runId: string | undefined, taskId: string): string {
	return `${runId ?? ""}::${taskId}`;
}

/**
 * The child pi never logs its INITIAL user message (input is not an event),
 * so the transcript would open on the first assistant message — unlike a
 * real session. The full worker prompt is persisted at
 * `artifacts/{runId}/prompts/{taskId}.md`; seed it as the opening user item
 * for session parity. Returns undefined while the artifact has not been
 * written yet (retried on the next read).
 */
function readWorkerPrompt(manifest: TeamRunManifest, taskId: string): string | undefined {
	try {
		const file = path.join(manifest.artifactsRoot, "prompts", `${taskId}.md`);
		const text = fs.readFileSync(file, "utf-8").trim();
		return text || undefined;
	} catch {
		return undefined;
	}
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/**
 * Normalize a tool result's content into ToolExecutionComponent.updateResult's
 * envelope. The log holds either shape depending on age/source: a plain
 * string (compacted toolResult part) or an array of content parts
 * (role:"toolResult" message_end).
 */
function normalizeResultContent(raw: unknown): Array<{ type: string; text?: string }> {
	// w7a-render: every string on this path is worker-written and handed to pi
	// host components (ToolExecutionComponent) — strip terminal escape
	// sequences (OSC 52/OSC 8/CSI/APC + residual introducers) at the boundary.
	if (typeof raw === "string") return [{ type: "text", text: stripTerminalSequences(raw) }];
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((part) => {
		if (typeof part === "string") return [{ type: "text", text: stripTerminalSequences(part) }];
		const record = asRecord(part);
		if (!record) return [];
		return [
			{
				type: typeof record.type === "string" ? record.type : "text",
				text: typeof record.text === "string" ? stripTerminalSequences(record.text) : undefined,
			},
		];
	});
}

/**
 * w7a-render: sanitize the printable string fields of a retained assistant
 * message (text + thinking content parts) before the full message object is
 * handed to pi's AssistantMessageComponent, which renders them verbatim.
 * Returns the SAME object when nothing needed stripping (component-cache
 * fingerprint stays stable). Identity fields (usage/role/stopReason) and
 * non-string payloads pass through untouched.
 */
function sanitizeMessageForRender(message: Record<string, unknown>): Record<string, unknown> {
	const content = message.content;
	if (!Array.isArray(content)) return message;
	let touched = false;
	const parts = content.map((part) => {
		const record = asRecord(part);
		if (!record) return part;
		if (record.type === "text" && typeof record.text === "string") {
			const clean = stripTerminalSequences(record.text);
			if (clean !== record.text) {
				touched = true;
				return { ...record, text: clean };
			}
			return part;
		}
		if (record.type === "thinking") {
			let partTouched = false;
			const clean: Record<string, unknown> = { ...record };
			if (typeof record.thinking === "string") {
				clean.thinking = stripTerminalSequences(record.thinking);
				partTouched = clean.thinking !== record.thinking;
			}
			if (typeof record.text === "string") {
				clean.text = stripTerminalSequences(record.text);
				partTouched ||= clean.text !== record.text;
			}
			if (partTouched) {
				touched = true;
				return clean;
			}
			return part;
		}
		return part;
	});
	return touched ? { ...message, content: parts } : message;
}

/**
 * W9-R1 (w7a-render deferred residual): `tool_execution_start` event.args are
 * worker-controlled and reach pi's ToolExecutionComponent verbatim — it
 * interpolates top-level keys and string values RAW (formatToolCallWithArgs)
 * and hands the whole record to per-tool call renderers. Strip terminal
 * sequences from every string leaf (and every object key), recursing into
 * nested objects/arrays down to ARGS_SANITIZE_MAX_DEPTH. Non-string leaves
 * (numbers/booleans/null) are inert — they only ever render through
 * JSON.stringify, whose output escapes control characters — and values below
 * the depth cap likewise only surface JSON-escaped, so both are passed
 * through untouched (nothing is sanitized that is not rendered raw).
 * Returns the SAME object when nothing needed stripping (component-cache
 * fingerprint stays stable, matching sanitizeMessageForRender).
 */
const ARGS_SANITIZE_MAX_DEPTH = 6;

function sanitizeArgsForRender(
	args: Record<string, unknown>,
	depth = ARGS_SANITIZE_MAX_DEPTH,
): { value: Record<string, unknown>; touched: boolean } {
	// Null prototype: event args are unvalidated worker JSON — a "__proto__"
	// key must never reach a prototype setter on the rebuilt record (same
	// reasoning as config-validation's asRecord copy).
	const clean: Record<string, unknown> = Object.create(null);
	let touched = false;
	for (const [rawKey, rawValue] of Object.entries(args)) {
		const key = stripTerminalSequences(rawKey);
		if (key !== rawKey) touched = true;
		if (typeof rawValue === "string") {
			const value = stripTerminalSequences(rawValue);
			if (value !== rawValue) touched = true;
			clean[key] = value;
			continue;
		}
		const record = asRecord(rawValue);
		if (depth > 0 && record) {
			const nested = sanitizeArgsForRender(record, depth - 1);
			if (nested.touched) touched = true;
			clean[key] = nested.value;
			continue;
		}
		if (depth > 0 && Array.isArray(rawValue)) {
			const nested = sanitizeArgsArrayForRender(rawValue, depth - 1);
			if (nested.touched) touched = true;
			clean[key] = nested.value;
			continue;
		}
		clean[key] = rawValue;
	}
	return touched ? { value: clean, touched: true } : { value: args, touched: false };
}

function sanitizeArgsArrayForRender(items: unknown[], depth: number): { value: unknown[]; touched: boolean } {
	let touched = false;
	const clean = items.map((entry) => {
		if (typeof entry === "string") {
			const value = stripTerminalSequences(entry);
			if (value !== entry) {
				touched = true;
				return value;
			}
			return entry;
		}
		const record = asRecord(entry);
		if (depth > 0 && record) {
			const nested = sanitizeArgsForRender(record, depth - 1);
			if (nested.touched) touched = true;
			return nested.value;
		}
		if (depth > 0 && Array.isArray(entry)) {
			const nested = sanitizeArgsArrayForRender(entry, depth - 1);
			if (nested.touched) touched = true;
			return nested.value;
		}
		return entry;
	});
	return touched ? { value: clean, touched: true } : { value: items, touched: false };
}

function textFromContent(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			const item = asRecord(part);
			if (!item) return [];
			if (item.type === "text" && typeof item.text === "string") return [item.text];
			return [];
		})
		.join("\n")
		.trim();
}

/**
 * Parse compacted event records into display items.
 *
 * The compaction in `child-pi-streams.ts` drops `toolCallId` from tool events,
 * so `tool_execution_start` and its result are paired by tool name in arrival
 * order — the nearest unmatched start with the same name. This is correct for
 * sequential tool use; concurrent same-name tools are rare and the worst case
 * is a result landing on the wrong start, not a crash.
 *
 * `message_end` events carry the full compacted `Message`. Assistant messages
 * produce text items; tool cards come from `tool_execution_start` events.
 * Results arrive either as role:"toolResult" message_end records (pi ≥0.84,
 * no tool name — folded FIFO) or as toolResult parts inside older assistant
 * messages (named — folded by name).
 */
function parseEventRecord(record: Record<string, unknown>, pending: Map<string, PendingTool>): CrewTranscriptItem[] {
	const seq = typeof record.seq === "number" ? record.seq : 0;
	const event = asRecord(record.event) ?? record;
	const type = typeof event.type === "string" ? event.type : "";

	const items: CrewTranscriptItem[] = [];

	if (type === "tool_execution_start") {
		// w7a-render: toolName is interpolated into ToolExecutionComponent's title
		const name = stripTerminalSequences(typeof event.toolName === "string" ? event.toolName : "tool");
		// w9-r1 (w7a deferred): args reach ToolExecutionComponent verbatim —
		// keys and string values are interpolated raw, nested structures go to
		// call renderers. Strip terminal sequences at the parser boundary.
		const args = sanitizeArgsForRender((event.args as Record<string, unknown>) ?? {}).value;
		const id = `${name}#${seq}`;
		const item: PendingTool = { type: "tool", name, toolCallId: id, args, seq };
		pending.set(id, item);
		items.push(item);
		return items;
	}

	if (type === "tool_execution_end") {
		// The compacted end event carries NO result (child-pi-streams.ts keeps
		// only type/toolName/args). The actual result arrives as the next
		// message_end's toolResult content part, so the pending start must stay
		// in the map until that fold — removing it here would leave the card
		// permanently stuck in "started, no result". Nothing to emit.
		return items;
	}

	if (type === "message_end" || type === "message" || type === "tool_result_end") {
		const message = asRecord(event.message);
		if (!message) return items;

		if (message.role === "toolResult") {
			// pi ≥0.84 emits each tool result as its OWN message_end (role
			// "toolResult", content parts, NO tool name) instead of toolResult
			// parts inside the assistant message. Results arrive in the
			// originating message's toolCall order, and starts are pushed in
			// that same order, so fold FIFO into the oldest pending start that
			// has no result yet — correct for concurrent tools too.
			const result = {
				content: normalizeResultContent(message.content),
				isError: message.isError === true,
			};
			for (const [id, item] of pending) {
				if (item.result !== undefined) continue;
				item.result = result;
				item.isError = result.isError;
				pending.delete(id);
				break;
			}
			return items;
		}

		if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			const text = stripTerminalSequences(textFromContent(content));
			if (text) {
				// Compaction can carry usage at the RECORD level (usage-only
				// tail) instead of inside the message — merge it in so the
				// pane's full-message render and usage footer see it.
				const recordUsage = asRecord(event.usage);
				const messageUsage = asRecord(message.usage);
				let merged = message;
				if (recordUsage) {
					merged = { ...message, usage: messageUsage ? { ...messageUsage, ...recordUsage } : recordUsage };
				}
				items.push({
					type: "assistant",
					text,
					seq,
					message: sanitizeMessageForRender(merged),
					usage: normalizeUsage(merged.usage),
				});
			}
			// toolResult parts carry name + content; fold them into pending starts
			// (normalized to the same updateResult envelope as the pi ≥0.84
			// role:"toolResult" messages above).
			for (const part of content) {
				const item = asRecord(part);
				if (item?.type !== "toolResult") continue;
				// Sanitize the fold key EXACTLY like tool_execution_start names so a
				// payload-carrying toolName still pairs with its result.
				const name = stripTerminalSequences(typeof item.name === "string" ? item.name : "tool");
				const isError = item.isError === true;
				matchPending(
					pending,
					name,
					{
						content: normalizeResultContent(item.content),
						isError,
					},
					isError,
				);
			}
			return items;
		}

		if (message.role === "user") {
			const text = stripTerminalSequences(textFromContent(message.content));
			if (text) items.push({ type: "user", text, seq });
			return items;
		}
	}

	// System / other events become a dim system line.
	if (type && type !== "message_update") {
		const text = stripTerminalSequences(typeof event.text === "string" ? event.text : "");
		if (text) items.push({ type: "system", text, seq });
	}

	return items;
}

function matchPending(
	pending: Map<string, PendingTool>,
	name: string,
	result: { content: Array<{ type: string; text?: string }>; isError: boolean },
	isError: boolean | undefined,
): void {
	for (const [id, item] of [...pending.entries()].reverse()) {
		if (item.name !== name) continue;
		pending.delete(id);
		if (result !== undefined) item.result = result;
		if (isError !== undefined) item.isError = isError;
		return;
	}
}

/**
 * Read new events and return the accumulated transcript (most recent
 * MAX_TRANSCRIPT_ITEMS, chronological). Cheap when nothing new arrived: the
 * cursor skips re-parse and the existing buffer is returned as-is.
 */
export function readAgentTranscript(manifest: TeamRunManifest, taskId: string): CrewTranscriptItem[] {
	const key = transcriptStateKey(manifest.runId, taskId);
	const sinceSeq = cursors.get(key) ?? 0;
	const { events, nextSeq } = readCrewAgentEventsCursor(manifest, taskId, { sinceSeq });
	if (nextSeq > sinceSeq) cursors.set(key, nextSeq);

	let buffer = buffers.get(key) ?? [];
	if (events.length > 0) {
		const pending = pendingByTask.get(key) ?? new Map<string, PendingTool>();
		pendingByTask.set(key, pending);

		for (const record of events) {
			const parsed = asRecord(record);
			if (!parsed) continue;
			buffer.push(...parseEventRecord(parsed, pending));
		}
	}
	if (buffer.length > 0 && !promptSeeded.has(key)) {
		const prompt = readWorkerPrompt(manifest, taskId);
		if (prompt !== undefined) {
			promptSeeded.add(key);
			buffer.unshift({ type: "user", text: stripTerminalSequences(prompt), seq: 0 });
		}
	}
	if (buffer.length > MAX_TRANSCRIPT_ITEMS) {
		buffer = buffer.slice(buffer.length - MAX_TRANSCRIPT_ITEMS);
	}
	buffers.set(key, buffer);
	return buffer;
}

/** Drop everything learned about a run's task (used when the pane switches
 *  agents or runs — F3: scoped to the run so switching runs never leaves the
 *  old run's ring buffer reachable under the new one's key). */
export function resetAgentTranscriptCursor(runId: string, taskId: string): void {
	const key = transcriptStateKey(runId, taskId);
	cursors.delete(key);
	buffers.delete(key);
	pendingByTask.delete(key);
	promptSeeded.delete(key);
}

/** Clear all per-task state (session teardown / test isolation). */
export function resetAllAgentTranscriptCursors(): void {
	cursors.clear();
	buffers.clear();
	pendingByTask.clear();
	promptSeeded.clear();
}

/** Test-only: whether the module currently holds state for a run's task. */
export function __hasAgentTranscriptState(runId: string, taskId: string): boolean {
	const key = transcriptStateKey(runId, taskId);
	return buffers.has(key) || cursors.has(key) || pendingByTask.has(key);
}
