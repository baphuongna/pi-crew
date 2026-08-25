import * as fs from "node:fs";
import * as path from "node:path";
import { type IncrementalReadState, readJsonlSince, readJsonlTail } from "../../utils/incremental-reader.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import type { TeamEvent } from "./event-log.ts";
import { currentGeneration } from "./event-log-rotation.ts";

// --- R18 / R16-B1 effect 2 (Phase 3.6): archive-tail readers ----------------
// Rotation stranding: a sync append that was mid-appendFileSync holding an fd
// on the RENAMED inode (ST-8 rename+create) lands in the archive file, not the
// live file. Round 18 measured 5.43% stranded events under max-contention
// zero-lock repro. Previously readers saw ONLY the live file, so stranded
// events were invisible — and sweepOldArchives unlinked them after 7 days
// (gone forever). Fix (Round 18 option (a)): mirror the mailbox
// safeReadMailboxFile archive-walk — readers also drain archive TAILS,
// deduped by seq, merged ahead of the live file's events.

/** List `<eventsPath>.<ts>.archive.jsonl` siblings (matches rotateEventLogUnlocked's
 *  naming), sorted by name (timestamp) so older generations come first. */
function listEventArchivePaths(eventsPath: string): string[] {
	const dir = path.dirname(eventsPath);
	const base = path.basename(eventsPath);
	try {
		return fs
			.readdirSync(dir)
			.filter((entry) => entry.startsWith(`${base}.`) && entry.endsWith(".archive.jsonl"))
			.sort()
			.map((entry) => path.join(dir, entry));
	} catch {
		// Directory missing — nothing to read.
		return [];
	}
}

/** Parse a JSONL file into TeamEvents, skipping corrupt/blank lines (mirrors
 *  the legacy readEvents parser). Returns [] when the file is unreadable. */
function parseJsonlEvents(filePath: string): TeamEvent[] {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const events: TeamEvent[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			events.push(JSON.parse(trimmed) as TeamEvent);
		} catch {
			/* skip corrupt lines */
		}
	}
	return events;
}

const ARCHIVE_TAIL_BYTES = 4 * 1024 * 1024; // 4 MB — mirrors readEventsCursor's TAIL_BYTES

/** Drain archive TAILS: events with seq > sinceSeq from every archive of
 *  eventsPath, deduped by seq, sorted by seq. Stranded in-flight-fd appends
 *  land at the END of the archive (the renamed pre-rotation inode), so a
 *  bounded tail read per archive is sufficient and keeps this O(tail bytes). */
function readArchiveTailEvents(eventsPath: string, sinceSeq: number): TeamEvent[] {
	const archives = listEventArchivePaths(eventsPath);
	if (archives.length === 0) return [];
	const bySeq = new Map<number, TeamEvent>();
	for (const archivePath of archives) {
		const tail = readJsonlTail<TeamEvent>(archivePath, ARCHIVE_TAIL_BYTES);
		for (const event of tail.items) {
			const seq = event.metadata?.seq;
			if (typeof seq !== "number" || seq <= sinceSeq) continue;
			if (!bySeq.has(seq)) bySeq.set(seq, event);
		}
	}
	return [...bySeq.values()].sort((a, b) => (a.metadata?.seq ?? 0) - (b.metadata?.seq ?? 0));
}

/** Merge drained archive-tail events with live-file events: dedup by seq
 *  (live wins on collision — it is the persisted survivor), seq-sorted. */
function mergeArchiveTailEvents(archiveEvents: TeamEvent[], liveEvents: TeamEvent[]): TeamEvent[] {
	if (archiveEvents.length === 0) return liveEvents;
	const bySeq = new Map<number, TeamEvent>();
	for (const event of archiveEvents) bySeq.set(event.metadata?.seq ?? 0, event);
	for (const event of liveEvents) bySeq.set(event.metadata?.seq ?? 0, event);
	return [...bySeq.values()].sort((a, b) => (a.metadata?.seq ?? 0) - (b.metadata?.seq ?? 0));
}

