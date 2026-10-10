/**
 * U7 (upgrade spec 2026-10-09, §TIER 2): CommittedStateSource pattern for
 * events.jsonl → views.
 *
 * Borrowed from pi-durable's mount layer: TaskGraph / ConversationView wrap
 * the commit log in a `CommittedStateSource` → `ReplicatedStateSource`
 * (task-graph.ts:83-92, view.ts:104-113). Three properties this adapter
 * mirrors:
 *
 *   1. SNAPSHOT — the initial state is ONE parse of events.jsonl up to the
 *      current seq (a storage scan, O(live records), no event replay — the
 *      point the spec calls "điểm MẠNH").
 *   2. FRAMES — afterwards the source tail-follows the log with the EXISTING
 *      `readEventsCursor` verified-watermark cursor (state/event-log/cursor.ts):
 *      each discovered batch of committed events becomes one frame applied to
 *      the state and fanned out to subscribers. An unchanged log costs one
 *      stat + zero event bytes (the cursor cache serves ring answers).
 *   3. OVERFLOW — durable buffers frames and, when the buffer would exceed
 *      100 frames, replaces the ROOT instead of replaying them
 *      (observation.ts:227-232). Here: a poll that needs MORE than
 *      `maxBufferedFrames` batches to drain the backlog performs ONE root
 *      replacement (fresh snapshot parse) and emits a single `resync` frame.
 *
 * events.jsonl is NEVER written by this module — it is the audit spine; this
 * is a pure derived view layer (spec U7 constraint).
 *
 * DELIBERATE DIVERGENCE from run-snapshot-cache's own events slice: the
 * cursor path only carries events with `metadata.seq` (documented limitation
 * on readEventsCursor), while the cache's tail read keeps seq-less lines too.
 * Consumers that must stay byte-identical to the legacy slice (the snapshot
 * cache parity contract) therefore keep computing that slice themselves and
 * use this source as the CHANGE SIGNAL (frames → refresh), not as the data.
 */
import * as fs from "node:fs";
import type { TeamEvent } from "../state/event-log/event-log.ts";
import { readEventsCursor } from "../state/event-log/event-log.ts";

/** durable observation.ts:227-232 — buffer 100 frames, then root-replace. */
export const MAX_BUFFERED_FRAMES_DEFAULT = 100;
/** Recent-events window kept in the committed state (matches the snapshot
 *  cache's DEFAULT_RECENT_EVENTS so frames carry a comparable tail). */
export const DEFAULT_RECENT_EVENTS_WINDOW = 20;
/** Events per cursor batch = events per frame. Durable commits one frame per
 *  commit; pi-crew's buffered writer commits per batch, so one cursor batch
 *  (default 20 events) is the natural frame unit. */
const FRAME_BATCH_EVENTS_DEFAULT = 20;
/** Registry hard cap — live sources are small but must not grow unbounded. */
const REGISTRY_MAX_LIVE_SOURCES = 64;

export interface EventsStateSnapshot {
	/** Bounded recent-events window (seq-ascending, newest last). */
	events: TeamEvent[];
	/** Last committed seq (0 while the log has no seq-carrying events). */
	seq: number;
	/** Monotonic version — bumped on every commit (frame or resync). */
	version: number;
	/** True when the last commit was a root replacement (resync). */
	resynced: boolean;
}

export interface EventsStateFrame {
	/** Committed seq BEFORE this frame. */
	fromSeq: number;
	/** Committed seq AFTER this frame. */
	toSeq: number;
	/** Delta events of this frame — the FULL new window when `resync`. */
	events: TeamEvent[];
	/** Snapshot version AFTER applying this frame. */
	version: number;
	/** Root-replacement frame (overflow resync): re-read snapshot(). */
	resync: boolean;
}

export type EventsStateListener = (frame: EventsStateFrame) => void;

export interface EventsStateStats {
	/** poll() calls (each = one stat + cursor read when enabled). */
	polls: number;
	/** Frames committed (a resync counts as one frame). */
	frames: number;
	/** Root replacements performed (overflow / inode-shrink / forced). */
	resyncs: number;
	/** Events delivered to listeners across all frames. */
	eventsDelivered: number;
}

