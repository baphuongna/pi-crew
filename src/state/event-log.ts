import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_EVENT_LOG } from "../config/defaults.ts";
import { errors } from "../errors.ts";
import { emitFromTeamEvent } from "../ui/run-event-bus.ts";
import { type IncrementalReadState, readJsonlSince } from "../utils/incremental-reader.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactSecrets } from "../utils/redaction.ts";
import { sleepSync } from "../utils/sleep.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import {
	applyCompactionUnlocked,
	compactEventLog,
	needsRotation,
	prepareCompaction,
	rotateEventLog,
	rotateEventLogUnlocked,
} from "./event-log-rotation.ts";
import { appendFileViaWorker, isWorkerAtomicWriterEnabled } from "./worker-atomic-writer.ts";

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

export type AppendTeamEvent = Omit<TeamEvent, "time" | "metadata"> & {
	metadata?: Partial<TeamEventMetadata>;
};

const TERMINAL_EVENT_TYPES = new Set<string>(DEFAULT_EVENT_LOG.terminalEventTypes);
const MAX_EVENTS_BYTES = 50 * 1024 * 1024;

const sequenceCache = new Map<string, { size: number; mtimeMs: number; seq: number; lastAccessMs: number }>();
const MAX_SEQUENCE_CACHE_ENTRIES = 256;
let appendCounter = 0;
let overflowCounter = 0;

/** Simple cross-process lock for an eventsPath to prevent JSONL interleave on concurrent append.
 *  Detects stale locks by checking the owner PID written inside the lock directory.
 *
 *  @deprecated Prefer `appendEventAsync()` for callers in async contexts. The sync lock
 *  uses `sleepSync` which blocks the event loop and prevents AbortSignal handlers from firing.
 *
 *  SECURITY WARNING: This function uses `sleepSync` in its lock-acquire retry loop, which
 *  blocks the Node.js event loop for up to 5s. During that time, AbortSignal handlers
 *  cannot fire, SIGTERM handlers are delayed, and the process appears unresponsive to
 *  orchestrator health checks. Known callers include `appendEvent` (sync path),
 *  `flushOneEventLogBuffer`, and `state/mailbox.ts`. Prefer the async alternative
 *  (`appendEventAsync`) for all new code.
 */
