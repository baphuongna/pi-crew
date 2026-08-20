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

import { readCrewAgentEventsCursor } from "../../runtime/crew-agent-records.ts";
import type { TeamRunManifest } from "../../state/types.ts";

const MAX_TRANSCRIPT_ITEMS = 500;

export type CrewTranscriptItem =
	| { type: "user"; text: string; seq: number }
	| { type: "assistant"; text: string; seq: number }
	| {
			type: "tool";
			name: string;
			toolCallId: string;
			args: Record<string, unknown>;
			result?: unknown;
			isError?: boolean;
			seq: number;
	  }
	| { type: "system"; text: string; seq: number };

type PendingTool = CrewTranscriptItem & { type: "tool" };

/** Per-task parse state, persisted across reads. */
const buffers = new Map<string, CrewTranscriptItem[]>();
const pendingByTask = new Map<string, Map<string, PendingTool>>();
const cursors = new Map<string, number>();

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
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
 * `message_end` events carry the full compacted `Message` with content parts
 * (text / toolCall / toolResult), so a single message can produce multiple
 * items: assistant text + one tool card per toolCall part, with results folded
 * into the matching start.
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

		if (message.role === "assistant") {
			const content = Array.isArray(message.content) ? message.content : [];
			const text = textFromContent(content);
			if (text) items.push({ type: "assistant", text, seq });
			// toolResult parts carry name + content; fold them into pending starts.
			for (const part of content) {
				const item = asRecord(part);
				if (!item || item.type !== "toolResult") continue;
				const name = typeof item.name === "string" ? item.name : "tool";
				matchPending(pending, name, item.content, item.isError === true);
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

function matchPending(pending: Map<string, PendingTool>, name: string, result: unknown, isError: boolean | undefined): void {
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
	if (events.length === 0) return buffers.get(taskId) ?? [];

	const pending = pendingByTask.get(taskId) ?? new Map<string, PendingTool>();
	pendingByTask.set(taskId, pending);

	let buffer = buffers.get(taskId) ?? [];
	for (const record of events) {
		const parsed = asRecord(record);
		if (!parsed) continue;
		buffer.push(...parseEventRecord(parsed, pending));
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
}

/** Clear all per-task state (session teardown / test isolation). */
export function resetAllAgentTranscriptCursors(): void {
	cursors.clear();
	buffers.clear();
	pendingByTask.clear();
}

/** Test-only: whether the module currently holds state for a task. */
export function __hasAgentTranscriptState(taskId: string): boolean {
	return buffers.has(taskId) || cursors.has(taskId) || pendingByTask.has(taskId);
}
