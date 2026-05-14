import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_EVENT_LOG } from "../config/defaults.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import { emitFromTeamEvent } from "../ui/run-event-bus.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { readJsonlSince, type IncrementalReadState } from "../utils/incremental-reader.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { sleepSync } from "../utils/sleep.ts";
import { needsRotation, compactEventLog } from "./event-log-rotation.ts";

export type TeamEventProvenance = "live_worker" | "test" | "healthcheck" | "replay" | "api" | "background" | "team_runner";
export type TeamWatcherAction = "act" | "observe" | "ignore";

export interface TeamEventSessionIdentity {
	title: string;
	workspace: string;
	purpose: string;
	placeholderReason?: string;
}

export interface TeamEventOwnership {
	owner: string;
	workflowScope: string;
	watcherAction: TeamWatcherAction;
}

export interface TeamEventMetadata {
	seq: number;
	provenance: TeamEventProvenance;
	parentEventId?: string;
	attemptId?: string;
	branchId?: string;
	causationId?: string;
	correlationId?: string;
	sessionIdentity?: TeamEventSessionIdentity;
	ownership?: TeamEventOwnership;
	nudgeId?: string;
	appended?: boolean;
	fingerprint?: string;
	confidence?: "low" | "medium" | "high";
}

export interface TeamEvent {
	time: string;
	type: string;
	runId: string;
	taskId?: string;
	message?: string;
	data?: Record<string, unknown>;
	metadata?: TeamEventMetadata;
}

export type AppendTeamEvent = Omit<TeamEvent, "time" | "metadata"> & { metadata?: Partial<TeamEventMetadata> };

const TERMINAL_EVENT_TYPES = new Set<string>(DEFAULT_EVENT_LOG.terminalEventTypes);
const MAX_EVENTS_BYTES = 50 * 1024 * 1024;

const sequenceCache = new Map<string, { size: number; mtimeMs: number; seq: number }>();
const MAX_SEQUENCE_CACHE_ENTRIES = 256;
let appendCounter = 0;

/** Simple cross-process lock for an eventsPath to prevent JSONL interleave on concurrent append.
 *  Detects stale locks by checking the owner PID written inside the lock directory.
 */
function withEventLogLockSync<T>(eventsPath: string, fn: () => T): T {
	const lockDir = `${eventsPath}.lock`;
	const pidFile = path.join(lockDir, "pid");
	const start = Date.now();
	const timeout = 5000;
	const staleMs = 10000;
	let acquired = false;
	while (true) {
		try {
			fs.mkdirSync(lockDir);
			try { fs.writeFileSync(pidFile, String(process.pid), "utf-8"); } catch { /* best-effort */ }
			acquired = true;
			break;
		} catch {
			if (Date.now() - start > timeout) {
				logInternalError("event-log.lock-timeout", new Error(`Event log lock timeout for ${eventsPath}`), `lockDir=${lockDir}`);
				break;
			}
			// Stale detection: if the owning process is dead, remove the stale lock.
			try {
				const raw = fs.readFileSync(pidFile, "utf-8").trim();
				const ownerPid = Number.parseInt(raw, 10);
				if (!Number.isNaN(ownerPid) && ownerPid !== process.pid) {
					let alive = false;
					try { process.kill(ownerPid, 0); alive = true; } catch { /* dead */ }
					if (!alive) {
						try {
							const stat = fs.statSync(lockDir);
							if (Date.now() - stat.mtimeMs > staleMs) {
								fs.rmSync(lockDir, { recursive: true, force: true });
								continue;
							}
						} catch { /* race — let loop sleep */ }
					}
				}
			} catch { /* no pid file — fall through to sleep */ }
			sleepSync(10);
		}
	}
	try {
		return fn();
	} finally {
		if (acquired) {
			try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch { /* best-effort */ }
		}
	}
}

function evictOldestSequenceCacheEntry(): void {
	const first = sequenceCache.keys().next().value;
	if (first !== undefined) sequenceCache.delete(first);
}

export function sequencePath(eventsPath: string): string {
	return `${eventsPath}.seq`;
}

function parseSequence(raw: string): number | undefined {
	const value = Number.parseInt(raw.trim(), 10);
	return Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function scanSequence(eventsPath: string): number {
	if (!fs.existsSync(eventsPath)) return 0;
	let max = 0;
	for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as TeamEvent;
			max = Math.max(max, event.metadata?.seq ?? 0);
		} catch { /* skip corrupt lines without incrementing sequence */ }
	}
	return max;
}