export function withEventLogLockSync<T>(eventsPath: string, fn: () => T, options?: { timeoutMs?: number; staleMs?: number }): T {
	// Ensure parent directory exists before attempting lock
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const lockDir = `${eventsPath}.lock`;
	const pidFile = path.join(lockDir, "pid");
	const start = Date.now();
	// SECURITY (HIGH #2 fix): Reduced from 120s to 5s to prevent blocking the
	// event loop indefinitely. ~100 retries × 50ms ≈ 5s max. After timeout, we
	// throw a clear error instead of blocking forever. This ensures AbortSignal
	// handlers, SIGTERM, and graceful shutdown can fire within seconds.
	const timeout = options?.timeoutMs ?? 5000;
	const staleMs = options?.staleMs ?? 10000;
	let acquired = false;
	while (true) {
		try {
			// NOTE: mkdir-based lock is acceptable here. On POSIX systems, directory
			// creation via mkdir with O_CREAT|O_EXCL semantics is atomic — equivalent
			// to O_EXCL file open. The stale detection below uses process.kill(pid, 0)
			// which has a TOCTOU race, but O_EXCL is used to atomically verify-and-remove
			// the stale lock in one operation, eliminating the race. The 5s timeout
			// (reduced from 120s) is appropriate.
			fs.mkdirSync(lockDir);
			try {
				atomicWriteFile(pidFile, String(process.pid));
			} catch {
				/* best-effort */
			}
			acquired = true;
			break;
		} catch {
			if (Date.now() - start > timeout) {
				// SECURITY (HIGH #2 fix): Throw instead of continuing without lock.
				// Previously this logged and broke out of the loop, executing the
				// operation without lock protection. Now we throw so callers can retry.
				// E1 (Round 15): structured CrewError (E010) with help hint so users know
				// to check for orphaned .lock dirs / stale processes.
				throw errors.eventLogLockTimeout(eventsPath, timeout);
			}
			// Round 26 (BUG 3): mtime-based stale check INDEPENDENT of pidFile.
			// If the holder crashed between mkdir and writing pidFile, there is no
			// pidFile to read — the old code just slept until the 5s timeout, then
			// threw, leaving the dir orphaned FOREVER (every retry repeats the
			// timeout). Now: if the lock dir's mtime exceeds staleMs, reclaim it.
			try {
				const dirStat = fs.statSync(lockDir);
				if (Date.now() - dirStat.mtimeMs > staleMs) {
					fs.rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				/* dir vanished — let loop retry */
			}
			// Round 26 (BUG 4): the mtime check was previously NESTED inside
			// `if (!alive)`, so a recycled PID (crashed holder's PID reused by an
			// unrelated live process) kept `alive=true` and the mtime check NEVER
			// fired → permanent wedge. mtime is now checked FIRST (above) for ALL
			// holders. The PID check below is a secondary fast-path: if the holder
			// PID is provably dead AND the lock isn't stale yet, we still wait
			// (don't steal a fresh lock just because the pid lookup raced).
			try {
				const raw = fs.readFileSync(pidFile, "utf-8").trim();
				const ownerPid = Number.parseInt(raw, 10);
				if (!Number.isNaN(ownerPid) && ownerPid !== process.pid) {
					let alive = false;
					try {
						process.kill(ownerPid, 0);
						alive = true;
					} catch {
						/* dead */
					}
					// (mtime already handled above; nothing to do here for dead-but-fresh.)
					void alive;
				}
			} catch {
				/* no pid file — mtime check above already handles it */
			}
			sleepSync(50);
		}
	}
	try {
		return fn();
	} finally {
		if (acquired) {
			// Round 26 (BUG 5): token/PID-guarded release. Previously the release
			// was an UNCONDITIONAL rmSync. If our fn exceeded staleMs, another
			// process could steal our lock (rm our dir, make its own); when our fn
			// finished our finally block would then DELETE THE STEALER's dir → both
			// in the critical section + lost lock. Verify the pidFile still records
			// OUR pid before removing; if it doesn't, the lock was stolen and the
			// current holder owns the dir.
			try {
				const currentPid = fs.readFileSync(pidFile, "utf-8").trim();
				if (currentPid === String(process.pid)) {
					fs.rmSync(lockDir, { recursive: true, force: true });
				}
			} catch {
				/* lock stolen or already gone — do not touch */
			}
		}
	}
}

function evictOldestSequenceCacheEntries(): void {
	// FIX: Evict by lastAccessMs (access time), not insertion order.
	// Frequently accessed entries should be retained even if older.
	const toEvict = Math.ceil(MAX_SEQUENCE_CACHE_ENTRIES / 2);
	// Sort entries by lastAccessMs ascending (oldest first)
	const entries = [...sequenceCache.entries()].sort((a, b) => a[1].lastAccessMs - b[1].lastAccessMs);
	// Evict the oldest half
	for (let i = 0; i < toEvict && i < entries.length; i++) {
		sequenceCache.delete(entries[i][0]);
	}
}

/** @internal — exported for sequence-cache LRU testing (Round 19). */
export function __test__sequenceCacheSize(): number {
	return sequenceCache.size;
}

/** @internal — seed an entry into the sequence cache for testing. */
export function __test__seedSequenceCache(eventsPath: string, lastAccessMs: number): void {
	sequenceCache.set(eventsPath, {
		size: 1,
		mtimeMs: 0,
		seq: 0,
		lastAccessMs,
	});
}

/** @internal — expose eviction for testing. */
export function __test__evictOldestSequenceCacheEntries(): void {
	evictOldestSequenceCacheEntries();
}

/** @internal — clear the sequence cache. */
export function __test__clearSequenceCache(): void {
	sequenceCache.clear();
}

/** @internal — clear the in-process seqCounters Map so nextSequence seeds
 *  fresh from the sidecar/file (simulates a process restart for testing). */
export function __test__clearSeqCounters(): void {
	seqCounters.clear();
}

/** @internal — the raw nextSequence for testing (forces re-seed from disk
 *  by requiring the caller to have already cleared both caches). */
export function __test__nextSequence(eventsPath: string): number {
	return nextSequence(eventsPath);
}

/** @internal — the max sequence cache entries bound. */
export const MAX_SEQUENCE_CACHE_ENTRIES_VALUE = MAX_SEQUENCE_CACHE_ENTRIES;

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
	// Explicitly check for file shrinkage (stat.size < cached.size) to trigger
	// re-scan when rotation or compaction has occurred.
	const stored = readStoredSequence(eventsPath);
	const fileShrunk = cached && stat.size < cached.size;
	if (stored !== undefined && !fileShrunk) {
		// EL-1: the sidecar can regress via sync/async interleave —
		// appendEventAsync reserves a seq, yields during appendFile/fsync, a
		// concurrent sync appendEvent reserves+persists a higher seq, then the
		// async path persists its lower seq — regressing the sidecar below the
		// file's true max. Trusting the regressed sidecar alone would return a
		// duplicate seq on the next append. Take max with scanSequence so a
		// regressed sidecar cannot cause duplicate sequence numbers.
		const fileMax = scanSequence(eventsPath);
		const safeSeq = Math.max(stored, fileMax);
		sequenceCache.set(eventsPath, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			seq: safeSeq,
			lastAccessMs: Date.now(),
		});
		return safeSeq + 1;
	}
	const current = scanSequence(eventsPath);
	sequenceCache.set(eventsPath, {
		size: stat.size,
		mtimeMs: stat.mtimeMs,
		seq: current,
		lastAccessMs: Date.now(),
	});
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

// B7: single in-process monotonic sequence counter per eventsPath. The three
// append paths — sync appendEvent (withEventLogLockSync file lock), buffered
// flush (asyncLocks promise chain), and direct appendEventAsync (asyncQueues
// promise chain) — use DIFFERENT locks, so the old read-sidecar / compute /
// persist-sidecar sequence logic in nextSequence() raced ACROSS paths and
// produced duplicate sequence numbers (observed live: distinct events sharing
// a seq; no data loss — only the counter collided). A single in-process counter
// makes assignment atomic (JS is single-threaded); persistSequence() keeps the
// sidecar durable for crash recovery across restarts.
const seqCounters = new Map<string, number>();

