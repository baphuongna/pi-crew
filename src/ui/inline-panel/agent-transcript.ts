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
 * Per task, a module-level ring buffer accumulates parsed items across reads
 * (cursor + persisted parse state), mirroring pi-subtask's `fork.transcript`.
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

/** Per-task parse state, persisted across reads. */
const buffers = new Map<string, CrewTranscriptItem[]>();
const pendingByTask = new Map<string, Map<string, PendingTool>>();
const cursors = new Map<string, number>();
/** Tasks whose worker prompt has been prepended to the buffer. */
const promptSeeded = new Set<string>();

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
	if (typeof raw === "string") return [{ type: "text", text: raw }];
	if (!Array.isArray(raw)) return [];
	return raw.flatMap((part) => {
		if (typeof part === "string") return [{ type: "text", text: part }];
		const record = asRecord(part);
		if (!record) return [];
		return [
			{
				type: typeof record.type === "string" ? record.type : "text",
				text: typeof record.text === "string" ? record.text : undefined,
			},
		];
	});
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
		const name = typeof event.toolName === "string" ? event.toolName : "tool";
		const args = (event.args as Record<string, unknown>) ?? {};
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
			const text = textFromContent(content);
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
				items.push({ type: "assistant", text, seq, message: merged, usage: normalizeUsage(merged.usage) });
			}
			// toolResult parts carry name + content; fold them into pending starts
			// (normalized to the same updateResult envelope as the pi ≥0.84
			// role:"toolResult" messages above).
			for (const part of content) {
				const item = asRecord(part);
				if (item?.type !== "toolResult") continue;
				const name = typeof item.name === "string" ? item.name : "tool";
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
			const text = textFromContent(message.content);
			if (text) items.push({ type: "user", text, seq });
			return items;
		}
	}

	// System / other events become a dim system line.
	if (type && type !== "message_update") {
		const text = typeof event.text === "string" ? event.text : "";
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
	const sinceSeq = cursors.get(taskId) ?? 0;
	const { events, nextSeq } = readCrewAgentEventsCursor(manifest, taskId, { sinceSeq });
	if (nextSeq > sinceSeq) cursors.set(taskId, nextSeq);

	let buffer = buffers.get(taskId) ?? [];
	if (events.length > 0) {
		const pending = pendingByTask.get(taskId) ?? new Map<string, PendingTool>();
		pendingByTask.set(taskId, pending);

		for (const record of events) {
			const parsed = asRecord(record);
			if (!parsed) continue;
			buffer.push(...parseEventRecord(parsed, pending));
		}
	}
	if (buffer.length > 0 && !promptSeeded.has(taskId)) {
		const prompt = readWorkerPrompt(manifest, taskId);
		if (prompt !== undefined) {
			promptSeeded.add(taskId);
			buffer.unshift({ type: "user", text: prompt, seq: 0 });
		}
	}
	if (buffer.length > MAX_TRANSCRIPT_ITEMS) {
		buffer = buffer.slice(buffer.length - MAX_TRANSCRIPT_ITEMS);
	}
	buffers.set(taskId, buffer);
	return buffer;
}

/** Drop everything learned about a task (used when the pane switches agents). */
export function resetAgentTranscriptCursor(taskId: string): void {
	cursors.delete(taskId);
	buffers.delete(taskId);
	pendingByTask.delete(taskId);
	promptSeeded.delete(taskId);
}

/** Clear all per-task state (session teardown / test isolation). */
export function resetAllAgentTranscriptCursors(): void {
	cursors.clear();
	buffers.clear();
	pendingByTask.clear();
	promptSeeded.clear();
}

/** Test-only: whether the module currently holds state for a task. */
export function __hasAgentTranscriptState(taskId: string): boolean {
	return buffers.has(taskId) || cursors.has(taskId) || pendingByTask.has(taskId);
}
