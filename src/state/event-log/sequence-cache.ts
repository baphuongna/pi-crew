import * as fs from "node:fs";
import * as path from "node:path";
import { errors } from "../../errors.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { sleepSync } from "../../utils/sleep.ts";
import { atomicWriteFile } from "../atomic-write.ts";
import type { TeamEvent } from "./event-log.ts";

export const sequenceCache = new Map<string, { size: number; mtimeMs: number; seq: number; lastAccessMs: number }>();
export const MAX_SEQUENCE_CACHE_ENTRIES = 256;

export function evictOldestSequenceCacheEntries(): void {
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
		// Trust the sidecar, but guard against a REGRESSED sidecar (e.g. the
		// async path persisted a lower seq, rolling the sidecar back below the
		// file's true max). Take max with a full scan so a regressed sidecar
		// cannot produce a duplicate sequence number (EL-1 regression guard).
		// NOTE (ST-12): a full scan here is acceptable because all three append
		// paths now allocate seqs via reserveSequence/reserveSequenceUnderLock
		// (ST-5: re-read sidecar under lock + max with in-process counter);
		// nextSequence is only consulted for seeding/test helpers, NOT on the
		// production append path. ST-12's perf goal (avoid 4MB scan on first
		// append) is therefore met by ST-5 at the reserveSequence layer.
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
		// P0-4: the .seq sidecar is disposable (event-reconstructor tolerates an
		// inconsistent tail); best-effort avoids 2 fsyncs per event append.
		atomicWriteFile(sequencePath(eventsPath), String(seq), { durability: "best-effort" });
	} catch (error) {
		logInternalError("event-log.persist-sequence-file", error, `eventsPath=${eventsPath}`);
	}
}

// R16-B1 (Phase 3.6): THIRD lock namespace `${eventsPath}.seqlock` — a tiny
// cross-process lock that serializes ONLY the .seq sidecar read-compute-write
// in reserveSequenceUnderLock. Empirically justified by Round 17: 3000 events
// across 2 processes on the same eventsPath produced 527 duplicate seq values
// (75% duplicate events) because the sync family (.mkdirlock) and async family
// (.alock) are DISJOINT lock namespaces that both trust the sidecar with no
// mutual exclusion (read sidecar=N → both reserve N+1).
//
// Lock-ordering contract (Round 18 Part C): L1(run) → L2(event-log family:
// .mkdirlock/.alock) → L3(.seqlock). The .seqlock is a PURE-SYNC, SHORT
// critical section (sidecar read + counter update + best-effort persist —
// ~2 atomic writes). NEVER acquire L1/L2 while holding L3.
//
// Do NOT naively merge .mkdirlock+.alock instead — that reintroduces the
// v0.9.26 sleepSync-vs-async-timer deadlock (see the withEventLogLockAsync
// docblock): the sync retry loop's sleepSync starves the async path's
// event-loop-dependent acquire. The family split is intentional; .seqlock
// closes the seq race WITHOUT coupling the two families' retry loops.
//
// Two acquire wrappers share ONE lock dir + pid file:
//   - withSeqLock:      sync acquire (sleepSync backoff) — ALL families.
//   - withSeqLockAsync:  thin alias of withSeqLock (see below).
// Bounds are tighter than the family locks because the section is tiny:
// timeout 2s / stale 1s / retry 5ms. NOTE: staleMs MUST be < timeoutMs — a
// crashed holder leaves the lock dir behind, and the acquirer must get the
// chance to stale-steal it BEFORE its own timeout throws (observed flake:
// mailbox-api symlink test, killed scaffold holder → 2s spin → throw). The
// 1s staleness is still ~1000x the sub-millisecond critical section; the only
// theoretical over-run is a missing-.seq sidecar forcing scanSequence over a
// multi-MB file, which is far below 1s at the 4MB rotation threshold.
const SEQ_LOCK_TIMEOUT_MS = 2000;
const SEQ_LOCK_STALE_MS = 1000;
const SEQ_LOCK_RETRY_MS = 5;

function seqLockPath(eventsPath: string): string {
	return `${eventsPath}.seqlock`;
}

