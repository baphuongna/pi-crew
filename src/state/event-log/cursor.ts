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

/** Perf round 2 / Task 6: acceptance check for the bounded (limit-scaled) tail
 *  window. The events file is append-only with non-decreasing metadata.seq
 *  (the same invariant the seq-dedupe, the cross-process seq sync, and the
 *  archive-tail readers rely on), so every event located BEFORE the window
 *  start has seq <= the first parsed seq inside the window. When that first
 *  seq is <= sinceSeq, no observable event (seq > sinceSeq) can exist before
 *  the window: the window's post-filter set is EXACTLY the wide (4MB) read's
 *  post-filter set, so every downstream step — TAIL_EVENT_CAP slice, sinceSeq
 *  filter, archive-tail merge, dedupe+sort, total/nextSeq — is identical to
 *  the wide path. A window that cannot prove this (unparseable or seq-less
 *  first line, empty window, first seq > sinceSeq) conservatively rejects and
 *  the caller falls back to the wide read. */
function boundedTailCoversSinceSeq(tail: { truncated: boolean; items: TeamEvent[] }, sinceSeq: number): boolean {
	if (!tail.truncated) return true; // window already covered the whole file
	const firstSeq = tail.items[0]?.metadata?.seq;
	return typeof firstSeq === "number" && Number.isFinite(firstSeq) && firstSeq <= sinceSeq;
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
	const TAIL_BYTES = 4 * 1024 * 1024; // 4 MB
	const TAIL_EVENT_CAP = 5000;
	// Perf round 2 / Task 6: bounded-tail fast path. When the caller anchors a
	// streaming read with sinceSeq AND caps it with limit (run-event-bus
	// onWithReplay, broker events.since/events.subscribe resync), a small
	// limit-scaled window is enough: everything the wide read would filter out
	// (seq <= sinceSeq) does not need to be read or parsed at all. The window
	// is accepted only when it provably contains the entire post-sinceSeq
	// region (boundedTailCoversSinceSeq); otherwise we re-read with the full
	// 4MB window and the result is byte-identical to the previous behavior.
	// `sinceSeq > 0` is required or the first window seq could never prove
	// coverage (seqs start at 1) and every call would pay the double read.
	const TAIL_LOOKBACK_MIN_BYTES = 256 * 1024; // floor: ~1k events of lookback behind the anchor
	const TAIL_LOOKBACK_BYTES_PER_EVENT = 512; // headroom for message-bearing events
	const sinceSeq = positiveInteger(options.sinceSeq) ?? 0;
	const limit = positiveInteger(options.limit);
	const bounded = limit !== undefined && sinceSeq > 0;
	const boundedBytes = bounded
		? Math.min(TAIL_BYTES, Math.max(TAIL_LOOKBACK_MIN_BYTES, limit * TAIL_LOOKBACK_BYTES_PER_EVENT))
		: TAIL_BYTES;

	let tail = readJsonlTail<TeamEvent>(eventsPath, boundedBytes);
	let usedBoundedTail = false;
	if (bounded && boundedBytes < TAIL_BYTES) {
		if (boundedTailCoversSinceSeq(tail, sinceSeq)) usedBoundedTail = true;
		else tail = readJsonlTail<TeamEvent>(eventsPath, TAIL_BYTES);
	}
	let all = tail.items;
	// The bounded window's dropped prefix provably contains no post-sinceSeq
	// events, so the truncation warning would be a false alarm (and per-tick
	// spam for streaming callers) — only the wide read reports truncation.
	if (tail.truncated && !usedBoundedTail) {
		logInternalError("event-log.cursor-tail-truncated", {
			eventsPath,
			returned: all.length,
			tailBytes: TAIL_BYTES,
		});
	}
	if (all.length > TAIL_EVENT_CAP) {
		logInternalError(
			"event-log.cursor-full-read",
			new Error(`readEventsCursor tail read dropped events from a larger log; pass fromByteOffset for incremental reads`),
			`eventsPath=${eventsPath}`,
		);
		all = all.slice(-TAIL_EVENT_CAP);
	}
	const filtered = all.filter((event) => (event.metadata?.seq ?? 0) > sinceSeq);
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