export function readEvents(eventsPath: string): TeamEvent[] {
	// R18 / R16-B1 effect 2 (Phase 3.6): FULL-HISTORY semantics — merge every
	// archive (pre-rotation generations, including stranded in-flight appends)
	// with the live file, dedup by seq, ordered by seq. Callers needing the
	// full history (team-runner recovery, run-export, inspect, read, and the
	// event-reconstructor, whose only read entry is this function) now see
	// archived events too — this is the intended fix for "no event stranded".
	const archives = listEventArchivePaths(eventsPath);
	const events: TeamEvent[] = [];
	const seenSeqs = new Set<number>();
	const push = (event: TeamEvent): void => {
		const seq = event.metadata?.seq;
		if (typeof seq === "number" && seq > 0) {
			if (seenSeqs.has(seq)) return;
			seenSeqs.add(seq);
		}
		events.push(event);
	};
	for (const archivePath of archives) {
		for (const event of parseJsonlEvents(archivePath)) push(event);
	}
	if (fs.existsSync(eventsPath)) {
		for (const event of parseJsonlEvents(eventsPath)) push(event);
	}
	return events.sort((a, b) => (a.metadata?.seq ?? 0) - (b.metadata?.seq ?? 0));
}

export interface EventCursorOptions {
	sinceSeq?: number;
	limit?: number;
	fromByteOffset?: number;
	/** R-03: generation the caller captured on its previous read. When set, a
	 * mismatch with the live generation signals the file was rotated/truncated
	 * and the byte offset is stale — the cursor resets to 0 so the new file is
	 * re-read from its start instead of missing post-rotation events. */
	generation?: number;
}

export interface EventCursorResult {
	events: TeamEvent[];
	nextSeq: number;
	total: number;
	nextByteOffset?: number;
	/** R-03: live generation of the events file at read time. Callers doing
	 * streaming byte-offset reads should echo this back as `generation` on the
	 * next call so rotation is detected and the cursor resets. */
	generation?: number;
}