function reserveSequenceLocked(eventsPath: string, count: number): number {
	let stored = readStoredSequence(eventsPath);
	if (stored === undefined) {
		stored = scanSequence(eventsPath);
	}
	const inProcess = seqCounters.get(eventsPath) ?? 0;
	const last = Math.max(stored, inProcess);
	const start = last + 1;
	seqCounters.set(eventsPath, start + count - 1);
	enforceSeqCountersCap();
	// R16-B1: advance-on-reserve. The sidecar MUST be persisted INSIDE the
	// .seqlock — persisting only after the append would leave the window where
	// two processes in different family locks both read sidecar=N and both
	// reserve N+1 (the exact Round-17-confirmed race). Inverting the old
	// "persist only after successful append" ordering (see the sync :persist
	// and async :persist comments) is strictly safer: a failed append after
	// reservation yields a seq GAP, never a duplicate, and the
	// event-reconstructor already tolerates a sidecar ahead of the data
	// (lossless recovery ignores appends beyond the claimed seq — F3a).
	persistSequence(eventsPath, start + count - 1);
	return start;
}

function withSeqLock<T>(eventsPath: string, fn: () => T): T {
	const lockDir = seqLockPath(eventsPath);
	const pidFile = path.join(lockDir, "pid");
	const start = Date.now();
	let acquired = false;
	while (!acquired) {
		try {
			fs.mkdirSync(lockDir);
			try {
				// P0-4: the lock pid file is disposable stale-lock state; best-effort.
				atomicWriteFile(pidFile, String(process.pid), { durability: "best-effort" });
			} catch {
				/* best-effort */
			}
			acquired = true;
		} catch {
			// Stale detection: mtime-first (handles crash between mkdir and pidFile).
			try {
				if (Date.now() - fs.statSync(lockDir).mtimeMs > SEQ_LOCK_STALE_MS) {
					fs.rmSync(lockDir, { recursive: true, force: true });
					continue;
				}
			} catch {
				/* dir vanished — let loop retry */
			}
			if (Date.now() - start > SEQ_LOCK_TIMEOUT_MS) {
				throw errors.eventLogLockTimeout(eventsPath, SEQ_LOCK_TIMEOUT_MS);
			}
			sleepSync(SEQ_LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		// PID-guarded release: don't delete a stealer's dir if fn exceeded staleMs.
		try {
			if (fs.readFileSync(pidFile, "utf-8").trim() === String(process.pid)) {
				fs.rmSync(lockDir, { recursive: true, force: true });
			}
		} catch {
			/* lock stolen or already gone — do not touch */
		}
	}
}

async function withSeqLockAsync<T>(eventsPath: string, fn: () => T): Promise<T> {
	// DELIBERATELY delegates to the SYNC acquire — this is NOT a v0.9.26
	// repeat. The v0.9.26 deadlock was the async family AWAITING a lock whose
	// in-process holder needed event-loop iterations (promise-chain family
	// lock) while the sync path sleepSync-spinned. Here the ENTIRE
	// acquire+body+release is one synchronous block with no internal awaits,
	// so within one process (single JS thread) the lock can never be held
	// across an await — in-process sync-vs-async contention is IMPOSSIBLE,
	// and a spin only ever waits on ANOTHER PROCESS (sub-millisecond section,
	// stale-steal at 1s). An earlier draft gave this wrapper its own
	// `await sleep` backoff; that REINTRODUCED starvation: a sync spinner's
	// sleepSync blocked the loop while the in-process async holder's
	// `await`-based release could never run (mailbox-api 30s timeout flake).
	return withSeqLock(eventsPath, fn);
}

/** Monotonic sidecar persist under the .seqlock (L2→L3). Used where a value
 *  is persisted OUTSIDE reservation (e.g. batch lastSeq after the fact) so a
 *  lower explicit seq can never REGRESS the sidecar below values another
 *  process may have already reserved. Writes max(stored, inProcess, seq). */
export function persistSequenceMonotonic(eventsPath: string, seq: number): void {
	withSeqLock(eventsPath, () => {
		const stored = readStoredSequence(eventsPath) ?? 0;
		const inProcess = seqCounters.get(eventsPath) ?? 0;
		const value = Math.max(stored, inProcess, seq);
		if (value !== stored) persistSequence(eventsPath, value);
	});
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
export const seqCounters = new Map<string, number>();
// H6 (2026-08-10): FIFO cap — mirrors appendCounters (APPEND_COUNTER_MAX_ENTRIES = 256)
// and agentEventSeqCache (cap at :434). Without this, a long-lived parent pi process
// that observes many runs (dev sessions with hundreds of background runs over a week)
// accumulates one entry per distinct eventsPath forever. Eviction is safe: the next
// append re-seeds from the `.seq` sidecar via reserveSequenceUnderLock.
const SEQ_COUNTERS_MAX_ENTRIES = 256;

/** Atomically reserve the next sequence number for `eventsPath`.
 *
 *  ST-5 (v0.9.56): previously this seeded the in-process `seqCounters` counter
 *  ONCE per process (reading the `.seq` sidecar a single time via
 *  `nextSequence`) and then served every subsequent call purely from that
 *  process-local counter. Two processes that both seeded before either had
 *  persisted ended up sharing the same counter base -> duplicate sequence
 *  numbers -> `sinceSeq` streaming readers silently dropped the second event.
 *  The async path was already fixed via `reserveSequenceUnderLock` (which
 *  re-reads the sidecar every call); the sync (`appendEvent`) and buffered
 *  (`appendEventBatchInsideLock`) paths were NOT.
 *
 *  Now ALL three append paths share one body: re-read the authoritative `.seq`
 *  sidecar on EVERY call and take `max(sidecar, inProcess)` so a counter that
 *  lags behind a sidecar advanced by another process can never assign a
 *  regressed (duplicate) seq. Every call site already holds a cross-process
 *  file lock (`withEventLogLockSync` for sync/buffered, `withEventLogLockAsync`
 *  for async), so the sidecar re-read is race-free within each lock class.
 *
 *  R16-B1/R17 CORRECTION (Phase 3.6): the claim above — "race-free within
 *  each lock class" — is TRUE but INSUFFICIENT: the sync (.mkdirlock) and
 *  async (.alock) families are DISJOINT cross-process namespaces, so a sync
 *  appender in one process and an async appender in another still both read
 *  sidecar=N and both reserve N+1. Round 17 proved this empirically (527 dup
 *  seq / 75% dup events over 3000 events across 2 processes). reserveSequence
 *  UnderLock now additionally wraps the sidecar read-compute-write in the
 *  shared `.seqlock` (L3) and persists ADVANCE-ON-RESERVE inside it, so no
 *  two processes can ever reserve the same seq regardless of lock family. */
export function reserveSequence(eventsPath: string, count = 1): number {
	return reserveSequenceUnderLock(eventsPath, count);
}

/** Keep the in-process counter monotonic w.r.t. an explicitly-provided seq
 *  (e.g. baseMetadata.seq) so a later auto-assigned seq never collides with it. */
export function advanceSequenceCounter(eventsPath: string, seq: number): void {
	const last = seqCounters.get(eventsPath);
	if (last === undefined || seq > last) {
		seqCounters.set(eventsPath, seq);
		enforceSeqCountersCap();
	}
}

/** H6: FIFO eviction when the seqCounters map exceeds its bounded size. */
function enforceSeqCountersCap(): void {
	if (seqCounters.size > SEQ_COUNTERS_MAX_ENTRIES) {
		const oldest = seqCounters.keys().next().value;
		if (oldest !== undefined) seqCounters.delete(oldest);
	}
}

/** C-01: Reserve sequence INSIDE the cross-process lock. Reads the authoritative
 *  sidecar (.seq file) for the last seq persisted by ANY process, ensuring
 *  cross-process uniqueness. Falls back to scanSequence if no sidecar exists.
 *  The in-process seqCounters is kept monotonic via Math.max for defensive
 *  consistency with any in-process sequencing that hasn't been persisted yet.
 *  R16-B1 (Phase 3.6): the body now runs under the shared `.seqlock` (L3,
 *  acquired L2→L3) and persists the reserved end value inside it
 *  (advance-on-reserve) — see reserveSequenceLocked for the rationale.
 *  `count` lets the buffered batch reserve a contiguous range in one acquire.
 *  Callers on the async family use reserveSequenceUnderLockAsync (same lock
 *  dir, async acquire backoff — never sleepSync on the event loop). */
function reserveSequenceUnderLock(eventsPath: string, count = 1): number {
	return withSeqLock(eventsPath, () => reserveSequenceLocked(eventsPath, count));
}

export async function reserveSequenceUnderLockAsync(eventsPath: string, count = 1): Promise<number> {
	return withSeqLockAsync(eventsPath, () => reserveSequenceLocked(eventsPath, count));
}
