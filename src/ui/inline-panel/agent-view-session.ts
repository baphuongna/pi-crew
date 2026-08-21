/**
 * agent-view-session.ts — build a real pi session file from a crew agent's
 * compacted event log, so "enter to view" can open a genuine pi conversation
 * for that agent (screen swap via pi's `switchSession`).
 *
 * Source of truth: `<stateRoot>/agents/<taskId>/events.jsonl`, the compacted
 * per-agent event stream written by `appendCrewAgentEventBuffered`
 * (child-executor.ts). Compaction keeps, per assistant message, the final
 * `message_end` content parts (text / toolCall / toolResult) plus usage/model,
 * and drops toolCall/toolResult `id`s — they are re-synthesized here by
 * name+arrival-order matching, the same convention agent-transcript.ts uses.
 *
 * The produced file is a linear session (header + message entries) that
 * `SessionManager.open()` loads like any other pi session: the viewer gets pi's
 * real transcript rendering, tool cards, scrollback, and a working editor.
 *
 * The view is a SNAPSHOT: the worker keeps writing its own events.jsonl while
 * running; re-entering the view rebuilds the file from the latest events.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { agentEventsPath, agentStateDir } from "../../runtime/crew-agent-records.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import { CREW_VIEW_SESSION_BASENAME } from "./view-session-store.ts";

/** Safety cap: never materialize a view bigger than this many message entries. */
const MAX_VIEW_MESSAGE_ENTRIES = 1000;
/** Truncation guard for the synthesized lead-in user message. */
const MAX_LEADIN_CHARS = 240;

interface ViewBuildOptions {
	/** Project cwd (becomes the view session's cwd). */
	cwd: string;
	runId: string;
	taskId: string;
	/** Main session file — recorded as the view's parent session so `/tree`
	 *  shows the way back. */
	parentSessionFile?: string;
}

/** Raw record line from events.jsonl: { seq, time, event } — the `event`
 *  object is the COMPACTED event (see child-pi-streams.ts). */
interface CrewEventRecord {
	seq?: unknown;
	time?: unknown;
	event?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function asContentParts(message: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
	if (!message) return [];
	const content = message.content;
	if (!Array.isArray(content)) return [];
	return content.map(asRecord).filter((part): part is Record<string, unknown> => part !== undefined);
}

/** Fold the toolResult part into a synthesized toolCall id (name+order match). */
function foldToolResultPart(
	part: Record<string, unknown>,
	pendingCalls: string[],
	callNamesById: Map<string, string>,
	callSeq: { n: number },
): { type: string; id: string; name: string; content?: unknown; isError?: unknown } | undefined {
	const name = typeof part.name === "string" ? part.name : "tool";
	// Nearest unmatched pending call with the same name (arrival order).
	let id: string | undefined;
	for (let i = pendingCalls.length - 1; i >= 0; i--) {
		const candidate = pendingCalls[i];
		if (callNamesById.get(candidate) === name) {
			pendingCalls.splice(i, 1);
			id = candidate;
			break;
		}
	}
	if (!id) {
		// Result without a matching call in the visible window (e.g. the call
		// was compacted away) — synthesize a standalone card id.
		id = `crew-call-${++callSeq.n}`;
	}
	const folded: { type: string; id: string; name: string; content?: unknown; isError?: unknown } = {
		type: "toolResult",
		id,
		name,
	};
	if (part.content !== undefined) folded.content = part.content;
	if (part.isError !== undefined) folded.isError = part.isError;
	return folded;
}

interface PendingAssistantMessage {
	record: CrewEventRecord;
	timestamp: string;
}

/**
 * Convert compacted records into pi session message entries.
 *
 * Dedup rule: `message` and `message_end` can both carry the same assistant
 * message (stream start/final); only ONE entry is emitted per generation —
 * `message_end` wins when it carries content, otherwise the pending `message`
 * copy is flushed (a running agent's last partial message).
 */
interface ViewSessionEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: Record<string, unknown>;
}

