/**
 * agent-view-session.ts — build a real pi session file from a crew agent's
 * compacted event log, so "enter to view" can open a genuine pi conversation
 * for that agent (screen swap via pi's `switchSession`).
 *
 * Source of truth, PRIMARY: the worker's OWN pi session file
 * (`~/.pi/agent/sessions/<cwd-stem>/<worker-session>.jsonl`). The view is a
 * byte-for-byte copy of the worker's real conversation (task prompt, tool
 * calls, usage, ids, timestamps — everything a pi session is), with only the
 * header extended by `parentSession` so `/crew-back` can return. It is
 * re-copied on a cadence while the worker keeps writing, so the view lives.
 *
 * FALLBACK (worker session file not found / ambiguous): build from
 * `<stateRoot>/agents/<taskId>/events.jsonl`, the compacted per-agent event
 * stream written by `appendCrewAgentEventBuffered` (child-executor.ts).
 * Compaction keeps, per assistant message, the final `message_end` content
 * parts (text / toolCall / toolResult) plus usage/model, and drops
 * toolCall/toolResult `id`s — they are re-synthesized here by
 * name+arrival-order matching, the same convention agent-transcript.ts uses.
 *
 * The produced file is a linear session (header + message entries) that
 * `SessionManager.open()` loads like any other pi session: the viewer gets pi's
 * real transcript rendering, tool cards, scrollback, and a working editor.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { agentEventsPath, agentStateDir } from "../../runtime/crew-agent-records.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";
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
	/** pi's sessions root (~/.pi/agent/sessions). When absent, derived from
	 *  `parentSessionFile`'s dirname (falls back to the default home path). */
	sessionRoot?: string;
}

/** Safety cap for the copied worker session file (bytes). */
const MAX_WORKER_SESSION_COPY_BYTES = 16 * 1024 * 1024;
/** How far back (ms) a candidate worker session may predate the task start. */
const WORKER_SESSION_WINDOW_LEAD_MS = 5_000;
/** How far past the task finish a candidate may still be flushed (ms). */
const WORKER_SESSION_WINDOW_TRAIL_MS = 15_000;
/** Fragment fallback when the task has no title: input for disambiguation. */
const WORKER_SESSION_MATCH_READ_BYTES = 32 * 1024;

/**
 * Path of pi's session directory for a given cwd — the same layout pi uses
 * (`~/.pi/agent/sessions/--home-bom-source-my_pi--` for
 * `/home/bom/source/my_pi`). The worker pi processes write their sessions
 * here, keyed by THEIR cwd (the run workspace).
 */
function workerSessionDirFor(cwd: string, sessionRoot?: string): string {
	const root = sessionRoot ?? path.join(os.homedir(), ".pi", "agent", "sessions");
	const stem = `--${cwd.replace(/^\/+/, "").replace(/[\\/]/g, "-")}--`;
	return path.join(root, stem);
}

/**
 * Map a session FILE to pi's sessions ROOT. Pi nests session files under a
 * cwd-stem subdir: `~/.pi/agent/sessions/--<cwd-stem>--/<file>.jsonl`, so the
 * root is the PARENT of the file's own directory — passing the file's dirname
 * as the "root" would make `workerSessionDirFor` re-join the stem
 * (`--stem--/--stem--`) and never match the worker's file. Files that sit
 * directly in a root (no stem dir) map to that root unchanged.
 */
export function sessionsRootFromFile(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const dir = path.dirname(sessionFile);
	return /^--.+--$/.test(path.basename(dir)) ? path.dirname(dir) : dir;
}

/**
 * A TASK-SPECIFIC fragment for disambiguation.
 *
 * The run goal is embedded in EVERY worker's prompt, so it identifies nothing:
 * used as a fragment it "matched" whichever sibling session had already
 * flushed its prompt — typically the PREVIOUS task's worker (the view for
 * 02_plan then showed 01_explore's session). Only the task's own title
 * qualifies, and only when it actually differs from the goal.
 */
function taskMatchFragment(manifest: TeamRunManifest, task: { title?: string } | undefined): string | undefined {
	const raw = (task?.title ?? "").replace(/\s+/g, " ").trim();
	if (!raw) return undefined;
	const goal = (manifest.goal ?? "").replace(/\s+/g, " ").trim();
	if (goal && (raw === goal || goal.includes(raw))) return undefined;
	return raw.slice(0, 80);
}