function positiveInteger(value: number | undefined): number | undefined {
	return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// --- Perf round 2 / Task 6 (fix round 1): VERIFIED watermark tail cache -------
//
// The first cut of this task scaled the tail window down with `limit` and
// accepted it whenever the window's first parsed seq <= sinceSeq — assuming
// file order == seq order. That assumption is FALSE:
//   (1) compaction recovery re-appends lost events at the END of the file
//       with their OLD seqs (event-log-rotation.ts applyCompaction);
//   (2) the sync (.mkdirlock) and async (.alok) lock families are disjoint,
//       so interleaved writers can append reserved seqs out of order;
//   (3) explicit baseMetadata.seq appends bypass reservation ordering.
// A file can therefore look like [1..200, 5000, 201..1700], and the window
// acceptance silently dropped event 5000 forever.
//
// This fix keeps NO order assumption. Instead each events path carries a
// cache entry with a VERIFIED watermark (transcript-cache.ts pattern):
//   verifiedOffset  byte offset just past the last VERIFIED complete line
//                  (a partial trailing line is held back, not consumed)
//   lastSeq         seq of the last event at verifiedOffset
//   ring            bounded, file-ordered suffix of the verified events
// The watermark is ESTABLISHED only by a full parse from offset 0 in which
// every parsed event carries a finite seq and seqs are non-decreasing, and
// EXTENDED only by deltas whose first seq >= lastSeq and whose seqs are
// non-decreasing. Any violation — out-of-order append, seq-less line, file
// shrink, stamp mismatch, short delta read — rebuilds from a fresh full
// parse. With the watermark held, answering from the ring is sound:
//   - verified && ringStartSeq <= sinceSeq: every event BEFORE the ring
//     start lies inside the verified range, where seqs are non-decreasing,
//     so its seq <= ringStartSeq <= sinceSeq — the sinceSeq filter would
//     drop it in a full read too. The ring's post-filter set IS the full
//     read's post-filter set, so TAIL_EVENT_CAP slice, archive-tail merge
//     (R18/R16-B1), dedupe+sort, total/nextSeq are all identical.
//   - ringStartOffset === 0: the ring IS the whole file (nothing dropped).
// An UNVERIFIED lineage (an out-of-order file, e.g. after compaction
// recovery) may only answer via ringStartOffset === 0; anything else takes
// the full parse. Files larger than the wide 4MB window can return a strict
// SUPERSET of the old byte-window answer (older post-sinceSeq events the
// window used to drop) — never fewer events.

const TAIL_BYTES = 4 * 1024 * 1024; // FIND-05: 4 MB wide tail window
const TAIL_EVENT_CAP = 5000;
const CURSOR_READ_CHUNK_BYTES = 64 * 1024;
const CURSOR_TAIL_CACHE_MAX_ENTRIES = 100;

/** One parsed event plus the absolute byte offset of its line's start. */
interface CursorLineEvent {
	event: TeamEvent;
	startOffset: number;
}

interface CursorTailCacheEntry {
	/** Stamp pair from the last update; any mismatch forces a rebuild. */
	size: number;
	mtimeMs: number;
	verifiedOffset: number;
	lastSeq: number;
	/** True only while every consumed line since offset 0 carried a finite,
	 *  non-decreasing seq. False => the ring may answer only from offset 0. */
	verified: boolean;
	ring: CursorLineEvent[];
}

const cursorTailCache = new Map<string, CursorTailCacheEntry>();

/** Drop events from the ring's front (file order) past `bound`, keeping the
 *  newest suffix. Ring bound: max(TAIL_EVENT_CAP, limit) * 2 events — enough
 *  lookback behind the anchor for the provability check while bounding
 *  memory (the answer itself is capped to TAIL_EVENT_CAP events regardless,
 *  so a larger ring only widens provability, it never changes results). */
function evictCursorRing(ring: CursorLineEvent[], bound: number): CursorLineEvent[] {
	return ring.length > bound ? ring.slice(ring.length - bound) : ring;
}

/** Parse COMPLETE lines out of `buf`, which starts at absolute `baseOffset`
 *  (itself a line boundary). A trailing fragment without "\n" is held back
 *  (mid-append partial line). Corrupt/blank lines advance the verified
 *  offset but yield no event. `minSeq` seeds the watermark check: `ok` is
 *  false when any parsed event lacks a finite seq or goes backwards — i.e.
 *  the non-decreasing watermark is broken and the caller must rebuild.
 *  Parsed events are returned regardless (a full-parse answer must keep
 *  them, mirroring the wide reader). */
function scanEventLines(
	buf: Buffer,
	baseOffset: number,
	minSeq: number | undefined,
): { lines: CursorLineEvent[]; verifiedBytes: number; ok: boolean } {
	const lines: CursorLineEvent[] = [];
	let ok = true;
	let lastSeq = minSeq;
	let pos = 0;
	for (;;) {
		const newline = buf.indexOf(0x0a, pos);
		if (newline < 0) break;
		const text = buf.toString("utf-8", pos, newline).trim();
		if (text) {
			try {
				const event = JSON.parse(text) as TeamEvent;
				const seq = event.metadata?.seq;
				if (typeof seq !== "number" || !Number.isFinite(seq) || (lastSeq !== undefined && seq < lastSeq)) {
					ok = false;
				} else {
					lastSeq = seq;
				}
				lines.push({ event, startOffset: baseOffset + pos });
			} catch {
				/* corrupt line — skipped, but its bytes still advance */
			}
		}
		pos = newline + 1;
	}
	return { lines, verifiedBytes: pos, ok };
}

/** Read exactly [start, end) from an already-open fd, or return null on any
 *  short read (concurrent shrink/rotation) so the caller rebuilds from a
 *  full parse. Reading from the caller's fd keeps the stat and the read on
 *  the SAME inode. */
function readCursorByteRange(fd: number, start: number, end: number): Buffer | null {
	if (end <= start) return Buffer.alloc(0);
	const length = end - start;
	const buf = Buffer.alloc(length);
	let totalRead = 0;
	while (totalRead < length) {
		const chunk = Math.min(CURSOR_READ_CHUNK_BYTES, length - totalRead);
		const n = fs.readSync(fd, buf, totalRead, chunk, start + totalRead);
		if (n <= 0) return null;
		totalRead += n;
	}
	return buf;
}

/** Full parse from offset 0 — the only way to ESTABLISH the watermark, and
 *  the answer basis when the ring cannot prove coverage (total coverage by
 *  construction). Returns undefined when the file cannot be read (the caller
 *  falls back to the wide window). O_NOFOLLOW matches readJsonlTail's
 *  symlink refusal. */
function rebuildCursorTailCache(eventsPath: string, bound: number): { entry: CursorTailCacheEntry; lines: CursorLineEvent[] } | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(eventsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	} catch {
		return undefined;
	}
	try {
		const stat = fs.fstatSync(fd);
		const buf = readCursorByteRange(fd, 0, stat.size);
		if (buf === null) return undefined;
		const scan = scanEventLines(buf, 0, undefined);
		const lastLine = scan.lines.at(-1)?.event.metadata?.seq;
		const entry: CursorTailCacheEntry = {
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			verifiedOffset: scan.verifiedBytes,
			lastSeq: typeof lastLine === "number" ? lastLine : 0,
			verified: scan.ok,
			ring: evictCursorRing(scan.lines, bound),
		};
		return { entry, lines: scan.lines };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			/* ignore */
		}
	}
}

