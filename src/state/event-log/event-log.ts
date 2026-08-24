import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_EVENT_LOG } from "../../config/defaults.ts";
import { errors } from "../../errors.ts";
import { emitFromTeamEvent } from "../../ui/run-event-bus.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { redactSecrets } from "../../utils/redaction.ts";
import { sleep, sleepSync } from "../../utils/sleep.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import { applyCompactionUnlocked, needsRotation, prepareCompaction, rotateEventLogUnlocked } from "./event-log-rotation.ts";
import {
	advanceSequenceCounter,
	persistSequenceMonotonic,
	reservedSequenceEnd,
	reserveSequence,
	reserveSequenceUnderLockAsync,
} from "./sequence-cache.ts";
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
	/** R17-S1 (Phase 3.8): set to `true` when the append was SKIPPED because the
	 *  events file exceeded MAX_EVENTS_BYTES after compaction+rotation and the
	 *  event is non-terminal. The returned TeamEvent then represents an event
	 *  that was NOT persisted (and NOT emitted to the run-event-bus) — callers
	 *  can detect the silent drop instead of treating it as success. Never
	 *  written to disk (skipped events are not appended), so this is not an
	 *  on-disk format change. */
	skippedDueToSize?: boolean;
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

// P0-2: per-eventsPath append counter. Previously a single module-global shared
// across all runs AND never incremented on the async path, so the async rotation
// gate (`0 % 100 === 0`) was always true → needsRotation ran on EVERY async append
// (a full read+parse+rewrite once the log crossed 4 MB). FIFO-bounded to avoid
// unbounded growth with run count.
const appendCounters = new Map<string, number>();
const APPEND_COUNTER_MAX_ENTRIES = 256;
export function tickAppendCounter(eventsPath: string, inc = 1): boolean {
	const prev = appendCounters.get(eventsPath) ?? 0;
	const next = prev + inc;
	appendCounters.set(eventsPath, next);
	if (appendCounters.size > APPEND_COUNTER_MAX_ENTRIES) {
		const oldest = appendCounters.keys().next().value;
		if (oldest !== undefined) appendCounters.delete(oldest);
	}
	// True when a 100-boundary is crossed (matches the old `next % 100 === 0`
	// semantics for inc=1, and generalizes to batch increments).
	return Math.floor(next / 100) > Math.floor(prev / 100);
}
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
 *  `flushOneEventLogBuffer`, and `state/coordination/mailbox.ts`. Prefer the async alternative
 *  (`appendEventAsync`) for all new code.
 */