/** Atomically reserve the next sequence number for `eventsPath`. */
function reserveSequence(eventsPath: string): number {
	let last = seqCounters.get(eventsPath);
	if (last === undefined) {
		// Seed once from the authoritative source (sidecar / cache / file scan).
		// nextSequence() returns the NEXT seq to assign, so the last assigned is one less.
		last = nextSequence(eventsPath) - 1;
	}
	const next = last + 1;
	seqCounters.set(eventsPath, next);
	return next;
}

/** Keep the in-process counter monotonic w.r.t. an explicitly-provided seq
 *  (e.g. baseMetadata.seq) so a later auto-assigned seq never collides with it. */
function advanceSequenceCounter(eventsPath: string, seq: number): void {
	const last = seqCounters.get(eventsPath);
	if (last === undefined || seq > last) seqCounters.set(eventsPath, seq);
}

export function computeEventFingerprint(event: Pick<TeamEvent, "type" | "runId" | "taskId" | "data">): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				type: event.type,
				runId: event.runId,
				taskId: event.taskId,
				data: event.data ?? null,
			}),
		)
		.digest("hex")
		.slice(0, 16);
}

/**
 * Check for sequence gaps between the sidecar file and the events file.
 * This detects situations where the sidecar records a sequence number that has
 * no corresponding event in the file (e.g., due to a crash between
 * persistSequence and appendFile in older code, or other corruption).
 *
 * Returns an array of gap info: for each gap found, { missing: n } indicates
 * sequence n is recorded in sidecar but has no corresponding event.
 * An empty array means no gaps were found.
 */
export function checkSequenceGaps(eventsPath: string): { missing: number }[] {
	if (!fs.existsSync(eventsPath)) return [];
	const gaps: { missing: number }[] = [];
	const storedSeq = readStoredSequence(eventsPath);
	if (storedSeq === undefined) return [];
	const maxInFile = scanSequence(eventsPath);
	// If sidecar is ahead of file, report the missing sequences
	// (sidecar stores the NEXT sequence to use, so storedSeq is the last written)
	if (storedSeq > maxInFile) {
		for (let i = maxInFile + 1; i <= storedSeq; i++) {
			gaps.push({ missing: i });
		}
	}
	return gaps;
}

/**
 * @deprecated Prefer `appendEventAsync()` in async contexts. The sync lock uses
 * `sleepSync` which blocks the Node.js event loop, preventing AbortSignal handlers
 * from firing and degrading live-agent responsiveness.
 */
export function appendEvent(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	// NOTE: appendEvent is a sync function that uses withEventLogLockSync (sleepSync).
	// It cannot route through appendEventBuffered because the buffer timer requires
	// the event loop to fire, which sleepSync blocks. Both terminal and non-terminal
	// events use the direct sync path here. For non-terminal events, callers should
	// prefer appendEventAsync (which routes through the buffer for coalesced writes).
	return withEventLogLockSync(eventsPath, () => appendEventInsideLock(eventsPath, event));
}

// --- Async write queue (non-blocking alternative to withEventLogLockSync) ---
const asyncQueues = new Map<string, Promise<unknown>>();

// --- Async lock for flush operations (non-blocking alternative to withEventLogLockSync) ---
// Uses promise-chain pattern to ensure sequential lock acquisition without blocking the event loop.
const asyncLocks = new Map<string, Promise<unknown>>();

/** Drain all pending async writes by awaiting all in-flight queue promises.
 *  Called on process exit to minimize event loss for crash-sensitive events.
 *  Note: SIGKILL (kill -9) cannot be intercepted and will still lose events.
 */
async function drainAsyncQueues(): Promise<void> {
	const promises = [...asyncQueues.values()];
	if (promises.length === 0) return;
	// Use allSettled to ensure a rejected promise doesn't prevent others from completing.
	await Promise.allSettled(promises);
}

/** Async lock using promise-chain pattern to avoid blocking the Node.js event loop.
 *  Unlike withEventLogLockSync, this uses async I/O and does not use sleepSync,
 *  allowing AbortSignal handlers and SIGTERM handlers to proceed while waiting.
 */
async function withEventLogLockAsync(eventsPath: string, fn: () => Promise<void>): Promise<void> {
	const queueKey = eventsPath;
	const prev = asyncLocks.get(queueKey) ?? Promise.resolve();
	const next = prev.then(async (): Promise<void> => {
		await fn();
	});
	asyncLocks.set(queueKey, next);
	try {
		await next;
	} finally {
		// Compare-and-delete: only remove our entry if it still points at our
		// promise. With 3+ overlapping callers, an earlier caller's finally would
		// otherwise delete a later caller's promise, letting the next caller start
		// immediately (in parallel) -> broken mutual exclusion, duplicate seqs.
		if (asyncLocks.get(queueKey) === next) {
			asyncLocks.delete(queueKey);
		}
	}
}