/** Shared answer pipeline (identical to the wide path's): TAIL_EVENT_CAP
 *  slice (+ its warning) BEFORE the sinceSeq filter, then the R18/R16-B1
 *  archive-tail merge, then the head-cap limit, then total/nextSeq. */
function cursorResultFromEvents(all: TeamEvent[], eventsPath: string, sinceSeq: number, limit: number | undefined): EventCursorResult {
	let capped = all;
	if (capped.length > TAIL_EVENT_CAP) {
		logInternalError(
			"event-log.cursor-full-read",
			new Error(`readEventsCursor tail read dropped events from a larger log; pass fromByteOffset for incremental reads`),
			`eventsPath=${eventsPath}`,
		);
		capped = capped.slice(-TAIL_EVENT_CAP);
	}
	const filtered = capped.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
	// R18 (Phase 3.6): rotation stranding — prepend archive-tail events (seq >
	// sinceSeq, deduped, seq-sorted) ahead of the live tail slice, so events
	// stranded into an archive by a rotation are still delivered to sinceSeq
	// streaming consumers. No-rotation case: no archives exist → behavior is
	// byte-identical to before (mergeArchiveTailEvents returns liveEvents).
	const merged = mergeArchiveTailEvents(readArchiveTailEvents(eventsPath, sinceSeq), filtered);
	const events = limit !== undefined ? merged.slice(0, limit) : merged;
	const returnedMaxSeq = events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq);
	return { events, nextSeq: returnedMaxSeq, total: merged.length };
}

/** Can `ring` (under `entry`'s lineage) answer a read anchored at sinceSeq?
 *  Sound per the watermark docblock: either the ring starts at the verified
 *  seq watermark that sinceSeq has already passed, or the ring starts at
 *  offset 0 and is the whole file. */
function cursorRingProvable(entry: CursorTailCacheEntry, ring: CursorLineEvent[], sinceSeq: number): boolean {
	if (ring.length === 0) {
		return entry.verifiedOffset === 0 || (entry.verified && entry.lastSeq <= sinceSeq);
	}
	const start = ring[0];
	return start.startOffset === 0 || (entry.verified && (start.event.metadata?.seq ?? 0) <= sinceSeq);
}

/** Perf round 2 / Task 6 (fix round 1): serve a sinceSeq+limit cursor read
 *  from the verified watermark cache. `sinceSeq > 0` gating keeps
 *  replay-from-zero calls on the wide path (seqs start at 1, so a sinceSeq=0
 *  anchor can never be proven passed by a watermark — every call would pay
 *  the full parse for nothing). Returns undefined when the file cannot be
 *  stat'd/read; the caller then runs the FIND-05 wide path unchanged. */