export interface EventsStateSourceOptions {
	/** Bounded recent-events window (default 20). */
	recentEvents?: number;
	/** Max frames a single poll will apply before root-replacing (default 100). */
	maxBufferedFrames?: number;
	/** Events per cursor batch / frame (default 20). */
	frameBatchEvents?: number;
}

export interface EventsStateSource {
	readonly runId: string;
	readonly eventsPath: string;
	/** Committed state (defensive copy). */
	snapshot(): EventsStateSnapshot;
	/** Frames are emitted synchronously inside poll()/resync(). */
	subscribe(listener: EventsStateListener): () => void;
	/**
	 * Tail-follow now. Returns the number of frames committed (a resync
	 * counts as one). Cheap on an unchanged log: one stat + a ring-served
	 * cursor read (zero event bytes).
	 */
	poll(): number;
	/** Force a root replacement (fresh snapshot parse + resync frame). */
	resync(): EventsStateSnapshot;
	stats(): EventsStateStats;
	/** Refcount release — the shared registry drops the source at zero refs. */
	dispose(): void;
}

interface SourceInternals {
	poll(): number;
	resync(): EventsStateSnapshot;
}

function createEventsStateSource(runId: string, eventsPath: string, options: EventsStateSourceOptions = {}): EventsStateSource {
	const windowSize = Math.max(1, options.recentEvents ?? DEFAULT_RECENT_EVENTS_WINDOW);
	const maxBufferedFrames = Math.max(1, options.maxBufferedFrames ?? MAX_BUFFERED_FRAMES_DEFAULT);
	const batchEvents = Math.max(1, options.frameBatchEvents ?? FRAME_BATCH_EVENTS_DEFAULT);
	const listeners = new Set<EventsStateListener>();
	let events: TeamEvent[] = [];
	let seq = 0;
	let version = 0;
	let resynced = false;
	let disposed = false;
	let lastSize = -1;
	let lastIno = -1;
	const stats: EventsStateStats = { polls: 0, frames: 0, resyncs: 0, eventsDelivered: 0 };

	function snapshot(): EventsStateSnapshot {
		return { events: [...events], seq, version, resynced };
	}

	function emit(frame: EventsStateFrame): void {
		for (const listener of listeners) {
			try {
				listener(frame);
			} catch {
				/* subscriber errors are non-fatal (run-event-bus convention) */
			}
		}
	}

	/** STORAGE SCAN (spec U7): one parse of the (tail-capped) log to the
	 *  current seq. No event replay — the root is rebuilt from storage. */
	function rootBuild(): void {
		let scanned: TeamEvent[] = [];
		let scannedSeq = 0;
		try {
			const cursor = readEventsCursor(eventsPath, {});
			scanned = cursor.events;
			scannedSeq = cursor.nextSeq;
		} catch {
			/* unreadable/missing log — keep the empty root */
		}
		// Stamp the inode/size the root was built from so the FIRST poll after
		// an external rewrite (rotation/compaction) already triggers a resync
		// instead of learning the inode one poll late.
		try {
			const stat = fs.statSync(eventsPath);
			lastIno = stat.ino;
			lastSize = stat.size;
		} catch {
			lastIno = -1;
			lastSize = -1;
		}
		events = scanned.slice(-windowSize);
		seq = scannedSeq;
		resynced = true;
		version += 1;
	}

	function resync(): EventsStateSnapshot {
		const fromSeq = seq;
		rootBuild();
		stats.resyncs += 1;
		stats.frames += 1;
		const frame: EventsStateFrame = { fromSeq, toSeq: seq, events: [...events], version, resync: true };
		stats.eventsDelivered += frame.events.length;
		emit(frame);
		return snapshot();
	}

	function poll(): number {
		if (disposed) return 0;
		stats.polls += 1;
		// Root-replacement triggers BESIDES the frame-buffer overflow: an
		// inode change or size shrink means the log was rewritten (rotation's
		// rename+'wx' create, compaction's temp+rename, forget+import) — the
		// committed window is no longer a suffix of the new file, so replay
		// from the seq cursor alone would strand pre-rewrite events.
		try {
			const stat = fs.statSync(eventsPath);
			if (lastIno !== -1 && (stat.ino !== lastIno || stat.size < lastSize)) {
				lastIno = stat.ino;
				lastSize = stat.size;
				resync();
				return 1;
			}
			lastIno = stat.ino;
			lastSize = stat.size;
		} catch {
			// File gone (run dir moving / not created yet): keep the last
			// committed state — the audit spine may reappear.
			return 0;
		}
		let committed = 0;
		for (;;) {
			const cursor = readEventsCursor(eventsPath, { sinceSeq: seq, limit: batchEvents });
			if (cursor.events.length === 0) break;
			const toSeq = Math.max(seq, cursor.nextSeq);
			if (toSeq <= seq) break; // no forward progress — stop (loop guard)
			const frameEvents = cursor.events;
			const fromSeq = seq;
			seq = toSeq;
			events = [...events, ...frameEvents].slice(-windowSize);
			resynced = false;
			version += 1;
			committed += 1;
			stats.frames += 1;
			stats.eventsDelivered += frameEvents.length;
			emit({ fromSeq, toSeq, events: [...frameEvents], version, resync: false });
			if (committed >= maxBufferedFrames) {
				// OVERFLOW (durable :227-232): only root-replace when a backlog
				// still remains — an exact drain at the cap needs no resync.
				let backlog = false;
				try {
					backlog = readEventsCursor(eventsPath, { sinceSeq: seq, limit: 1 }).events.length > 0;
				} catch {
					backlog = false;
				}
				if (backlog) {
					resync();
					return committed + 1;
				}
				break;
			}
		}
		return committed;
	}

	// Initial snapshot: parse events.jsonl to the current seq at creation.
	rootBuild();

	const source: EventsStateSource & SourceInternals = {
		runId,
		eventsPath,
		snapshot,
		subscribe(listener: EventsStateListener): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		poll,
		resync,
		stats(): EventsStateStats {
			return { ...stats };
		},
		dispose(): void {
			if (disposed) return;
			// Refcount release (spec: sources are SHARED per events log — widget +
			// surface panes tail-follow ONE cursor). While other holders remain,
			// only drop this holder's reference; the instance keeps serving them.
			const entry = registry.get(eventsPath);
			if (entry && entry.source === source && entry.refs > 1) {
				entry.refs -= 1;
				return;
			}
			disposed = true;
			listeners.clear();
			if (entry && entry.source === source) registry.delete(eventsPath);
		},
	};
	return source;
}