export function withEventLogLockSync<T>(eventsPath: string, fn: () => T, options?: { timeoutMs?: number; staleMs?: number }): T {
	// Ensure parent directory exists before attempting lock
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	const lockDir = `${eventsPath}.mkdirlock`;
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
				// to check for orphaned .mkdirlock dirs / stale processes.
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
// R5-L4: safety cap for error-path reset entries (see the appendEventAsync
// error handler) — a path whose queue is reset after an error and then never
// re-accessed would otherwise retain its entry until process exit.
const MAX_ASYNC_QUEUES = 256;
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

/** C-01: Async cross-process file lock for an eventsPath. Uses `fs.promises.mkdir`
 *  (atomic O_EXCL on POSIX) for cross-process mutual exclusion, and `await sleep(50)`
 *  for retry backoff — NOT sleepSync (which blocks the event loop and was the
 *  v0.9.26 deadlock root cause).
 *
 *  Two-tier design: the `asyncLocks` promise chain provides in-process
 *  serialization of the lock-acquire/release cycle. The mkdir lock provides
 *  cross-process serialization. Callers wrapped in `asyncQueues`
 *  (appendEventAsync) or directly (flushOneEventLogBuffer) use this for the
 *  cross-process tier.
 *
 *  Deadlock safety (v0.9.26 lesson): ALL retry backoff uses `await sleep(50)`
 *  (async timer — yields the event loop). NEVER sleepSync. The mkdir lock is
 *  SEPARATE LOCK DIR (`.alock`): the async path uses `${eventsPath}.alock` while
 *  the sync path (`withEventLogLockSync`) uses `${eventsPath}.mkdirlock`. This is
 *  REQUIRED because `withEventLogLockSync`'s retry loop uses `sleepSync(50)` which
 *  blocks the event loop continuously — if both paths shared the same lock dir,
 *  the sync retry loop would starve the async path (which needs event-loop
 *  iterations to complete), causing a 5s timeout deadlock. Within-process seq
 *  uniqueness is maintained by the shared `seqCounters` Map + `O_APPEND` writes.
 *  Cross-process async-vs-async is fully protected. Sync-vs-async cross-process
 *  on the same eventsPath is mitigated by `O_APPEND` atomic writes + the
 *  shared sidecar (extremely unlikely scenario — workers write to their own
 *  run-scoped events.jsonl, not the parent's).
 *
 *  R16-B1/R17 CORRECTION (Phase 3.6): the "extremely unlikely" claim above
 *  was REFUTED empirically — 14 parent-side sync appendEvent sites write the
 *  live run's eventsPath while child async appends run, and Round 17 measured
 *  75% duplicate events / 527 duplicate seqs over 3000 events with the natural
 *  (unwidened) rate. The family split itself is UNCHANGED (merging the two
 *  lock dirs would reintroduce the sleepSync-vs-async-timer deadlock this
 *  comment documents); the seq race is instead closed by the shared
 *  `.seqlock` (L3) around the .seq sidecar reservation in
 *  reserveSequenceUnderLock/Async — see the R16-B1 block near persistSequence.
 *
 *  NOT re-entrant: callers inside this lock must use unlocked compaction
 *  variants (prepareCompaction + applyCompactionUnlocked, rotateEventLogUnlocked)
 *  to avoid self-deadlock. */
async function withEventLogLockAsync<T>(
	eventsPath: string,
	fn: () => Promise<T>,
	options?: { timeoutMs?: number; staleMs?: number },
): Promise<T> {
	const queueKey = eventsPath;
	// .then(() => undefined, () => undefined) prevents rejection-poisoning: if
	// the previous call's chain rejected (e.g., lock timeout), the next caller
	// starts fresh instead of propagating the rejection indefinitely.
	const prev = (asyncLocks.get(queueKey) ?? Promise.resolve()).then(
		() => undefined,
		() => undefined,
	);
	const next = prev.then(async (): Promise<T> => {
		// Ensure parent directory exists before attempting lock
		await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });

		const lockDir = `${eventsPath}.alock`;
		const pidFile = path.join(lockDir, "pid");
		const timeout = options?.timeoutMs ?? 5000;
		const staleMs = options?.staleMs ?? 10000;
		const start = Date.now();
		let acquired = false;

		// Cross-process lock acquisition loop (async, no sleepSync)
		while (true) {
			try {
				await fs.promises.mkdir(lockDir);
				try {
					// PERF (2026-08-24): "wx" (O_CREAT|O_EXCL) — fails rather than
					// following a planted symlink, so no O_NOFOLLOW/temp/rename
					// ceremony needed for this disposable, mtime-stale-detected
					// 4-byte file. We own the lock dir (we just mkdir'd it), so
					// EEXIST means a crashed holder's leftover under OUR fresh dir
					// or an attack — either way, skip: the dir itself is the mutex.
					const fh = await fs.promises.open(pidFile, "wx");
					try {
						await fh.write(String(process.pid));
					} finally {
						await fh.close();
					}
				} catch {
					/* best-effort */
				}
				acquired = true;
				break;
			} catch {
				if (Date.now() - start > timeout) {
					throw errors.eventLogLockTimeout(eventsPath, timeout);
				}
				// Stale detection: mtime-based (handles crash between mkdir and pidFile).
				try {
					const dirStat = await fs.promises.stat(lockDir);
					if (Date.now() - dirStat.mtimeMs > staleMs) {
						await fs.promises.rm(lockDir, { recursive: true, force: true });
						continue;
					}
				} catch {
					/* dir vanished — let loop retry */
				}
				// PID check (secondary fast-path for dead-but-fresh holders)
				try {
					const raw = await fs.promises.readFile(pidFile, "utf-8").catch(() => "");
					const ownerPid = Number.parseInt(raw.trim(), 10);
					if (!Number.isNaN(ownerPid) && ownerPid !== process.pid) {
						try {
							process.kill(ownerPid, 0);
						} catch {
							/* dead — but mtime not stale yet, keep waiting */
						}
					}
				} catch {
					/* no pid file — mtime check above handles it */
				}
				// ASYNC sleep — yields the event loop (NOT sleepSync)
				await sleep(50);
			}
		}

		try {
			return await fn();
		} finally {
			if (acquired) {
				// PID-guarded release: verify pidFile still records OUR pid before
				// removing. If our fn exceeded staleMs, another process could have
				// stolen our lock — don't delete the stealer's dir.
				try {
					const currentPid = await fs.promises.readFile(pidFile, "utf-8").catch(() => "");
					if (currentPid.trim() === String(process.pid)) {
						await fs.promises.rm(lockDir, { recursive: true, force: true });
					}
				} catch {
					/* lock stolen or already gone — do not touch */
				}
			}
		}
	});
	asyncLocks.set(queueKey, next);
	try {
		return await next;
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
	// C-01: Body extracted to local function for two-tier lock wrapping.
	// Two-tier: asyncQueues (in-process serialize) → withEventLogLockAsync
	// (cross-process serialize via mkdir O_EXCL). Seq allocation + append run
	// INSIDE the cross-process lock. Compaction uses UNLOCKED variants
	// (mkdir lock is NOT re-entrant).
	const doAppendUnderLock = async (): Promise<TeamEvent> => {
		// Build metadata (same logic as appendEventInsideLock)
		// FIX: Sequence is computed INSIDE the promise chain. We NO LONGER persist
		// the sequence number before the append — that caused sequence reuse if
		// appendFile failed after persistSequence succeeded. Instead, we persist
		// ONLY AFTER successful appendFile, so the sidecar is only updated when
		// the event is definitively written. If appendFile fails, the sidecar is
		// not updated and nextSequence() will re-scan on next call, returning the
		// correct value without reuse.
		// R16-B1 (Phase 3.6) PARTIAL SUPERSESSION: the sidecar IS now advanced at
		// reservation time INSIDE the .seqlock (advance-on-reserve, gap-not-dup —
		// see reserveSequenceLocked); the post-append persist below is kept and is
		// idempotent (writes the same value the reservation already persisted).
		const baseMetadata = event.metadata;
		let seq: number;
		if (baseMetadata?.seq !== undefined) {
			seq = baseMetadata.seq;
			advanceSequenceCounter(eventsPath, seq);
		} else {
			// R16-B1 (Phase 3.6): reservation now acquires the shared `.seqlock`
			// (async acquire wrapper — never sleepSync on the event loop) and
			// PERSISTS the reserved seq inside it (advance-on-reserve). The old
			// "do NOT call persistSequence here" note is superseded: without the
			// in-lock persist, two processes in different family locks both read
			// sidecar=N and both reserve N+1 (Round 17: 75% dup events). A failed
			// append after reservation now yields a seq GAP (tolerated by the
			// event-reconstructor's lossless recovery), never a duplicate.
			seq = await reserveSequenceUnderLockAsync(eventsPath);
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
		// FIND-10: track whether overflow handling modified the file so we can
		// reuse fileStat for the post-overflow size check (avoids redundant stat).
		let overflowHandled = false;
		if (!isTerminal && fileStat) {
			const stat = fileStat;
			if (stat.size > MAX_EVENTS_BYTES) {
				overflowHandled = true;
				try {
					const prepared = prepareCompaction(eventsPath);
					if (prepared) applyCompactionUnlocked(eventsPath, prepared);
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
						// R17-S1 (Phase 3.8): a failed rotation leaves the file over the
						// limit — the next non-terminal appends would be silently skipped.
						// Check the boolean (previously ignored) and surface severity
						// "error" so the chain signals at EVERY step.
						if (!rotateEventLogUnlocked(eventsPath)) {
							logInternalError(
								"event-log.rotate-failed",
								new Error(`event log rotation failed; file remains over ${MAX_EVENTS_BYTES} bytes`),
								`eventsPath=${eventsPath}`,
								"error",
							);
						}
					}
				}
			}
		}
		// FIND-10: collapse redundant stat. If no overflow handling occurred,
		// the file hasn't changed since fileStat — reuse it instead of re-stat'ing.
		let sizeCheckStat: fs.Stats | undefined;
		if (overflowHandled) {
			try {
				sizeCheckStat = await fs.promises.stat(eventsPath).catch(() => undefined);
			} catch {
				/* file does not exist */
			}
		} else {
			sizeCheckStat = fileStat;
		}
		try {
			if (sizeCheckStat && sizeCheckStat.size > MAX_EVENTS_BYTES) {
				logInternalError(
					"event-log.size-limit",
					new Error(`events file ${eventsPath} exceeds ${MAX_EVENTS_BYTES} bytes after compaction`),
					`eventsPath=${eventsPath}`,
					// R17-S1 (Phase 3.8, Round 18 escalation to HIGH): this was default
					// severity "debug" (PI_TEAMS_DEBUG-gated) → fully silent drop in
					// production. "error" always emits.
					"error",
				);
				skippedDueToSize = true;
				// R17-S1: surface the drop on the returned event itself — resolve
				// with an indicator instead of as-if-persisted success. Never
				// throw on the skip path (Round 18 caution), and never emit a
				// non-persisted event to the run-event-bus (gate below).
				metadata.skippedDueToSize = true;
			}
		} catch (error) {
			logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
		}

		if (!skippedDueToSize) {
			const line = JSON.stringify(redactSecrets(fullEvent)) + "\n";
			// Phase 1.5: when worker atomic writer is enabled, append via worker.
			if (isWorkerAtomicWriterEnabled()) {
				await appendFileViaWorker(eventsPath, line);
				// P0-4 (F3a mirror): fsync terminal events only; non-terminal events are
				// informational and the event-reconstructor tolerates an inconsistent tail.
				if (isTerminal) {
					const fd = await fs.promises.open(eventsPath, "r+");
					try {
						await fd.sync();
					} finally {
						await fd.close();
					}
				}
			} else {
				// FIND-10: single-fd append+fsync. Opens in append mode, writes,
				// fsyncs on the SAME fd, then closes — eliminating the separate
				// open("r+") + sync that previously doubled the fd count. The
				// fsync (seq-integrity protection) is preserved exactly: it still
				// closes the crash window between append and persistSequence.
				const fd = await fs.promises.open(eventsPath, "a");
				try {
					await fd.appendFile(line, "utf-8");
					// P0-4 (F3a mirror): skip the data fsync for non-terminal events.
					if (isTerminal) await fd.sync();
				} finally {
					await fd.close();
				}
			}
			// R16-B1 (Phase 3.6): advance-on-reserve already persisted this exact
			// value INSIDE the .seqlock — re-persisting it here (outside the lock)
			// can REGRESS the sidecar after another process reserved further
			// (observed: re-reserved duplicate seqs in the b9 cross-process bench).
			// Only EXPLICIT (pre-assigned) seqs bypassed the reservation — persist
			// those, monotonically and under the .seqlock, so a lower explicit seq
			// can never roll the sidecar back either.
			if (baseMetadata?.seq !== undefined) persistSequenceMonotonic(eventsPath, seq);
		}
		if (tickAppendCounter(eventsPath) && needsRotation(eventsPath)) {
			try {
				const prepared = prepareCompaction(eventsPath);
				if (prepared) applyCompactionUnlocked(eventsPath, prepared);
			} catch (error) {
				logInternalError("event-log.rotation", error, `eventsPath=${eventsPath}`);
			}
		}
		// R17-S1 (Phase 3.8): gate the UI-bus emit on !skippedDueToSize — the bus
		// must never receive events that were NOT persisted (live-UI vs
		// reconstructed-state divergence, Round 18 reviewer addendum).
		if (!skippedDueToSize) {
			try {
				emitFromTeamEvent(fullEvent);
			} catch (error) {
				logInternalError("event-log.emit", error);
			}
		}

		// PERF (2026-08-24): the per-append sequenceCache upkeep that lived here
		// (post-append stat + Map set + occasional O(n log n) evict sort) fed no
		// hot reader — sequenceCache is read only by nextSequence, which is
		// consulted solely by seeding/test helpers (see the ST-12 note in
		// sequence-cache.ts); all three append paths allocate seqs via
		// reserveSequence, which reads the .seq sidecar + seqCounters instead.
		// nextSequence() re-seeds via its sidecar/scan fallback when called.
		return fullEvent;
	};
	// C-01: Two-tier lock — asyncQueues (in-process serialize) →
	// withEventLogLockAsync (cross-process serialize via mkdir O_EXCL).
	const prev = asyncQueues.get(queueKey) ?? Promise.resolve();
	const next = prev.then(async (): Promise<TeamEvent> => {
		await fs.promises.mkdir(path.dirname(eventsPath), { recursive: true });
		return withEventLogLockAsync(eventsPath, doAppendUnderLock);
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
			// R5-L4: cap the retained reset entries — evict oldest (Map insertion
			// order) so paths that error and are never re-accessed cannot leak.
			while (asyncQueues.size >= MAX_ASYNC_QUEUES) {
				const oldestKey = asyncQueues.keys().next().value;
				if (oldestKey === undefined) break;
				asyncQueues.delete(oldestKey);
			}
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
 * the sequence sidecar once with the last seq (no per-append sequenceCache
 * upkeep — that cache no longer exists on the append paths; see the PERF
 * 2026-08-24 note in appendEventAsync). Resolves each item with its finalized
 * event (carrying the assigned seq). This collapses N fsyncs into 1 for the
 * buffered write path, which is the entire point of buffering — the previous
 * per-event fsync made buffer coalescing useless and added ~30ms/event on
 * tmpfs.
 */
async function appendEventBatchInsideLock(eventsPath: string, queue: BufferedAppend[]): Promise<void> {
	if (queue.length === 0) return;
	// P0-2: keep the per-path counter honest for cross-path rotation sampling.
	tickAppendCounter(eventsPath, queue.length);
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });

	// PERF (2026-08-24): one hoisted pre-append stat replaces the pre-flight
	// existsSync+statSync pair below. The after-compaction re-checks further
	// down keep their own fresh stats — compaction/rotation may have changed
	// the file since preStat was taken, so they must not see a stale
	// (pre-compaction) size.
	let preStat: fs.Stats | undefined;
	try {
		preStat = fs.statSync(eventsPath);
	} catch {
		/* log absent — first append */
	}

	// Pre-flight size check (mirrors appendEventInsideLock). We do it once for
	// the batch instead of once per event.
	try {
		if (preStat) {
			if (preStat.size > MAX_EVENTS_BYTES) {
				try {
					const prepared = prepareCompaction(eventsPath);
					if (prepared) applyCompactionUnlocked(eventsPath, prepared);
				} catch (error) {
					logInternalError("event-log.batch-immediate-compact", error, `eventsPath=${eventsPath}`);
				}
				if (fs.existsSync(eventsPath) && fs.statSync(eventsPath).size > MAX_EVENTS_BYTES) {
					// R17-S1 (Phase 3.8): check the rotation boolean (previously ignored)
					// and surface severity "error" — a failed rotation leaves the file
					// over the limit and the batch below will be rejected as a result.
					if (!rotateEventLogUnlocked(eventsPath)) {
						logInternalError(
							"event-log.rotate-failed",
							new Error(`event log rotation failed; file remains over ${MAX_EVENTS_BYTES} bytes`),
							`eventsPath=${eventsPath}`,
							"error",
						);
					}
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
	// seq, breaking the "unique monotonic seq" contract. persistSequenceMonotonic
	// at the end refreshes the sidecar to the last assigned seq.
	// B7: use reserveSequence for atomic seq assignment across all paths.
	// R16-B1 (Phase 3.6): reserve the WHOLE batch range (count = queue.length)
	// under the .seqlock in one acquire — the locally incremented nextSeq below
	// then stays inside the reserved range even when explicit baseMetadata.seq
	// values skip some of the reserved slots (those become gaps, never dups).
	const startingSeq = queue[0]?.event.metadata?.seq ?? reserveSequence(eventsPath, queue.length);
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
	// PERF (2026-08-24): snapshot the in-process reservation end BEFORE the B7
	// advance below — seqCounters is about to be raised to lastSeq, so reading
	// reservedSequenceEnd() at the persist site would ALWAYS see lastSeq ≤
	// counter and skip the persist even for explicit seqs the reservation never
	// covered (sidecar would lag the file → cross-process re-reservation inside
	// the file's true range — the exact R16-B1 duplicate-seq race).
	const reservedEnd = reservedSequenceEnd(eventsPath);
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
	// R16-B1 (Phase 3.6): monotonic persist under the .seqlock — the reservation
	// already persisted the batch range end; this covers explicit (pre-assigned)
	// seqs that may exceed it and can never REGRESS the sidecar (the old bare
	// persistSequence could write a lower lastSeq over a higher reserved value).
	// PERF (2026-08-24): R16-B1 advance-on-reserve already persisted the
	// reserved end inside the .seqlock at reservation time. Re-acquiring
	// the seqlock (~12 syscalls) to conclude "no write needed" is pure
	// overhead in the single-writer common case — skip when lastSeq is
	// covered by the reservation snapshot above; explicit seqs beyond the
	// reserved range still persist.
	if (lastSeq > reservedEnd) {
		persistSequenceMonotonic(eventsPath, lastSeq);
	}

	// Phase 3: resolve all promises. (PERF 2026-08-24: the sequenceCache upkeep
	// that used to live here fed no hot reader — see the note in
	// appendEventAsync; nextSequence re-seeds via its sidecar/scan fallback.)
	for (const { item, fullEvent } of finalized) item.resolve(fullEvent);
}

function appendEventInsideLock(eventsPath: string, event: AppendTeamEvent): TeamEvent {
	fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
	// PERF (2026-08-24): one hoisted pre-append stat replaces the overflow
	// existsSync+statSync pair below. The after-compaction re-checks further
	// down keep their own fresh stats — compaction/rotation may have changed
	// the file since preStat was taken, so they must not see a stale
	// (pre-compaction) size.
	let preStat: fs.Stats | undefined;
	try {
		preStat = fs.statSync(eventsPath);
	} catch {
		/* log absent — first append */
	}
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
	if (!isTerminal && preStat) {
		if (preStat.size > MAX_EVENTS_BYTES) {
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
					// R17-S1 (Phase 3.8): check the rotation boolean (previously
					// ignored) and surface severity "error" — a failed rotation
					// leaves the file over the limit and the size check below will
					// silently skip every subsequent non-terminal append.
					if (!rotateEventLogUnlocked(eventsPath)) {
						logInternalError(
							"event-log.rotate-failed",
							new Error(`event log rotation failed; file remains over ${MAX_EVENTS_BYTES} bytes`),
							`eventsPath=${eventsPath}`,
							"error",
						);
					}
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
				// R17-S1 (Phase 3.8, Round 18 escalation to HIGH): was default "debug"
				// (PI_TEAMS_DEBUG-gated) → fully silent drop in production. "error"
				// always emits.
				"error",
			);
			skippedDueToSize = true;
			// R17-S1: surface the drop on the RETURNED event (never throw — callers
			// run inside withRunLockSync and a throw would fail cancel/save critical
			// sections; Round 18 fix-design caution). The returned TeamEvent carries
			// skippedDueToSize=true so live-path callers can detect the drop; the
			// event is NOT persisted and NOT emitted (gate below).
			metadata.skippedDueToSize = true;
		}
	} catch (error) {
		logInternalError("event-log.size-check", error, `eventsPath=${eventsPath}`);
	}
	// seq is already computed above via reserveSequence — reuse it for the
	// explicit-seq persist below (no sequenceCache upkeep on append paths).
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
		// R16-B1 (Phase 3.6): advance-on-reserve already persisted this exact
		// value INSIDE the .seqlock — re-persisting it here (outside the lock)
		// can REGRESS the sidecar after another process reserved further
		// (observed: re-reserved duplicate seqs in the b9 cross-process bench).
		// Only EXPLICIT (pre-assigned) seqs bypassed the reservation — persist
		// those, monotonically and under the .seqlock.
		if (explicitSeq !== undefined) persistSequenceMonotonic(eventsPath, seq);
		// PERF (2026-08-24): the per-append sequenceCache upkeep that lived here
		// (post-append stat + Map set + occasional evict sort) fed no hot reader —
		// see the note in appendEventAsync. The .seq sidecar is already current
		// (advance-on-reserve / persistSequenceMonotonic above), and nextSequence()
		// re-seeds via its sidecar/scan fallback when called.
	}
	if (tickAppendCounter(eventsPath) && needsRotation(eventsPath)) {
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
	// R17-S1 (Phase 3.8): gate the UI-bus emit on !skippedDueToSize — the bus
	// must never receive events that were NOT persisted (live-UI vs
	// reconstructed-state divergence, Round 18 reviewer addendum).
	if (!skippedDueToSize) {
		try {
			emitFromTeamEvent(fullEvent);
		} catch (error) {
			logInternalError("event-log.emit", error);
		}
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
		// C-01: Await the flush before writing the terminal event. Previously the
		// flush was fire-and-forget, which worked when withEventLogLockAsync was a
		// pure promise-chain (completed as a microtask before the caller resumed).
		// Now that withEventLogLockAsync acquires a cross-process mkdir lock (.alock),
		// the flush needs multiple event-loop iterations. Without awaiting, the
		// terminal event would be written before the buffered events.
		const flushPromise = bufferedQueues.has(eventsPath) ? flushOneEventLogBuffer(eventsPath).catch(() => undefined) : Promise.resolve();
		return flushPromise.then(() => appendEvent(eventsPath, event));
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
			timer.unref();
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

// --- Re-export shim (Phase 2.4): moved modules stay reachable from this path ---
export * from "./cursor.ts";
export * from "./sequence-cache.ts";