function readEventsCursorTailCached(eventsPath: string, sinceSeq: number, limit: number): EventCursorResult | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(eventsPath);
	} catch {
		return undefined;
	}
	const previous = cursorTailCache.get(eventsPath);
	const bound = Math.max(TAIL_EVENT_CAP, limit) * 2;

	if (previous && stat.size === previous.size && stat.mtimeMs === previous.mtimeMs) {
		// Unchanged stamps: serve purely from the ring (no event bytes read).
		const ring = evictCursorRing(previous.ring, bound);
		if (cursorRingProvable(previous, ring, sinceSeq)) {
			if (ring !== previous.ring) cursorTailCache.set(eventsPath, { ...previous, ring });
			return cursorResultFromEvents(
				ring.map((line) => line.event),
				eventsPath,
				sinceSeq,
				limit,
			);
		}
	} else if (previous && stat.size > previous.size && stat.mtimeMs >= previous.mtimeMs && previous.verifiedOffset < stat.size) {
		// Append-only growth: read only [verifiedOffset, size). Provability is
		// checked BEFORE the read — appending only moves the ring start
		// forward, so an unprovable ring can never become provable here.
		const preRing = evictCursorRing(previous.ring, bound);
		if (cursorRingProvable(previous, preRing, sinceSeq)) {
			let delta: Buffer | null = null;
			let deltaFd: number | undefined;
			try {
				deltaFd = fs.openSync(eventsPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
				delta = readCursorByteRange(deltaFd, previous.verifiedOffset, stat.size);
			} catch {
				delta = null;
			} finally {
				if (deltaFd !== undefined) {
					try {
						fs.closeSync(deltaFd);
					} catch {
						/* ignore */
					}
				}
			}
			if (delta !== null) {
				const scan = scanEventLines(delta, previous.verifiedOffset, previous.lastSeq);
				if (scan.ok) {
					const ring = evictCursorRing([...preRing, ...scan.lines], bound);
					const lastLineSeq = scan.lines.at(-1)?.event.metadata?.seq;
					const entry: CursorTailCacheEntry = {
						size: stat.size,
						mtimeMs: stat.mtimeMs,
						verifiedOffset: previous.verifiedOffset + scan.verifiedBytes,
						lastSeq: typeof lastLineSeq === "number" ? lastLineSeq : previous.lastSeq,
						// The delta verified against the watermark, but a
						// violation earlier in the file keeps the lineage
						// unverified (it can only answer from offset 0).
						verified: previous.verified,
						ring,
					};
					cursorTailCache.set(eventsPath, entry);
					if (cursorRingProvable(entry, ring, sinceSeq)) {
						return cursorResultFromEvents(
							ring.map((line) => line.event),
							eventsPath,
							sinceSeq,
							limit,
						);
					}
				}
			}
		}
	}

	// Full parse: cache miss, stamp mismatch/shrink, watermark violation, or
	// an anchor older than the ring's provable start. Re-establishes the
	// watermark and answers with TOTAL coverage (exact full-read semantics
	// for files within the wide window; a superset — never fewer — beyond).
	const rebuilt = rebuildCursorTailCache(eventsPath, bound);
	if (rebuilt === undefined) return undefined;
	cursorTailCache.set(eventsPath, rebuilt.entry);
	// FIND-12 pattern: evict the oldest entry by Map insertion order.
	if (cursorTailCache.size > CURSOR_TAIL_CACHE_MAX_ENTRIES) {
		const oldestKey = cursorTailCache.keys().next().value;
		if (oldestKey !== undefined) cursorTailCache.delete(oldestKey);
	}
	return cursorResultFromEvents(
		rebuilt.lines.map((line) => line.event),
		eventsPath,
		sinceSeq,
		limit,
	);
}

/** Test/invalidation hook: drop the verified watermark cache for one events
 *  path (or every path when omitted). */
export function clearEventsCursorTailCache(eventsPath?: string): void {
	if (!eventsPath) {
		cursorTailCache.clear();
		return;
	}
	cursorTailCache.delete(eventsPath);
}