function recordsToSessionEntries(records: CrewEventRecord[], headerTimestamp: string): ViewSessionEntry[] {
	const entries: ViewSessionEntry[] = [];
	const pendingCalls: string[] = [];
	const callNamesById = new Map<string, string>();
	const callSeq = { n: 0 };
	let entrySeq = 0;
	let pendingMessage: PendingAssistantMessage | undefined;
	// The synthesized lead-in user message anchors the chain (see the writer
	// below: line 2 is the lead-in with id crew-view-intro).
	let prevId: string | null = "crew-view-intro";

	const emitAssistant = (message: Record<string, unknown>, timestamp: string): void => {
		const parts = asContentParts(message);
		const content: Array<Record<string, unknown>> = [];
		let hasText = false;
		for (const part of parts) {
			if (part.type === "text") {
				const text = typeof part.text === "string" ? part.text : "";
				hasText = hasText || text.length > 0;
				content.push({ type: "text", text });
			} else if (part.type === "toolCall") {
				const id = `crew-call-${++callSeq.n}`;
				pendingCalls.push(id);
				callNamesById.set(id, typeof part.name === "string" ? part.name : "tool");
				const call: Record<string, unknown> = { type: "toolCall", id, name: part.name };
				if (part.input !== undefined) call.input = part.input;
				content.push(call);
			} else if (part.type === "toolResult") {
				const folded = foldToolResultPart(part, pendingCalls, callNamesById, callSeq);
				if (folded) content.push(folded);
			}
		}
		if (!hasText && content.length === 0) return;
		if (entrySeq >= MAX_VIEW_MESSAGE_ENTRIES) return;
		entrySeq += 1;
		const id = `crew-ev-${entrySeq}`;
		const entryMessage: Record<string, unknown> = {
			role: "assistant",
			content,
			// ALWAYS present: pi's interactive footer calls addUsageToTotals
			// unconditionally for assistant entries (usage-totals.js reads
			// usage.input / usage.cost.total), so a missing or non-pi-shaped
			// usage on a synthesized entry crashes the whole TUI. The worker
			// event log is compacted and may carry usage at the RECORD level
			// ({input, output, cost: number}) or inside the message; both are
			// normalized to pi's shape here.
			usage: normalizeUsage(message.usage),
		};
		if (message.model !== undefined) entryMessage.model = message.model;
		if (message.stopReason !== undefined) entryMessage.stopReason = message.stopReason;
		if (message.errorMessage !== undefined) entryMessage.errorMessage = message.errorMessage;
		entries.push({ type: "message", id, parentId: prevId, timestamp, message: entryMessage });
		prevId = id;
	};

	for (const record of records) {
		const event = asRecord(record.event) ?? {};
		const type = typeof event.type === "string" ? event.type : "";
		const timestamp = typeof record.time === "string" && record.time ? record.time : headerTimestamp;

		if (type === "message") {
			const message = asRecord(event.message);
			if (message && message.role === "assistant") pendingMessage = { record, timestamp };
			continue;
		}
		if (type === "message_end") {
			// Two compaction shapes exist: the final message may carry the
			// content and/or usage itself, or the record may be a usage-only
			// tail with `event.usage` set and no message content at all.
			const eventUsageRecord = asRecord(event.usage ?? asRecord(event.message)?.usage);
			const message = asRecord(event.message);
			const pendingAggregate = pendingMessage ? asRecord(asRecord(pendingMessage.record.event)?.message) : undefined;
			pendingMessage = undefined;
			if (message && message.role === "assistant" && asContentParts(message).length > 0) {
				// Final copy wins over the pending stream copy.
				emitAssistant({ ...message, usage: eventUsageRecord ?? message.usage }, timestamp);
			} else if (pendingAggregate && pendingAggregate.role === "assistant") {
				// Usage-only tail (or empty final copy): keep the streamed
				// content and attach the final usage, so the view never shows
				// an empty assistant turn.
				emitAssistant({ ...pendingAggregate, usage: eventUsageRecord ?? pendingAggregate.usage }, timestamp);
			}
		}
		// tool_execution_start / tool_execution_end / tool_result_end / other
		// records carry no session-visible content on their own: results fold
		// into the assistant message's toolResult parts (compaction keeps them
		// there), so they are skipped.
	}

	// Running agent: its last partial message never got a message_end yet.
	if (pendingMessage) {
		const event = asRecord(pendingMessage.record.event);
		const message = asRecord(event?.message);
		if (message && message.role === "assistant") emitAssistant(message, pendingMessage.timestamp);
	}

	return entries;
}

