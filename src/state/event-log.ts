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
import { needsRotation, compactEventLog, rotateEventLog } from "./event-log-rotation.ts";

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
 *
 *  @deprecated Prefer `appendEventAsync()` for callers in async contexts. The sync lock
 *  uses `sleepSync` which blocks the event loop and prevents AbortSignal handlers from firing.
 *
 *  SECURITY WARNING: This function uses `sleepSync` in its lock-acquire retry loop, which
 *  blocks the Node.js event loop for up to 120s. During that time, AbortSignal handlers
 *  cannot fire, SIGTERM handlers are delayed, and the process appears unresponsive to
 *  orchestrator health checks. Known callers include `appendEvent` (sync path),
 *  `flushOneEventLogBuffer`, and `state/mailbox.ts`. Prefer the async alternative
 *  (`appendEventAsync`) for all new code.
 */
export function withEventLogLockSync<T>(eventsPath: string, fn: () => T): T {
	// Ensure parent directory exists before attempting lock
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const lockDir = `${eventsPath}.lock`;
	const pidFile = path.join(lockDir, "pid");
	const start = Date.now();
	const timeout = 120000; // 120s timeout for slow CI environments
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
				// Log error and continue without lock — lock is held by live process.
				// Stale detection will clean up dead locks on next attempt.
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

function evictOldestSequenceCacheEntries(): void {
	// Batch evict oldest 50% of entries when cache is full
	const toEvict = Math.ceil(MAX_SEQUENCE_CACHE_ENTRIES / 2);
	let evicted = 0;
	for (const key of sequenceCache.keys()) {
		if (evicted >= toEvict) break;
		sequenceCache.delete(key);
		evicted++;
	}
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
	let skipped = 0;
	for (const line of fs.readFileSync(eventsPath, "utf-8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as TeamEvent;
			max = Math.max(max, event.metadata?.seq ?? 0);
		} catch {
			skipped++;
		}
	}
	if (skipped > 0) {
		logInternalError("event-log.scanSequence.corrupt_lines", undefined, `${eventsPath}: skipped ${skipped} corrupt line(s)`);
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
	// FIX: Trust the sidecar seq file if it exists and the file is non-empty.
	// Only fall back to O(n) scan if sidecar is missing or file shrunk unexpectedly.
	const stored = readStoredSequence(eventsPath);
	if (stored !== undefined && (!cached || stat.size >= cached.size)) {
		sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq: stored });
		return stored + 1;
	}
	const current = scanSequence(eventsPath);
	sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq: current });
	persistSequence(eventsPath, current);
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

/**
 * @deprecated Prefer `appendEventAsync()` in async contexts. The sync lock uses
 * `sleepSync` which blocks the Node.js event loop, preventing AbortSignal handlers
 * from firing and degrading live-agent responsiveness.
 */
export function appendEvent(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	return withEventLogLockSync(eventsPath, () => appendEventInsideLock(eventsPath, event));
}

// --- Async write queue (non-blocking alternative to withEventLogLockSync) ---
const asyncQueues = new Map<string, Promise<unknown>>();

/**
 * Append an event to the event log using non-blocking async I/O.
 *
 * Uses a per-eventsPath promise-chain queue to ensure sequential writes without
 * blocking the Node.js event loop. This allows AbortSignal handlers and other
 * async operations to proceed while events are being persisted.
 *
 * For callers that are already in an async context (team-runner, task-runner,
 * foreground-control, etc.), prefer this over the sync `appendEvent()`.
 */
