/**
 * worker-events-channel.ts — bounded worker self-reporting channel
 * (WP-9 / R9, T5).
 *
 * The ONE worker-side primitive for appending self-reported, schema-tagged
 * `worker.*` events to the run's events.jsonl (PI_CREW_EVENTS_PATH —
 * unconditional since WP-9; previously scratchpad-gated, which excluded
 * read-only roles by design and left them with no reporting path).
 *
 * Bounds (a worker must never be able to flood the shared event log):
 * - SCHEMA: event types MUST match /^worker\.[a-z0-9_.-]{1,63}$/ — anything
 *   else is dropped (return false). Worker events never impersonate
 *   orchestrator namespaces (task.*, run.*, spec.*, …).
 * - RATE LIMIT: sliding window, `maxEventsPerWindow` (default 30) per
 *   `windowMs` (default 60s). Dropped events are counted; the next ACCEPTED
 *   event carries `droppedSinceLast` so the operator sees suppression.
 * - FIFO BUFFER CAP: failed appends (throwing writer, e.g. transient EBUSY)
 *   queue for retry; the queue holds at most `bufferCap` (default 64) —
 *   overflow drops the OLDEST pending (FIFO), never grows unboundedly.
 * - CRASH SAFETY: each append is a single O_APPEND write of one JSONL line.
 *   A crash mid-write leaves at most a trailing PARTIAL line — the
 *   orchestrator-side reader (parseJsonlEvents) already skips corrupt lines,
 *   so complete events before/after the partial stay readable (recoverable).
 *
 * Heartbeats remain the liveness corroboration source; worker.* events are
 * informational only — the scheduler never derives liveness from them.
 */

import { appendFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";

export const WORKER_EVENT_TYPE_PATTERN = /^worker\.[a-z0-9_.-]{1,63}$/;

export interface WorkerEventsChannelOptions {
	/** Default: process.env (worker context). */
	env?: NodeJS.ProcessEnv;
	/** Append function — default: appendEventFireAndForget from state. */
	appendEvent?: (eventsPath: string, event: Record<string, unknown>) => void;
	now?: () => number;
	/** Sliding-window rate limit: max accepted events per windowMs. */
	maxEventsPerWindow?: number;
	windowMs?: number;
	/** FIFO cap for queued (failed) appends. */
	bufferCap?: number;
}

export interface WorkerEventsChannel {
	/** Emit a worker.* event. false = dropped (schema/rate/buffer reasons). */
	emit(type: string, data: Record<string, unknown>): boolean;
	/** Retry queued appends (called on the next emit internally). */
	flush(): void;
	/** Test introspection. */
	stats(): { accepted: number; droppedSchema: number; droppedRate: number; droppedBuffer: number; queued: number };
}

export function createWorkerEventsChannel(options: WorkerEventsChannelOptions = {}): WorkerEventsChannel {
	const env = options.env ?? process.env;
	const now = options.now ?? Date.now;
	const appendEvent =
		options.appendEvent ??
		((eventsPath: string, event: Record<string, unknown>) => {
			// Single O_APPEND write of one JSONL line — the crash-safety contract.
			// A previous crash may have left a trailing PARTIAL line (no newline):
			// appending without a separator would fuse both lines into ONE corrupt
			// line, destroying the complete event too. Guard: if the file is
			// non-empty and does not end with \n, prepend the separator (1-byte
			// read of the tail — the partial line stays quarantined on its own line,
			// which the orchestrator reader skips).
			let prefix = "";
			try {
				// PERF (2026-08-24): 1-byte tail read (the comment above always
				// described this; the implementation used to readFileSync the
				// WHOLE file — O(file) reads up to 300x/min per worker for a
				// single byte of information).
				const fd = openSync(eventsPath, "r");
				try {
					const size = fstatSync(fd).size;
					if (size > 0) {
						const tail = Buffer.alloc(1);
						readSync(fd, tail, 0, 1, size - 1);
						if (tail[0] !== 0x0a) prefix = "\n";
					}
				} finally {
					closeSync(fd);
				}
			} catch {
				/* absent file — nothing to separate */
			}
			appendFileSync(eventsPath, `${prefix}${JSON.stringify(event)}\n`, "utf-8");
		});
	const maxPerWindow = options.maxEventsPerWindow ?? 30;
	const windowMs = options.windowMs ?? 60_000;
	const bufferCap = options.bufferCap ?? 64;

	const eventsPath = env.PI_CREW_EVENTS_PATH;
	const runId = env.PI_CREW_BROKER_RUN_ID;
	const taskId = env.PI_CREW_TASK_ID;

	const windowStarts: number[] = [];
	const pending: { type: string; data: Record<string, unknown>; droppedSinceLast: number }[] = [];
	const counters = { accepted: 0, droppedSchema: 0, droppedRate: 0, droppedBuffer: 0 };
	// Dropped-due-to-rate counter surfaced on the next ACCEPTED event (the
	// operator sees suppression without a flood of drop events).
	let suppressedSinceLast = 0;

	const write = (item: { type: string; data: Record<string, unknown>; droppedSinceLast: number }): boolean => {
		try {
			appendEvent(eventsPath as string, {
				type: item.type,
				runId,
				taskId,
				data: item.droppedSinceLast > 0 ? { ...item.data, droppedSinceLast: item.droppedSinceLast } : item.data,
			});
			return true;
		} catch {
			return false;
		}
	};

	const flushInternal = (currentDropped: number): number => {
		let droppedCarry = currentDropped;
		while (pending.length > 0) {
			const item = pending[0]!;
			if (write(item)) {
				pending.shift();
				counters.accepted++;
				droppedCarry = 0;
			} else {
				// Writer still failing — keep the queue (bounded), stop here.
				return droppedCarry;
			}
		}
		return droppedCarry;
	};

	return {
		emit(type: string, data: Record<string, unknown>): boolean {
			if (!eventsPath || !runId) return false; // non-team context — no-op
			if (!WORKER_EVENT_TYPE_PATTERN.test(type)) {
				counters.droppedSchema++;
				return false;
			}
			// Sliding-window rate limit.
			const t = now();
			while (windowStarts.length > 0 && t - windowStarts[0]! >= windowMs) windowStarts.shift();
			if (windowStarts.length >= maxPerWindow) {
				counters.droppedRate++;
				suppressedSinceLast++;
				return false;
			}
			windowStarts.push(t);
			// Drain any queued items first (FIFO — oldest first), then the new one.
			// The new event carries the suppression count (queue drops are already
			// counted on their own accepted re-write).
			if (pending.length > 0) {
				const carry = flushInternal(0);
				if (carry > 0) {
					// Writer failing: queue the new item under the FIFO cap.
					if (pending.length >= bufferCap) {
						pending.shift();
						counters.droppedBuffer++;
					}
					pending.push({ type, data, droppedSinceLast: 0 });
					return true; // accepted (queued)
				}
			}
			if (write({ type, data, droppedSinceLast: suppressedSinceLast })) {
				counters.accepted++;
				suppressedSinceLast = 0;
				return true;
			}
			if (pending.length >= bufferCap) {
				pending.shift();
				counters.droppedBuffer++;
			}
			pending.push({ type, data, droppedSinceLast: suppressedSinceLast });
			suppressedSinceLast = 0;
			return true;
		},
		flush(): void {
			flushInternal(0);
		},
		stats(): { accepted: number; droppedSchema: number; droppedRate: number; droppedBuffer: number; queued: number } {
			return { ...counters, queued: pending.length };
		},
	};
}