/** Reset event log mode (for testing only). */
export function resetEventLogMode(): void {
	asyncQueues.clear();
	// B7: clear in-process sequence counters alongside async state so tests
	// don't leak seq state between runs.
	seqCounters.clear();
}

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
	// FIX (v0.9.26): Do NOT route non-terminal events through appendEventBuffered.
	// The buffer uses a 20ms timer + withEventLogLockAsync (promise chain), while
	// the sync appendEvent path uses withEventLogLockSync (file lock with sleepSync).
	// Mixing these two lock mechanisms on the same eventsPath causes a deadlock:
	// the buffer timer can't fire while sleepSync blocks the event loop, and
	// sleepSync can't acquire the lock while the buffer holds it via the promise
	// chain. This deadlocked adaptive-implementation, implementation-fanout,
	// parallel-research-dynamic, run-analysis, and team-run tests (>300s timeout).
	// Reverted to v0.9.19 behavior: ALL events use the asyncQueues direct path.
	// The buffer (appendEventBuffered) is still available for explicit callers
	// that want coalesced writes (e.g., appendEventFireAndForget), but
	// appendEventAsync itself does NOT buffer.
	const queueKey = eventsPath;
	const prev = asyncQueues.get(queueKey) ?? Promise.resolve();
	const next = prev.then(async (): Promise<TeamEvent> => {
		// Ensure directory exists
		await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });

		// Build metadata (same logic as appendEventInsideLock)
		// FIX: Sequence is computed INSIDE the promise chain. We NO LONGER persist
		// the sequence number before the append — that caused sequence reuse if
		// appendFile failed after persistSequence succeeded. Instead, we persist
		// ONLY AFTER successful appendFile, so the sidecar is only updated when
		// the event is definitively written. If appendFile fails, the sidecar is
		// not updated and nextSequence() will re-scan on next call, returning the
		// correct value without reuse.
		const baseMetadata = event.metadata;
		let seq: number;
		if (baseMetadata?.seq !== undefined) {
			seq = baseMetadata.seq;
			advanceSequenceCounter(eventsPath, seq);
		} else {
			seq = reserveSequence(eventsPath);
			// NOTE: We do NOT call persistSequence here. It will be called AFTER
			// successful appendFile below to ensure sidecar is only updated when
			// the event is actually written.
		}
		let metadata: TeamEventMetadata = {
			seq,
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
			metadata = {
				...metadata,
				fingerprint: baseMetadata?.fingerprint ?? computeEventFingerprint(fullEvent),
			};
			fullEvent.metadata = metadata;
		}

		// Overflow handling: same logic as sync path
		const isTerminal = TERMINAL_EVENT_TYPES.has(fullEvent.type);
		let skippedDueToSize = false;
		let fileStat: fs.Stats | undefined;
		try {
			fileStat = await fs.promises.stat(eventsPath).catch(() => undefined);
		} catch {
			/* file does not exist */
		}
		if (!isTerminal && fileStat) {
			const stat = fileStat;
			if (stat.size > MAX_EVENTS_BYTES) {
				try {
					compactEventLog(eventsPath);
				} catch (error) {
					logInternalError("event-log.immediate-compact", error, `eventsPath=${eventsPath}`);
				}
				let afterCompactStat: fs.Stats | undefined;
				try {
					afterCompactStat = await fs.promises.stat(eventsPath).catch(() => undefined);
				} catch {
					/* file does not exist */
				}
				if (afterCompactStat) {
					if (afterCompactStat.size > MAX_EVENTS_BYTES) {
						rotateEventLog(eventsPath);
					}
				}
			}
		}
		let sizeCheckStat: fs.Stats | undefined;
		try {
			sizeCheckStat = await fs.promises.stat(eventsPath).catch(() => undefined);
		} catch {
			/* file does not exist */
		}
		try {
			if (sizeCheckStat && sizeCheckStat.size > MAX_EVENTS_BYTES) {
				logInternalError(
					"event-log.size-limit",
					new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes after compaction`),
					`eventsPath=${eventsPath}`,
				);
				skippedDueToSize = true;
			}
		} catch (error) {
			logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
		}

		if (!skippedDueToSize) {
			const line = JSON.stringify(redactSecrets(fullEvent)) + "\n";
			// Phase 1.5: when worker atomic writer is enabled, append via worker.
			if (isWorkerAtomicWriterEnabled()) {
				await appendFileViaWorker(eventsPath, line);
			} else {
				await fs.promises.appendFile(eventsPath, line, {
					encoding: "utf-8",
					flag: "a",
				});
			}
			// FIX: fsync to ensure event content is flushed to disk before persisting
			// the sequence number. This closes the crash window between appendFile and
			// persistSequence where sequence reuse could occur on restart.
			const fd = await fs.promises.open(eventsPath, "r+");
			try {
				await fd.sync();
			} finally {
				await fd.close();
			}
			// FIX: Persist sequence AFTER successful appendFile to ensure sidecar
			// is only updated when the event is definitively written. If appendFile
			// threw, we would not reach here and the sidecar would not be updated,
			// preventing sequence reuse on restart.
			persistSequence(eventsPath, seq);
		}
		if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {
			try {
				compactEventLog(eventsPath);
			} catch (error) {
				logInternalError("event-log.rotation", error, `eventsPath=${eventsPath}`);
			}
		}
		try {
			emitFromTeamEvent(fullEvent);
		} catch (error) {
			logInternalError("event-log.emit", error);
		}

		// FIX: Sequence was persisted AFTER appendFile in the append block above.
		// Only update the cache here (the sidecar persist is already done).
		const finalSeq = fullEvent.metadata?.seq ?? 0;
		try {
			let statResult: fs.Stats | undefined;
			try {
				statResult = await fs.promises.stat(eventsPath).catch(() => undefined);
			} catch {
				/* file may not exist */
			}
			if (statResult) {
				if (sequenceCache.size >= MAX_SEQUENCE_CACHE_ENTRIES) {
					evictOldestSequenceCacheEntries();
				}
				sequenceCache.set(eventsPath, {
					size: statResult.size,
					mtimeMs: statResult.mtimeMs,
					seq: finalSeq,
					lastAccessMs: Date.now(),
				});
			}
			// Note: persistSequence is NOT called here again - it was already called
			// after the append to ensure the sidecar is current after the event is written.
		} catch (error) {
			logInternalError("event-log.persist-sequence", error, `eventsPath=${eventsPath}`);
		}
		return fullEvent;
	});
	const tail = next.then(
		() => {
			// Compare-and-delete: only remove our entry if it still points at our
			// tail promise. An older caller deleting unconditionally would wipe a
			// newer caller's promise, letting the next caller bypass serialization
			// -> duplicate seqs / interleaved appends.
			if (asyncQueues.get(queueKey) === tail) {
				asyncQueues.delete(queueKey);
			}
		},
		(error) => {
			// FIX: Wrap error handler in try-catch to ensure asyncQueues.delete
			// always runs, even if logging itself throws.
			try {
				logInternalError("event-log.async-queue", error, eventsPath);
			} catch {
				// logging failed — ensure queue is still cleaned up
			}
			// FIX: Reset queue to a resolved state instead of deleting it.
			// This prevents cascading failures where a single transient error
			// (e.g., ENOSPC) causes all subsequent events on the same path to fail.
			asyncQueues.set(queueKey, Promise.resolve());
		},
	);
	asyncQueues.set(queueKey, tail);
	return next;
}

/**
 * Body of `appendEvent` assuming the caller already holds
 * `withEventLogLockSync` for `eventsPath`. Used by `appendEventBuffered` to
 * write a whole batch of pending events under a single lock acquire.
 */
/**
 * Batch variant used by the buffered flush path. Computes metadata for each
 * event, writes the whole batch in a single appendFileSync + fsync, persists
 * the sequence sidecar once with the last seq, and updates the sequence cache
 * once. Resolves each item with its finalized event (carrying the assigned
 * seq). This collapses N fsyncs into 1 for the buffered write path, which is
 * the entire point of buffering — the previous per-event fsync made buffer
 * coalescing useless and added ~30ms/event on tmpfs.
 */
async function appendEventBatchInsideLock(eventsPath: string, queue: BufferedAppend[]): Promise<void> {
	if (queue.length === 0) return;
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });

	// Pre-flight size check (mirrors appendEventInsideLock). We do it once for
	// the batch instead of once per event.
	try {
		if (fs.existsSync(eventsPath)) {
			const stat = fs.statSync(eventsPath);
			if (stat.size > MAX_EVENTS_BYTES) {
				try {
					const prepared = prepareCompaction(eventsPath);
					if (prepared) applyCompactionUnlocked(eventsPath, prepared);
				} catch (error) {
					logInternalError("event-log.batch-immediate-compact", error, `eventsPath=${eventsPath}`);
				}
				if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
					rotateEventLogUnlocked(eventsPath);
				}
			}
		}
	} catch (error) {
		logInternalError("event-log.batch-size-check", error, `eventsPath=${eventsPath}`);
	}

	// Phase 1: compute metadata + JSON lines for every event in the batch.
	// Initialize nextSeq ONCE from nextSequence (or the first event's baseMetadata.seq),
	// then increment locally for each subsequent event in the batch. Calling
	// nextSequence() per-event would re-read file stat/sidecar with no writes
	// in between — every call would see the same file state and return the same
	// seq, breaking the "unique monotonic seq" contract. The cache update +
	// persistSequence at the end refreshes the sidecar to the last assigned seq.
	// B7: use reserveSequence for atomic seq assignment across all paths.
	const startingSeq = queue[0]?.event.metadata?.seq ?? reserveSequence(eventsPath);
	let nextSeq = startingSeq;
	const finalized: { item: BufferedAppend; line: string; fullEvent: TeamEvent }[] = [];
	let lastSeq = 0;
	for (const item of queue) {
		const baseMetadata = item.event.metadata;
		const seq = baseMetadata?.seq ?? nextSeq++;
		let metadata: TeamEventMetadata = {
			seq,
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
			...item.event,
			metadata,
		};
		if (baseMetadata?.fingerprint || TERMINAL_EVENT_TYPES.has(fullEvent.type)) {
			metadata = {
				...metadata,
				fingerprint: baseMetadata?.fingerprint ?? computeEventFingerprint(fullEvent),
			};
			fullEvent.metadata = metadata;
		}
		finalized.push({ item, line: `${JSON.stringify(redactSecrets(fullEvent))}\n`, fullEvent });
		lastSeq = seq;
	}
	// B7: advance counter past the entire batch so next reserveSequence returns the correct value.
	advanceSequenceCounter(eventsPath, lastSeq);

	// Phase 2: single appendFileSync + single fsync + single persistSequence.
	// Before this fix, each event in the batch triggered its own fsync, which
	// was the dominant cost on tmpfs and CI runners.
	try {
		if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
			logInternalError(
				"event-log.size-limit",
				new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes after compaction`),
				`eventsPath=${eventsPath}`,
			);
			// Reject the batch — caller will surface the error per item.
			for (const { item } of finalized) item.reject(new Error("event log size limit exceeded"));
			return;
		}
	} catch (error) {
		logInternalError("event-log.batch-size-check-post", error, `eventsPath=${eventsPath}`);
	}

	fs.appendFileSync(eventsPath, finalized.map((f) => f.line).join(""), "utf-8");
	const fd = fs.openSync(eventsPath, "r+");
	try {
		fs.fsyncSync(fd);
	} catch {
		// EPERM on Windows CI: best-effort flush
	} finally {
		fs.closeSync(fd);
	}
	persistSequence(eventsPath, lastSeq);

	// Phase 3: cache update + resolve all promises.
	try {
		const stat = fs.statSync(eventsPath);
		if (sequenceCache.size >= MAX_SEQUENCE_CACHE_ENTRIES) {
			evictOldestSequenceCacheEntries();
		}
		sequenceCache.set(eventsPath, {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			seq: lastSeq,
			lastAccessMs: Date.now(),
		});
	} catch (error) {
		logInternalError("event-log.batch-cache-update", error, `eventsPath=${eventsPath}`);
	}

	for (const { item, fullEvent } of finalized) item.resolve(fullEvent);
}