function readStoredSequence(eventsPath: string): number | undefined {
	try {
		return parseSequence(fs.readFileSync(sequencePath(eventsPath), "utf-8"));
	} catch {
		return undefined;
	}
}

function nextSequence(eventsPath: string): number {
	if (!fs.existsSync(eventsPath)) return 1;
	const stat = fs.statSync(eventsPath);
	const cached = sequenceCache.get(eventsPath);
	if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
		return cached.seq + 1;
	}
	let current = readStoredSequence(eventsPath);
	if (current === undefined || (cached && stat.size < cached.size)) {
		current = scanSequence(eventsPath);
	}
	sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq: current });
	return current + 1;
}

function persistSequence(eventsPath: string, seq: number): void {
	try {
		atomicWriteFile(sequencePath(eventsPath), String(seq));
	} catch (error) {
		logInternalError("event-log.persist-sequence-file", error, `eventsPath=${eventsPath}`);
	}
}

export function computeEventFingerprint(event: Pick<TeamEvent, "type" | "runId" | "taskId" | "data">): string {
	return createHash("sha256").update(JSON.stringify({ type: event.type, runId: event.runId, taskId: event.taskId, data: event.data ?? null })).digest("hex").slice(0, 16);
}

export function appendEvent(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	return withEventLogLockSync(eventsPath, () => appendEventInsideLock(eventsPath, event));
}

/**
 * Body of `appendEvent` assuming the caller already holds
 * `withEventLogLockSync` for `eventsPath`. Used by `appendEventBuffered` to
 * write a whole batch of pending events under a single lock acquire.
 */
