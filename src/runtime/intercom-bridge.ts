/**
 * Intercom bridge — workers can escalate questions to the orchestrator.
 *
 * Pattern origin: pi-subagents/src/intercom-bridge.ts — contact_supervisor tool
 * for child agents to escalate decisions, report progress, or ask questions.
 *
 * This module provides the message queue and correlation logic.
 * The actual tool registration happens in task-runner.ts.
 */

import { logInternalError } from "../utils/internal-error.ts";

// ── Types ────────────────────────────────────────────────────────────────

export type IntercomUrgency = "low" | "medium" | "high" | "critical";
export type IntercomType = "question" | "escalation" | "progress" | "block";

export interface IntercomMessage {
	type: IntercomType;
	taskStepId: string;
	content: string;
	urgency: IntercomUrgency;
	timestamp: number;
	timeout?: number; // ms to wait for response
}

export interface IntercomResponse {
	answer: string;
	source: "orchestrator" | "human" | "timeout";
	timestamp: number;
	messageId: string;
}

// ── Message Queue ────────────────────────────────────────────────────────

interface PendingMessage {
	message: IntercomMessage;
	id: string;
	resolve: (response: IntercomResponse) => void;
	timer?: ReturnType<typeof setTimeout>;
}

const MAX_QUEUE_SIZE = 100;

/**
 * In-process intercom queue for worker→orchestrator communication.
 *
 * Each message gets a unique ID. Callers await a response via a Promise.
 * If no response arrives within the timeout, resolves with source="timeout".
 */
export class IntercomQueue {
	private pending = new Map<string, PendingMessage>();
	private queue: IntercomMessage[] = [];

	/**
	 * Enqueue a message and return a promise that resolves when the
	 * orchestrator responds (or times out).
	 */
	enqueue(message: IntercomMessage): Promise<IntercomResponse> {
		if (this.pending.size >= MAX_QUEUE_SIZE) {
			// Evict oldest
			const firstKey = this.pending.keys().next().value;
			if (firstKey) this.evict(firstKey, "queue_full");
		}

		const id = `icm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

		return new Promise<IntercomResponse>((resolve) => {
			const entry: PendingMessage = { message, id, resolve };

			// Set timeout if specified
			if (message.timeout && message.timeout > 0) {
				entry.timer = setTimeout(() => {
					resolve({
						answer: "No response received within timeout",
						source: "timeout",
						timestamp: Date.now(),
						messageId: id,
					});
					this.pending.delete(id);
				}, message.timeout);
			}

			this.pending.set(id, entry);
			this.queue.push({ ...message });
		});
	}

	/**
	 * Respond to a pending message by ID.
	 */
	respond(messageId: string, answer: string, source: "orchestrator" | "human" = "orchestrator"): boolean {
		const entry = this.pending.get(messageId);
		if (!entry) return false;

		if (entry.timer) clearTimeout(entry.timer);

		entry.resolve({
			answer,
			source,
			timestamp: Date.now(),
			messageId,
		});

		this.pending.delete(messageId);
		return true;
	}

	/**
	 * Get all pending messages (for orchestrator to process).
	 */
	getPending(): Array<IntercomMessage & { id: string }> {
		return [...this.pending.entries()].map(([id, entry]) => ({
			...entry.message,
			id,
		}));
	}

	/**
	 * Number of pending messages awaiting response.
	 */
	get pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Clean up all pending messages (e.g., on run completion).
	 */
	clear(): void {
		for (const [id, entry] of this.pending) {
			this.evict(id, "run_complete");
		}
		this.queue = [];
	}

	private evict(id: string, reason: string): void {
		const entry = this.pending.get(id);
		if (!entry) return;

		if (entry.timer) clearTimeout(entry.timer);

		entry.resolve({
			answer: `Message evicted: ${reason}`,
			source: "timeout",
			timestamp: Date.now(),
			messageId: id,
		});

		this.pending.delete(id);
	}
}

// ── Singleton per run ────────────────────────────────────────────────────

const queues = new Map<string, IntercomQueue>();

/**
 * Get or create an intercom queue for a run.
 */
export function getIntercomQueue(runId: string): IntercomQueue {
	let queue = queues.get(runId);
	if (!queue) {
		queue = new IntercomQueue();
		queues.set(runId, queue);
	}
	return queue;
}

/**
 * Clean up intercom queue for a completed run.
 */
export function cleanupIntercomQueue(runId: string): void {
	const queue = queues.get(runId);
	if (queue) {
		queue.clear();
		queues.delete(runId);
	}
}