// ─── Shared registry (get-or-create per events log) ────────────────────────

interface RegistryEntry {
	source: EventsStateSource;
	refs: number;
}

const registry = new Map<string, RegistryEntry>();

/**
 * U7 adapter entry point: get-or-create the shared CommittedStateSource for
 * one run's events.jsonl. Repeated calls with the same eventsPath return the
 * SAME instance (refcounted) so widget + surface panes share one tail-follow
 * cursor; dispose() each handle you take.
 */
export function eventsStateSource(runId: string, eventsPath: string, options: EventsStateSourceOptions = {}): EventsStateSource {
	const existing = registry.get(eventsPath);
	if (existing) {
		existing.refs += 1;
		return existing.source;
	}
	// Hard cap: live sources are tiny, but a pathological session (hundreds
	// of short-lived runs) must not accumulate. Evict the oldest-registered
	// entry wholesale; its holders keep a disposed no-op source and the next
	// eventsStateSource() call for that path creates a fresh one.
	if (registry.size >= REGISTRY_MAX_LIVE_SOURCES) {
		const oldestKey = registry.keys().next().value;
		if (oldestKey !== undefined) {
			const evicted = registry.get(oldestKey);
			registry.delete(oldestKey);
			evicted?.source.dispose();
		}
	}
	const source = createEventsStateSource(runId, eventsPath, options);
	registry.set(eventsPath, { source, refs: 1 });
	return source;
}

/** Test/observability hook: number of live (refcounted) sources. */
export function eventsStateSourceRegistrySize(): number {
	return registry.size;
}