function appendEventInsideLock(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const baseMetadata = event.metadata;
	// B7: use reserveSequence for atomic seq assignment across all paths.
	const explicitSeq = baseMetadata?.seq;
	const seq = explicitSeq ?? reserveSequence(eventsPath);
	if (explicitSeq !== undefined) advanceSequenceCounter(eventsPath, seq);
	let metadata: TeamEventMetadata = {
		seq,
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
		metadata = {
			...metadata,
			fingerprint: baseMetadata?.fingerprint ?? computeEventFingerprint(fullEvent),
		};
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
			// Try immediate compact (not waiting for counter % 100).
			// Round 24 (BUG 1): we are INSIDE withEventLogLockSync. Use the unlocked
			// apply/rotate cores — the locked variants would deadlock (mkdir lock
			// is not re-entrant → 5s timeout → compaction/rotation never ran →
			// unbounded log growth → events silently dropped past 50MB).
			try {
				const prepared = prepareCompaction(eventsPath);
				if (prepared) applyCompactionUnlocked(eventsPath, prepared);
			} catch (error) {
				logInternalError("event-log.immediate-compact", error, `eventsPath=${eventsPath}`);
			}
			// Check if still too large after compact — if so, rotate
			if (fs.existsSync(eventsPath)) {
				const afterCompact = fs.statSync(eventsPath);
				if (afterCompact.size > MAX_EVENTS_BYTES) {
					rotateEventLogUnlocked(eventsPath);
				}
			}
		}
	}
	try {
		if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
			// Only reach here for non-terminal events that still overflow after compact+rotate.
			// Log and mark as not appended.
			logInternalError(
				"event-log.size-limit",
				new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes after compaction`),
				`eventsPath=${eventsPath}`,
			);
			skippedDueToSize = true;
		}
	} catch (error) {
		logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
	}
	// seq is already computed above via reserveSequence — reuse it for persist/cache.
	// const seq declaration removed (B7: seq is now computed before metadata object).
	if (!skippedDueToSize) {
		fs.appendFileSync(eventsPath, `${JSON.stringify(redactSecrets(fullEvent))}\n`, "utf-8");
		// F3a: skip data fsync for non-terminal events. We still call `persistSequence`
		// below, which means the .seq sidecar might briefly outpace the actual data
		// on disk in a crash, but the event-reconstructor (`event-reconstructor.ts`)
		// already handles inconsistent-tail recovery (appends after the sidecar's
		// claimed sequence are simply ignored on a lossless recovery scan). We trade
		// 1 ms of fsync per event on Windows for informational events; terminal
		// events keep the strict window between append and persistSequence.
		if (isTerminal) {
			const fd = fs.openSync(eventsPath, "r+");
			try {
				fs.fsyncSync(fd);
			} catch {
				// EPERM on Windows CI: best-effort flush
			} finally {
				fs.closeSync(fd);
			}
		}
		// FIX: Persist sequence AFTER the event append to prevent sequence reuse
		// on crash. Only update the sidecar when the event is definitively written.
		persistSequence(eventsPath, seq);
		// FIX: Update cache AFTER append so cache and log are consistent with each other.
		// This matches the async path behavior where cache is updated after the append.
		// If a crash occurs after append but before cache update, the .seq file is
		// already correct and nextSequence() will return the correct value on restart.
		try {
			const stat = fs.statSync(eventsPath);
			if (sequenceCache.size >= MAX_SEQUENCE_CACHE_ENTRIES) {
				evictOldestSequenceCacheEntries();
			}
			sequenceCache.set(eventsPath, {
				size: stat.size,
				mtimeMs: stat.mtimeMs,
				seq,
				lastAccessMs: Date.now(),
			});
		} catch (error) {
			logInternalError("event-log.persist-sequence", error, `eventsPath=${eventsPath}`);
		}
	}
	appendCounter++;
	if (appendCounter % 100 === 0 && needsRotation(eventsPath)) {
		// Round 24 (BUG 1): we are INSIDE withEventLogLockSync here (called via
		// appendEventInsideLock). The mkdir lock is NOT re-entrant, so calling the
		// locked compactEventLog would deadlock → 5s timeout → compaction never
		// ran → unbounded log growth → events silently dropped past 50MB. Use the
		// unlocked apply path instead (lock already held).
		try {
			const prepared = prepareCompaction(eventsPath);
			if (prepared) applyCompactionUnlocked(eventsPath, prepared);
		} catch (error) {
			logInternalError("event-log.rotation", error, `eventsPath=${eventsPath}`);
		}
	}
	try {
		emitFromTeamEvent(fullEvent);
	} catch (error) {
		logInternalError("event-log.emit", error);
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
		// FIX: Flush any pending buffered events before writing terminal event
		// to ensure durability of events that precede the terminal event in the
		// same flush cycle. Without this, a kill -9 after terminal event write
		// but before buffer flush would lose the buffered events.
		if (bufferedQueues.has(eventsPath)) {
			flushOneEventLogBuffer(eventsPath);
		}
		// For terminal events, write synchronously to ensure durability
		return Promise.resolve(appendEvent(eventsPath, event));
	}
	return new Promise<TeamEvent>((resolve, reject) => {
		const queue = bufferedQueues.get(eventsPath) ?? [];
		queue.push({ event, resolve, reject });
		bufferedQueues.set(eventsPath, queue);
		if (!bufferedTimers.has(eventsPath)) {
			// Wrap flush in async IIFE so the returned Promise is awaited (avoids
			// "floating promise" warnings under --test-force-exit and prevents
			// the timer from being treated as done before the flush actually
			// completes its async work).
			const timer = setTimeout(() => {
				flushOneEventLogBuffer(eventsPath).catch((error) => {
					logInternalError("event-log.buffered-flush", error, `eventsPath=${eventsPath}`);
				});
			}, bufferMs);
			bufferedTimers.set(eventsPath, timer);
		}
	});
}

async function flushOneEventLogBuffer(eventsPath: string): Promise<void> {
	const queue = bufferedQueues.get(eventsPath);
	bufferedQueues.delete(eventsPath);
	const timer = bufferedTimers.get(eventsPath);
	// Timer is cleared in the finally block to ensure cleanup happens even on error
	try {
		if (!queue || queue.length === 0) return;

		// FIX (Round 14, H3): When truncating the queue, explicitly reject the
		// dropped entries' promises. Previously `queue.splice()` silently
		// discarded the oldest items, and their associated Promises were never
		// resolved or rejected — causing callers to await forever and leaking
		// memory. We now reject with a clear error so callers can fall back.
		if (queue.length > 1000) {
			const dropped = queue.splice(0, queue.length - 500);
			overflowCounter++;
			// FIX: Include first/last dropped event type and sequence number in error
			// message to make debugging easier when events are dropped.
			const firstDroppedMeta = dropped[0]?.event.metadata;
			const lastDroppedMeta = dropped[dropped.length - 1]?.event.metadata;
			logInternalError(
				"event-log.buffer-overflow",
				new Error(
					`Buffer overflow #${overflowCounter}: Dropped ${dropped.length} events: first seq=${firstDroppedMeta?.seq} type=${dropped[0]?.event.type}, last seq=${lastDroppedMeta?.seq} type=${dropped[dropped.length - 1]?.event.type}`,
				),
				`${eventsPath}: ${queue.length + dropped.length} entries > 1000 cap`,
			);
			for (const item of dropped) {
				item.reject(
					new Error(
						`Event log buffer overflow: ${queue.length + dropped.length} entries > 1000 cap; oldest ${dropped.length} dropped to keep memory bounded; first dropped seq=${firstDroppedMeta?.seq} type=${dropped[0]?.event.type}`,
					),
				);
			}
		}

		// FIX (Issue 2): Use async lock instead of withEventLogLockSync to avoid
		// blocking the event loop. The sync lock uses sleepSync which blocks for
		// up to 5s and prevents AbortSignal handlers from firing.
		// FIX (P0 follow-up): Batch the file write + fsync + persistSequence across
		// the whole queue. Previously each event triggered its own fsyncSync,
		// turning 100 buffered events into 100 fsyncs (~3s on tmpfs). Now we do
		// 1 appendFileSync + 1 fsync + 1 persistSequence for the whole batch.
		await withEventLogLockAsync(eventsPath, async () => {
			await appendEventBatchInsideLock(eventsPath, queue);
		});
	} catch (error) {
		// Lock acquire failed — fail every queued item so callers can fall back.
		if (queue) for (const item of queue) item.reject(error);
	} finally {
		bufferedTimers.delete(eventsPath);
	}
}