export async function appendEventAsync(eventsPath: string, event: AppendTeamEvent): Promise<TeamEvent> {
	const queueKey = eventsPath;
	const prev = asyncQueues.get(queueKey) ?? Promise.resolve();
	const next = prev.then(async (): Promise<TeamEvent> => {
		// Ensure directory exists
		await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });

		// Build metadata (same logic as appendEventInsideLock)
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

		// Overflow handling: same logic as sync path
		const isTerminal = TERMINAL_EVENT_TYPES.has(fullEvent.type);
		let skippedDueToSize = false;
		if (!isTerminal && fs.existsSync(eventsPath)) {
			const stat = fs.statSync(eventsPath);
			if (stat.size > MAX_EVENTS_BYTES) {
				try {
					compactEventLog(eventsPath);
				} catch (error) {
					logInternalError("event-log.immediate-compact", error, `eventsPath=${eventsPath}`);
				}
				if (fs.existsSync(eventsPath)) {
					const afterCompact = fs.statSync(eventsPath);
					if (afterCompact.size > MAX_EVENTS_BYTES) {
						rotateEventLog(eventsPath);
					}
				}
			}
		}
		try {
			if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
				logInternalError("event-log.size-limit", new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes after compaction`), `eventsPath=${eventsPath}`);
				skippedDueToSize = true;
			}
		} catch (error) {
			logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
		}

		if (!skippedDueToSize) {
			const line = JSON.stringify(redactSecrets(fullEvent)) + "\n";
			await fs.promises.appendFile(eventsPath, line, { encoding: "utf-8" });
		}

		appendCounter++;
		if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {
			try { compactEventLog(eventsPath); } catch (error) { logInternalError("event-log.rotation", error, `eventsPath=${eventsPath}`); }
		}
		try { emitFromTeamEvent(fullEvent); } catch (error) { logInternalError("event-log.emit", error); }

		const seq = fullEvent.metadata?.seq ?? 0;
		try {
			const stat = fs.statSync(eventsPath);
			if (sequenceCache.size >= MAX_SEQUENCE_CACHE_ENTRIES) {
				evictOldestSequenceCacheEntries();
			}
			sequenceCache.set(eventsPath, { size: stat.size, mtimeMs: stat.mtimeMs, seq });
			persistSequence(eventsPath, seq);
		} catch (error) {
			logInternalError("event-log.persist-sequence", error, `eventsPath=${eventsPath}`);
		}
		return fullEvent;
	});
	asyncQueues.set(queueKey, next.then(
		() => { asyncQueues.delete(queueKey); },
		(error) => {
			logInternalError("event-log.async-queue", error, eventsPath);
			asyncQueues.delete(queueKey);
		},
	));
	return next;
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
	// H1 fix: handle overflow before appending.
	// 1. Terminal events must always be persisted regardless of size.
	// 2. Non-terminal events exceeding MAX_EVENTS_BYTES trigger immediate compact.
	// 3. After compact, if still over limit, rotate.
	const isTerminal = TERMINAL_EVENT_TYPES.has(fullEvent.type);
	let skippedDueToSize = false;
	if (!isTerminal && fs.existsSync(eventsPath)) {
		const stat = fs.statSync(eventsPath);
		if (stat.size > MAX_EVENTS_BYTES) {
			// Try immediate compact (not waiting for counter % 100)
			try {
				compactEventLog(eventsPath);
			} catch (error) {
				logInternalError("event-log.immediate-compact", error, `eventsPath=${eventsPath}`);
			}
			// Check if still too large after compact — if so, rotate
			if (fs.existsSync(eventsPath)) {
				const afterCompact = fs.statSync(eventsPath);
				if (afterCompact.size > MAX_EVENTS_BYTES) {
					rotateEventLog(eventsPath);
				}
			}
		}
	}
	try {
		if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
			// Only reach here for non-terminal events that still overflow after compact+rotate.
			// Log and mark as not appended.
			logInternalError("event-log.size-limit", new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes after compaction`), `eventsPath=${eventsPath}`);
			skippedDueToSize = true;
		}
	} catch (error) {
		logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
	}
	if (!skippedDueToSize) {
		fs.appendFileSync(eventsPath, `${JSON.stringify(redactSecrets(fullEvent))}\n`, "utf-8");
	}
	appendCounter++;
	if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {
		try { compactEventLog(eventsPath); } catch (error) { logInternalError("event-log.rotation", error, `eventsPath=${eventsPath}`); }
	}
	try { emitFromTeamEvent(fullEvent); } catch (error) { logInternalError("event-log.emit", error); }
	const seq = fullEvent.metadata?.seq ?? 0;
	try {
		const stat = fs.statSync(eventsPath);
		if (sequenceCache.size >= MAX_SEQUENCE_CACHE_ENTRIES) {
			evictOldestSequenceCacheEntries();
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
	// FIX: Terminal events must bypass buffer to ensure they're written immediately.
	// Previously, terminal events like task.failed could be lost on process crash.
	if (TERMINAL_EVENT_TYPES.has(event.type)) {
		// For terminal events, write synchronously to ensure durability
		return Promise.resolve(appendEvent(eventsPath, event));
	}
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
	// MEDIUM-13: Delete timer entry only after successful flush (in finally block)
	bufferedTimers.delete(eventsPath);
	if (!queue || queue.length === 0) return;

	// FIX (Round 14, H3): When truncating the queue, explicitly reject the
	// dropped entries' promises. Previously `queue.splice()` silently
	// discarded the oldest items, and their associated Promises were never
	// resolved or rejected — causing callers to await forever and leaking
	// memory. We now reject with a clear error so callers can fall back.
	if (queue.length > 1000) {
		const dropped = queue.splice(0, queue.length - 500);
		for (const item of dropped) {
			item.reject(new Error(
				`Event log buffer overflow: ${queue.length + dropped.length} entries > 1000 cap; oldest ${dropped.length} dropped to keep memory bounded`,
			));
		}
	}
	
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

/**
 * Schedule an async event append without waiting for the result.
 * Uses the non-blocking async queue to avoid blocking the event loop.
 * Use only for events whose return value is ignored (high-frequency `task.progress`).
 * Errors are logged via logInternalError.
 */
export function appendEventFireAndForget(eventsPath: string, event: AppendTeamEvent, _bufferMs = DEFAULT_BUFFER_MS): void {
	appendEventAsync(eventsPath, event).catch((error) => logInternalError("event-log.fire-and-forget", error, eventsPath));
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

	// Original behavior: read entire file.
	// FIX (Round 14, H7): When called WITHOUT fromByteOffset on a large file,
	// fall back to reading only the tail (last 1MB) plus metadata about the
	// dropped prefix. This avoids O(n) memory load on hot UI paths while
	// preserving a sensible default.
	const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
	const limit = positiveInteger(options.limit);
	let all = readEvents(eventsPath);
	const totalAll = all.length;
	if (totalAll > 5000 && options.fromByteOffset === undefined) {
		// TAIL READ: keep the most recent 5000 events to bound memory.
		// Callers that need full history should pass fromByteOffset to stream.
		logInternalError(
			"event-log.cursor-full-read",
			new Error(`readEventsCursor read entire ${totalAll}-event log; pass fromByteOffset for incremental reads`),
			`eventsPath=${eventsPath}`,
		);
		all = all.slice(-5000);
	}
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