function appendEventInsideLock(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const baseMetadata = event.metadata;
	let metadata: TeamEventMetadata = {
		seq: baseMetadata?.seq ?? nextSequence(eventsPath),
		provenance: baseMetadata?.provenance ?? "team_runner",
		...(baseMetadata?.parentEventId ? { parentEventId: baseMetadata.parentEventId } : {}),
		...(baseMetadata?.attemptId ? { attemptId: baseMetadata.attemptId } : {}),
		...(baseMetadata?.branchId ? { branchId: baseMetadata.branchId } : {}),
		...(baseMetadata?.causationId ? { causationId: baseMetadata.causationId } : {}),
		...(baseMetadata?.correlationId ? { correlationId: baseMetadata.correlationId } : {}),
		...(baseMetadata?.sessionIdentity ? { sessionIdentity: baseMetadata.sessionIdentity } : {}),
		...(baseMetadata?.ownership ? { ownership: baseMetadata.ownership } : {}),
		...(baseMetadata?.nudgeId ? { nudgeId: baseMetadata.nudgeId } : {}),
		...(baseMetadata?.confidence ? { confidence: baseMetadata.confidence } : {}),
	};
	const fullEvent: TeamEvent = {
		time: new Date().toISOString(),
		...event,
		metadata,
	};
	if (baseMetadata?.fingerprint || TERMINAL_EVENT_TYPES.has(fullEvent.type)) {
		metadata = { ...metadata, fingerprint: baseMetadata?.fingerprint ?? computeEventFingerprint(fullEvent) };
		fullEvent.metadata = metadata;
	}
	try {
		if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
			logInternalError("event-log.size-limit", new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes`), `eventsPath=${eventsPath}`);
			return { ...fullEvent, metadata: { ...(fullEvent.metadata ?? { seq: 0, provenance: "team_runner" }), appended: false } };
		}
	} catch (error) {
		logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
	}
	fs.appendFileSync(eventsPath, `${JSON.stringify(redactSecrets(fullEvent))}\n`, "utf-8");
	appendCounter++;
	if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {
		try { compactEventLog(eventsPath); } catch (error) { logInternalError("event-log.rotation", error, `eventsPath=${eventsPath}`); }
	}
	try { emitFromTeamEvent(fullEvent); } catch (error) { logInternalError("event-log.emit", error); }
	const seq = fullEvent.metadata?.seq ?? 0;
	try {
		const stat = fs.statSync(eventsPath);
		if (sequenceCache.size >= MAX_SEQUENCE_CACHE_ENTRIES) {
			evictOldestSequenceCacheEntry();
		}
		sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq });
		persistSequence(eventsPath, seq);
	} catch (error) {
		logInternalError("event-log.persist-sequence", error, `eventsPath=${eventsPath}`);
	}
	return fullEvent;
}

// 2.2 — Buffered append API. Caller queues events and they are flushed under
// a single `withEventLogLockSync` acquire after `bufferingMs` ms. The seq
// invariant is preserved because the flush still goes through
// appendEventInsideLock sequentially.
//
// Caveat: events still in the buffer at process kill -9 are lost. Callers
// for whom durability is critical (lifecycle terminal events) should keep
// using `appendEvent`. Used opportunistically for high-frequency events
// like `task.progress` once integration tests cover crash semantics.
interface BufferedAppend {
	event: AppendTeamEvent;
	resolve: (event: TeamEvent) => void;
	reject: (error: unknown) => void;
}
const bufferedQueues = new Map<string, BufferedAppend[]>();
const bufferedTimers = new Map<string, ReturnType<typeof setTimeout>>();
const DEFAULT_BUFFER_MS = 20;

export function appendEventBuffered(eventsPath: string, event: AppendTeamEvent, bufferMs = DEFAULT_BUFFER_MS): Promise<TeamEvent> {
	return new Promise<TeamEvent>((resolve, reject) => {
		const queue = bufferedQueues.get(eventsPath) ?? [];
		queue.push({ event, resolve, reject });
		bufferedQueues.set(eventsPath, queue);
		if (!bufferedTimers.has(eventsPath)) {
			const timer = setTimeout(() => flushOneEventLogBuffer(eventsPath), bufferMs);
			timer.unref();
			bufferedTimers.set(eventsPath, timer);
		}
	});
}

function flushOneEventLogBuffer(eventsPath: string): void {
	const queue = bufferedQueues.get(eventsPath);
	bufferedQueues.delete(eventsPath);
	const timer = bufferedTimers.get(eventsPath);
	if (timer) clearTimeout(timer);
	bufferedTimers.delete(eventsPath);
	if (!queue || queue.length === 0) return;
	try {
		withEventLogLockSync(eventsPath, () => {
			for (const item of queue) {
				try {
					const ev = appendEventInsideLock(eventsPath, item.event);
					item.resolve(ev);
				} catch (error) {
					item.reject(error);
				}
			}
		});
	} catch (error) {
		// Lock acquire failed — fail every queued item so callers can fall back.
		for (const item of queue) item.reject(error);
	}
}

/** Synchronously flush every queued buffered event across all paths. */
export function flushEventLogBuffer(): void {
	for (const eventsPath of [...bufferedQueues.keys()]) flushOneEventLogBuffer(eventsPath);
}

// Auto-flush on process exit so buffered events do not silently leak.
process.on("exit", () => flushEventLogBuffer());
process.on("SIGTERM", () => flushEventLogBuffer());
process.on("SIGINT", () => flushEventLogBuffer());

export function readEvents(eventsPath: string): TeamEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	return fs.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try { return [JSON.parse(line) as TeamEvent]; }
			catch { return []; }
		});
}

export interface EventCursorOptions {
	sinceSeq?: number;
	limit?: number;
	fromByteOffset?: number;
}

export interface EventCursorResult {
	events: TeamEvent[];
	nextSeq: number;
	total: number;
	nextByteOffset?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function readEventsCursor(eventsPath: string, options: EventCursorOptions = {}): EventCursorResult {
	// Incremental byte-offset path: read only new bytes since last known offset
	if (options.fromByteOffset !== undefined) {
		const byteOffset = positiveInteger(options.fromByteOffset) ?? 0;
		const initialState: IncrementalReadState = { byteOffset, lineCount: 0 };
		const { items, state: newState, eof } = readJsonlSince<TeamEvent>(eventsPath, initialState);
		const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
		const filtered = items.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
		const limit = positiveInteger(options.limit);
		const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
		const returnedMaxSeq = events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq);
		return {
			events,
			nextSeq: returnedMaxSeq,
			total: filtered.length,
			nextByteOffset: newState.byteOffset,
		};
	}

	// Original behavior: read entire file
	const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
	const limit = positiveInteger(options.limit);
	const all = readEvents(eventsPath);
	const filtered = all.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
	const events = limit !== undefined ? filtered.slice(0, limit) : filtered;
	const returnedMaxSeq = events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq);
	return { events, nextSeq: returnedMaxSeq, total: filtered.length };
}

export function dedupeTerminalEvents(events: TeamEvent[]): TeamEvent[] {
	const seen = new Set<string>();
	const output: TeamEvent[] = [];
	for (const event of events) {
		const fingerprint = event.metadata?.fingerprint;
		if (fingerprint && TERMINAL_EVENT_TYPES.has(event.type)) {
			if (seen.has(fingerprint)) continue;
			seen.add(fingerprint);
		}
		output.push(event);
	}
	return output;
}