/** Asynchronously flush every queued buffered event across all paths. */
export async function flushEventLogBuffer(): Promise<void> {
	for (const eventsPath of [...bufferedQueues.keys()]) await flushOneEventLogBuffer(eventsPath);
}

/**
 * EL-2: Synchronously flush every queued buffered event across all paths.
 * Used by the `exit` / `uncaughtException` / `SIGTERM` / `SIGINT` handlers,
 * which CANNOT await async work (process is terminating). The async
 * flushEventLogBuffer() previously called from these handlers created
 * floating promises that never resolved, and the process exited before
 * any buffered events were written — losing all events buffered via
 * appendEventBuffered (task.progress etc.). This sync variant writes the
 * buffered batches using the sync event-log lock + appendFileSync + fsync
 * + persistSequence, recovering buffered events before termination.
 * In-flight asyncQueues (appendEventAsync writes already dispatched to
 * the thread pool) remain best-effort and cannot be awaited on `exit` —
 * we clear them to drop stale state. SIGKILL cannot be intercepted.
 */
export function flushBufferedQueuesSync(): void {
	for (const eventsPath of [...bufferedQueues.keys()]) {
		const queue = bufferedQueues.get(eventsPath);
		bufferedQueues.delete(eventsPath);
		if (!queue || queue.length === 0) continue;
		try {
			withEventLogLockSync(eventsPath, () => {
				// appendEventBatchInsideLock is declared async but its body is fully
				// synchronous (fs.appendFileSync + fs.fsyncSync + persistSequence,
				// no awaits). Invoking without await runs the body synchronously and
				// returns a resolved Promise that we discard.
				void appendEventBatchInsideLock(eventsPath, queue);
			});
		} catch (error) {
			logInternalError("event-log.sync-flush", error, eventsPath);
		}
	}
	for (const eventsPath of [...bufferedTimers.keys()]) bufferedTimers.delete(eventsPath);
}

