/**
 * Event reconstructor — rebuilds task state from the append-only event log.
 *
 * Primary use-case: crash recovery when tasks.json is corrupted or missing.
 * The materialized tasks.json view is the primary source of truth; this
 * module provides a fallback reconstruction path from events.jsonl.
 *
 * Distilled from pi-autoresearch's append-only event log pattern.
 */
import type { TeamEvent } from "./event-log.ts";
import { readEvents } from "./event-log.ts";

/** Task status values that can be reconstructed from lifecycle events. */
const RECONSTRUCTABLE_STATUSES = new Set([
	"created",
	"queued",
	"running",
	"completed",
	"failed",
	"cancelled",
	"skipped",
	"waiting",
	"needs_attention",
]);

/** Event types that carry task lifecycle state transitions. */
const TASK_LIFECYCLE_EVENT_TYPES = new Set([
	"task.created",
	"task.started",
	"task.completed",
	"task.failed",
	"task.skipped",
	"task.cancelled",
	"task.needs_attention",
	"task.waiting",
	"task.resumed",
	"task.retried",
	"task.blocked",
	"task.progress",
	"task.green",
	"task.red",
]);

/** Terminal events that set finishedAt. */
const TERMINAL_EVENTS = new Set(["task.completed", "task.failed", "task.cancelled", "task.skipped", "task.needs_attention"]);

/** Mapping from event type to the reconstructed task status. */
const EVENT_STATUS_MAP: Readonly<Record<string, string>> = {
	"task.created": "created",
	"task.started": "running",
	"task.completed": "completed",
	"task.failed": "failed",
	"task.skipped": "skipped",
	"task.cancelled": "cancelled",
	"task.needs_attention": "needs_attention",
	"task.waiting": "waiting",
	"task.resumed": "running",
	"task.retried": "queued",
};

/** Task state reconstructed purely from event log entries. */
export interface ReconstructedTaskState {
	/** Task identifier */
	id: string;
	/** Reconstructed status derived from the last lifecycle event */
	status: string;
	/** Timestamp of the task.started event, if observed */
	startedAt?: string;
	/** Timestamp of the terminal event (completed/failed/cancelled/skipped), if observed */
	finishedAt?: string;
	/** Error message from task.failed events */
	error?: string;
	/** Segment number from event data (for retry isolation) */
	segment?: number;
	/** Structured diagnostics from event data */
	diagnostics?: Record<string, unknown>;
	/** Numeric metrics from event data */
	metrics?: Record<string, number>;
}

/** Result of reconstructing task state from events. */
export interface ReconstructionResult {
	/** Map of taskId → reconstructed task state */
	tasks: Map<string, ReconstructedTaskState>;
	/** Total number of events processed */
	eventCount: number;
	/** Number of malformed/unparseable events skipped */
	corruptedCount: number;
}

/** Input: either a file path to read events from, or an in-memory array. */
export type EventSource = string | TeamEvent[];

function isTaskLifecycleEvent(event: TeamEvent): boolean {
	return TASK_LIFECYCLE_EVENT_TYPES.has(event.type);
}

function statusFromEventType(eventType: string): string | undefined {
	return EVENT_STATUS_MAP[eventType];
}

function safeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function safeRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	return value as Record<string, unknown>;
}

function safeNumericRecord(value: unknown): Record<string, number> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return undefined;
	}
	const record: Record<string, number> = {};
	for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
		if (typeof val === "number" && Number.isFinite(val)) {
			record[key] = val;
		}
	}
	if (Object.keys(record).length === 0) {
		return undefined;
	}
	return record;
}

function parseEventLine(line: string): TeamEvent | undefined {
	const trimmed = line.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		if (typeof parsed.type !== "string" || typeof parsed.runId !== "string") return undefined;
		return parsed as TeamEvent;
	} catch {
		return undefined;
	}
}

/**
 * Process a stream of validated TeamEvents into reconstructed task states.
 * Shared logic for both file-based and line-based reconstruction.
 */
function processEvents(events: Iterable<TeamEvent>, eventCount: number, corruptedCount: number): ReconstructionResult {
	const tasks = new Map<string, ReconstructedTaskState>();

	for (const event of events) {
		if (typeof event.taskId !== "string" || event.taskId.length === 0) continue;
		if (!isTaskLifecycleEvent(event)) continue;

		const taskId = event.taskId;
		let task = tasks.get(taskId);
		if (!task) {
			task = { id: taskId, status: "created" };
			tasks.set(taskId, task);
		}

		const newStatus = statusFromEventType(event.type);
		if (newStatus && RECONSTRUCTABLE_STATUSES.has(newStatus)) {
			task.status = newStatus;
		}

		if (event.type === "task.started") {
			task.startedAt = event.time;
		}

		if (TERMINAL_EVENTS.has(event.type)) {
			task.finishedAt = event.time;
		}

		if (event.type === "task.failed" && event.message) {
			task.error = event.message;
		}

		if (event.data) {
			const segment = safeNumber(event.data.segment);
			if (segment !== undefined) task.segment = segment;

			const diagnostics = safeRecord(event.data.diagnostics);
			if (diagnostics !== undefined) task.diagnostics = diagnostics;

			const metrics = safeNumericRecord(event.data.metrics);
			if (metrics !== undefined) task.metrics = metrics;
		}
	}

	return { tasks, eventCount, corruptedCount };
}

/**
 * Reconstruct task states from an append-only event log.
 *
 * @param source - Either a file path to events.jsonl, or an array of TeamEvent objects
 * @returns Reconstruction result with task map, counts
 */
export function reconstructTasksFromEvents(source: EventSource): ReconstructionResult {
	const events: TeamEvent[] = typeof source === "string" ? readEvents(source) : source;
	return processEvents(events, events.length, 0);
}

/**
 * Reconstruct task states from raw JSONL lines (string array).
 * Useful for testing without creating files.
 *
 * @param lines - Array of raw JSONL lines
 * @returns Reconstruction result
 */
export function reconstructTasksFromLines(lines: string[]): ReconstructionResult {
	let eventCount = 0;
	let corruptedCount = 0;
	const parsedEvents: TeamEvent[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const event = parseEventLine(trimmed);
		if (event === undefined) {
			corruptedCount++;
			eventCount++;
			continue;
		}
		parsedEvents.push(event);
		eventCount++;
	}

	return processEvents(parsedEvents, eventCount, corruptedCount);
}