/**
 * Session START time from pi's session filename
 * (`2026-08-22T09-55-38-850Z_<uuid>.jsonl`).
 *
 * Creation time is what identifies a worker's session: a worker's file is
 * created right after its task starts, while its MTIME keeps moving for as
 * long as it writes — the previous task's worker therefore stayed inside the
 * next task's mtime window and won a "newest wins" comparison.
 */
function sessionFileStartMs(name: string): number | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
	if (!match) return undefined;
	const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function fileContainsFragment(file: string, fragment: string): boolean {
	try {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(WORKER_SESSION_MATCH_READ_BYTES);
			const n = readSync(fd, buf, 0, buf.length, 0);
			return buf.toString("utf8", 0, n).toLowerCase().includes(fragment.toLowerCase());
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

/**
 * Locate the worker's OWN pi session file for a task.
 *
 * The view must be the worker's real session (not a re-synthesis): the worker
 * pi writes its session under `~/.pi/agent/sessions/<cwd-stem>/`, with a file
 * created when the worker starts. Candidates are matched by creation window
 * (task startedAt … now/finishedAt) and disambiguated by content: every
 * worker session embeds the task prompt, so a distinctive fragment of the
 * task title/goal pins the right file when several workers ran in parallel.
 *
 * @returns the absolute path of the worker's session file, or undefined.
 */
function resolveWorkerSessionFile(
	options: ViewBuildOptions,
	manifest: TeamRunManifest,
	task: { startedAt?: string; finishedAt?: string; title?: string } | undefined,
): string | undefined {
	const dir = workerSessionDirFor(options.cwd, options.sessionRoot);
	let files: string[] = [];
	try {
		if (!existsSync(dir)) return undefined;
		files = readdirSync(dir);
	} catch {
		return undefined;
	}
	const now = Date.now();
	const started = task?.startedAt ? Date.parse(task.startedAt) : undefined;
	const finished = task?.finishedAt ? Date.parse(task.finishedAt) : undefined;
	// No task timing yet (still starting): only accept files younger than the
	// view-open attempt, so a stale session from a previous run never matches.
	const windowStart = Number.isFinite(started) ? (started as number) - WORKER_SESSION_WINDOW_LEAD_MS : now - 10 * 60_000;
	const windowEnd = (Number.isFinite(finished) ? (finished as number) : now) + WORKER_SESSION_WINDOW_TRAIL_MS;
	const mainFile = options.parentSessionFile ? path.resolve(options.parentSessionFile) : undefined;

	const candidates: { file: string; createdMs: number }[] = [];
	for (const name of files) {
		if (!name.endsWith(".jsonl")) continue;
		const full = path.join(dir, name);
		if (mainFile && path.resolve(full) === mainFile) continue;
		try {
			const st = statSync(full);
			if (!st.isFile()) continue;
			// Match on CREATION, not mtime: a still-writing sibling worker would
			// otherwise fall inside every later task's window.
			// Files not following pi's naming fall back to mtime (best available).
			const createdMs = sessionFileStartMs(name) ?? st.mtimeMs;
			if (createdMs < windowStart || createdMs > windowEnd) continue;
			candidates.push({ file: full, createdMs });
		} catch {
			/* unreadable/stale — skip */
		}
	}
	if (candidates.length === 0) return undefined;
	// Known task start → the worker created FIRST after it is this task's.
	// Unknown start (task still spawning) → the most recent file is the closest
	// guess, since the window is then just "the last 10 minutes".
	const knownStart = Number.isFinite(started);
	candidates.sort((a, b) => (knownStart ? a.createdMs - b.createdMs : b.createdMs - a.createdMs));
	if (candidates.length === 1) return candidates[0].file;
	// Parallel fan-out: several workers start within the same window, so pin the
	// one whose prompt embeds THIS task's own title.
	const fragment = taskMatchFragment(manifest, task);
	if (fragment) {
		const matches = candidates.filter((candidate) => fileContainsFragment(candidate.file, fragment));
		if (matches.length === 1) return matches[0].file;
	}
	return candidates[0].file;
}

/**
 * Build the view session by COPYING the worker's own pi session file.
 *
 * The copy is byte-for-byte the worker's real conversation (task prompt, tool
 * calls, usage, ids, timestamps) with only the header extended by
 * `parentSession` so `/crew-back` can return. This is what makes the view "a
 * complete pi session, not a custom render".
 */
function buildViewFromWorkerSession(
	options: ViewBuildOptions,
	loaded: { manifest: TeamRunManifest; tasks: TeamTaskState[] },
): string | undefined {
	const task = loaded.tasks.find((candidate) => candidate.id === options.taskId);
	const source = resolveWorkerSessionFile(options, loaded.manifest, task);
	if (!source) return undefined;
	try {
		const st = statSync(source);
		if (st.size <= 0 || st.size > MAX_WORKER_SESSION_COPY_BYTES) return undefined;
		const text = readFileSync(source, "utf8");
		const nl = text.indexOf("\n");
		const firstLine = nl >= 0 ? text.slice(0, nl) : text;
		const rest = nl >= 0 ? text.slice(nl) : "";
		let header: Record<string, unknown>;
		try {
			header = JSON.parse(firstLine) as Record<string, unknown>;
		} catch {
			return undefined;
		}
		if (header.type !== "session") return undefined;
		header = { ...header, parentSession: options.parentSessionFile ?? header.parentSession };
		const outDir = agentStateDir(loaded.manifest, options.taskId);
		mkdirSync(outDir, { recursive: true });
		const outPath = path.join(outDir, CREW_VIEW_SESSION_BASENAME);
		writeFileSync(outPath, `${JSON.stringify(header)}${rest}`, "utf8");
		return outPath;
	} catch {
		return undefined;
	}
}

/**
 * Source stamp for the live-refresh tick when the view is backed by the
 * worker's own session file. The tick re-dispatches ONLY when the worker has
 * appended new content (stamp changed) — a plain content comparison against
 * the rebuilt view would loop on pi-appended entries (thinking_level changes)
 * because the authoritative copy drops them.
 */
export function workerSessionSourceStamp(
	options: Pick<ViewBuildOptions, "cwd" | "runId" | "taskId" | "parentSessionFile" | "sessionRoot">,
): { mtimeMs: number; size: number } | undefined {
	const loaded = loadRunManifestById(options.cwd, options.runId);
	if (!loaded) return undefined;
	const task = loaded.tasks.find((candidate) => candidate.id === options.taskId);
	const source = resolveWorkerSessionFile(options, loaded.manifest, task);
	if (!source) return undefined;
	try {
		const st = statSync(source);
		if (st.size <= 0) return undefined;
		return { mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return undefined;
	}
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
			} else if (part.type === "thinking") {
				// Keep reasoning so the view reads like the worker's real
				// session (pi renders thinking blocks inline).
				const thinking = typeof part.thinking === "string" ? part.thinking : "";
				if (thinking) content.push({ type: "thinking", thinking });
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
export function normalizeUsage(raw: unknown): {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
} {
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

	// PRIMARY: the worker's own pi session file — the complete, real session.
	{
		const workerPath = buildViewFromWorkerSession(options, loaded);
		if (workerPath) return workerPath;
	}

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
	const outPath = path.join(outDir, CREW_VIEW_SESSION_BASENAME);
	try {
		mkdirSync(outDir, { recursive: true });
		// The view session is a REAL pi session: pi keeps appending to the file
		// while it is open (entries the user types in the view, thinking_level
		// changes, …). A rebuild must not wipe that conversation, so
		// pi-appended entries from the previous view file are preserved — every
		// synthesized entry id starts with "crew-", everything else is foreign
		// and carried over (deduped by id).
		const previousLines = existsSync(outPath) ? readFileSync(outPath, "utf8").split("\n").filter(Boolean) : [];
		const knownIds = new Set<string>();
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry && typeof entry.id === "string") knownIds.add(entry.id);
			} catch {
				/* synthesized lines are always valid */
			}
		}
		const extras: string[] = [];
		for (const line of previousLines) {
			try {
				const entry = JSON.parse(line);
				const id = entry && typeof entry.id === "string" ? entry.id : "";
				if (id && !id.startsWith("crew-") && !knownIds.has(id)) {
					extras.push(line);
					knownIds.add(id);
				}
			} catch {
				/* an unparsable previous line is dropped, never fatal */
			}
		}
		writeFileSync(outPath, `${[...lines, ...extras].join("\n")}\n`, "utf8");
	} catch {
		return undefined;
	}
	return outPath;
}