/**
 * Schedule an async event append without waiting for the result.
 * Uses the non-blocking async queue to avoid blocking the event loop.
 * Use only for events whose return value is ignored (high-frequency `task.progress`).
 * Errors are logged via logInternalError.
 */
export function appendEventFireAndForget(eventsPath: string, event: AppendTeamEvent): void {
	appendEventAsync(eventsPath, event).catch((error) => logInternalError("event-log.fire-and-forget", error, eventsPath));
}

// Auto-flush on process exit so buffered events do not silently leak.
// Defense-in-depth: SIGTERM/SIGINT use setImmediate so the handler returns
// immediately and the main thread is not blocked by sync I/O.
// FIX (P0 follow-up): Only call flushEventLogBuffer() / drainAsyncQueues() if
// there is actually pending work. Calling them unconditionally creates a new
// floating Promise that the test runner detects under --test-force-exit,
// failing tests with "Promise resolution is still pending but the event loop
// has already resolved" even when the test body completed cleanly.
process.on("exit", () => {
	// EL-2: synchronously flush buffered events before the process terminates.
	// `exit` is sync-only and cannot await async work; the previous async
	// flushEventLogBuffer()/drainAsyncQueues() created floating promises that
	// never resolved, and the process exited before any buffered events were
	// written. flushBufferedQueuesSync uses the sync lock + appendFileSync +
	// fsync + persistSequence to recover buffered events.
	flushBufferedQueuesSync();
	asyncQueues.clear();
});