export function readEventsCursor(eventsPath: string, options: EventCursorOptions = {}): EventCursorResult {
	// Incremental byte-offset path: read only new bytes since last known offset
	if (options.fromByteOffset !== undefined) {
		// R-03: detect file rotation/truncation via the generation sidecar BEFORE
		// reusing the byte offset. If the file was rotated since the caller last
		// read, it was truncated to empty (pre-rotation content archived to
		// `<eventsPath>.<ts>.archive.jsonl`) and is growing again from 0 — the
		// caller's offset now points past EOF, so post-rotation events would be
		// silently missed. Reset to offset 0 to re-read the current file from its
		// start.
		// R18 (Phase 3.6): re-reading from 0 re-delivers no previously-returned
		// events FROM THE LIVE FILE — but events STRANDED into the archive by the
		// rotation (in-flight fd appends on the renamed inode) were never
		// delivered and, before this fix, were lost forever once sweepOldArchives
		// unlinked them. On a detected generation bump we therefore FIRST drain
		// the previous generations' archive TAILS (events with seq > sinceSeq,
		// deduped by seq — mailbox safeReadMailboxFile archive-walk pattern)
		// ahead of the fresh live file's events.
		const liveGen = currentGeneration(eventsPath);
		const staleCursor = options.generation !== undefined && options.generation !== liveGen;
		const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
		const archiveEvents = staleCursor ? readArchiveTailEvents(eventsPath, sinceSeq) : [];
		const byteOffset = staleCursor ? 0 : (positiveInteger(options.fromByteOffset) ?? 0);
		const initialState: IncrementalReadState = { byteOffset, lineCount: 0 };
		const { items, state: newState, eof } = readJsonlSince<TeamEvent>(eventsPath, initialState);
		const filtered = items.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
		const merged = mergeArchiveTailEvents(archiveEvents, filtered);
		const limit = positiveInteger(options.limit);
		const events = limit !== undefined ? merged.slice(0, limit) : merged;
		const returnedMaxSeq = events.reduce((max, event) => Math.max(max, event.metadata?.seq ?? 0), sinceSeq);
		return {
			events,
			nextSeq: returnedMaxSeq,
			total: merged.length,
			nextByteOffset: newState.byteOffset,
			generation: liveGen,
		};
	}

	// FIND-05 default path: byte-level tail read (last 4MB) instead of
	// full-file read. Bounds CPU to O(tail bytes) instead of O(total
	// events). The legacy readEvents() full parse path is preserved for
	// callers that explicitly need the full history (e.g. tests that
	// assert exact contents) and as a small-file fallback.
	//
	// The 5000-event tail cap and the "event-log.cursor-full-read"
	// warning are preserved. A separate cursor-tail-truncated warning is
	// emitted whenever the file exceeds the 4MB tail budget, signalling
	// that a prefix was dropped and callers should pass fromByteOffset for
	// streaming reads.
	const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
	const limit = positiveInteger(options.limit);
	// Perf round 2 / Task 6 (fix round 1): streaming ticks anchored with
	// sinceSeq and capped with limit (run-event-bus onWithReplay, broker
	// events.since/events.subscribe resync) are served by the verified
	// watermark cache — delta-only reads for append growth, zero event-byte
	// reads when nothing changed, and a full-parse rebuild on any watermark
	// violation, shrink, or stale anchor. Warning suppression there is
	// backed by proof, not by an order assumption: a ring answer happens
	// only when no post-sinceSeq event can have been dropped. sinceSeq=0 /
	// no-limit calls keep this wide path unchanged.
	if (limit !== undefined && sinceSeq > 0) {
		const cached = readEventsCursorTailCached(eventsPath, sinceSeq, limit);
		if (cached !== undefined) return cached;
	}
	const tail = readJsonlTail<TeamEvent>(eventsPath, TAIL_BYTES);
	if (tail.truncated) {
		logInternalError("event-log.cursor-tail-truncated", {
			eventsPath,
			returned: tail.items.length,
			tailBytes: TAIL_BYTES,
		});
	}
	return cursorResultFromEvents(tail.items, eventsPath, sinceSeq, limit);
}