/**
 * Normalize any usage shape (record-level `{input, output, cost: number}`,
 * pi-shaped `{input, output, cacheRead, cacheWrite, cost: {total}}`, or
 * absent) into the shape pi's footer/dashboard reads unconditionally.
 */
function normalizeUsage(raw: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } {
	const usage = asRecord(raw);
	const toNum = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	const costRaw = usage ? usage.cost : undefined;
	const costRecord = asRecord(costRaw);
	return {
		input: toNum(usage?.input),
		output: toNum(usage?.output),
		cacheRead: toNum(usage?.cacheRead),
		cacheWrite: toNum(usage?.cacheWrite),
		cost: { total: toNum(costRecord?.total ?? costRaw) },
	};
}

function leadInText(manifest: TeamRunManifest, taskId: string, role: string | undefined): string {
	const goal = (manifest.goal || "").replace(/\s+/g, " ").trim();
	const label = role ? `${role} agent` : "agent";
	const body = goal ? `${label} · ${taskId} — ${goal}` : `${label} · ${taskId}`;
	const trimmed = body.slice(0, MAX_LEADIN_CHARS);
	return trimmed.length < body.length ? `${trimmed}…` : trimmed;
}

/**
 * Build (or rebuild) the view session file for one agent.
 *
 * @returns absolute path of the written session file, or undefined when the
 *          run/task/events cannot be resolved (caller falls back to the
 *          in-document transcript pane).
 */
export function buildAgentViewSessionFile(options: ViewBuildOptions): string | undefined {
	const loaded = loadRunManifestById(options.cwd, options.runId);
	if (!loaded) return undefined;
	const { manifest, tasks } = loaded;

	const eventsPath = agentEventsPath(manifest, options.taskId);
	if (!existsSync(eventsPath)) return undefined;

	let raw: string;
	try {
		raw = readFileSync(eventsPath, "utf8");
	} catch {
		return undefined;
	}

	const records: CrewEventRecord[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			records.push(JSON.parse(line) as CrewEventRecord);
		} catch {
			// A once-corrupt line must not break the view build.
		}
	}

	const headerTimestamp = new Date().toISOString();
	const entries = recordsToSessionEntries(records, headerTimestamp);

	const task = tasks.find((t) => t.id === options.taskId);
	const lines: string[] = [];
	lines.push(
		JSON.stringify({
			type: "session",
			version: 3,
			id: `crew-view-${options.taskId}`,
			timestamp: headerTimestamp,
			cwd: manifest.cwd || options.cwd,
			...(options.parentSessionFile ? { parentSession: options.parentSessionFile } : {}),
		}),
	);
	// Lead-in user message: what was this agent asked to do? Makes the view
	// read like a real conversation instead of an orphaned assistant log.
	const leadIn: Record<string, unknown> = {
		type: "message",
		id: "crew-view-intro",
		parentId: null,
		timestamp: headerTimestamp,
		message: { role: "user", content: [{ type: "text", text: `[crew view] ${leadInText(manifest, options.taskId, task?.role)}` }] },
	};
	lines.push(JSON.stringify(leadIn));
	for (const entry of entries) lines.push(JSON.stringify(entry));
	if (entries.length === 0) {
		// NEVER let the view file end on the user lead-in: pi resumes a session
		// whose last entry is a pending user prompt — it would start a REAL
		// model turn against the lead-in text. A zero-entry snapshot (agent
		// still starting, or an event-log race) gets an explicit placeholder so
		// the last entry is always an assistant message.
		lines.push(
			JSON.stringify({
				type: "message",
				id: "crew-ev-init",
				parentId: "crew-view-intro",
				timestamp: headerTimestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: `(${task?.role ?? "agent"} is still starting — no transcript yet)` }],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
				},
			}),
		);
	}

	const outDir = agentStateDir(manifest, options.taskId);
	try {
		mkdirSync(outDir, { recursive: true });
		writeFileSync(path.join(outDir, CREW_VIEW_SESSION_BASENAME), `${lines.join("\n")}\n`, "utf8");
	} catch {
		return undefined;
	}
	return path.join(outDir, CREW_VIEW_SESSION_BASENAME);
}