// FIX (P0 follow-up): Drain buffered events on `beforeExit` (async-aware).
// The `exit` handler above is sync-only and cannot await the flush, leaving
// pending promises that the test runner detects under --test-force-exit as
// "Promise resolution is still pending but the event loop has already
// resolved". `beforeExit` fires when the event loop drains naturally and
// supports async handlers, so we can await the flush here and let the loop
// drain cleanly before process.exit() is called.
process.on("beforeExit", async () => {
	if (bufferedQueues.size > 0) {
		try {
			await flushEventLogBuffer();
		} catch {
			/* best-effort */
		}
	}
	if (asyncQueues.size > 0) {
		try {
			await drainAsyncQueues();
		} catch {
			/* best-effort */
		}
	}
});
process.on("SIGTERM", () => setImmediate(() => flushBufferedQueuesSync()));
process.on("SIGINT", () => setImmediate(() => flushBufferedQueuesSync()));
// FIX (Issue 1): Handle uncaught exceptions to flush buffered events before
// the process terminates. The async queues use promise chains that will be
// abandoned on crash; clearing the map prevents memory leaks and stale state.
// Note: SIGKILL (kill -9) cannot be intercepted and is not handled.
process.on("uncaughtException", (error) => {
	// EL-2: synchronously flush buffered events before re-throwing (which
	// terminates the process). The previous async flushEventLogBuffer() +
	// drainAsyncQueues() couldn't complete before process exit; use the sync
	// variant to recover buffered events.
	flushBufferedQueuesSync();
	asyncQueues.clear();
	// Re-throw to preserve default uncaught exception behavior (process exit)
	throw error;
});

export function readEvents(eventsPath: string): TeamEvent[] {
	if (!fs.existsSync(eventsPath)) return [];
	return fs
		.readFileSync(eventsPath, "utf-8")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as TeamEvent];
			} catch {
				return [];
			}
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
