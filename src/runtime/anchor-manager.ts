/**
 * Maximum number of anchors to prevent memory leaks.
 */
const MAX_ANCHORS = 50;

/**
 * Maximum number of handoffs per anchor to prevent memory leaks.
 */
const MAX_HANDOFFS_PER_ANCHOR = 100;

/**
 * AnchorManager - Creates shared summary points where multiple handoffs accumulate.
 *
 * Based on pi-boomerang's anchorMode pattern:
 * - setAnchor() creates a shared summary point for a session
 * - accumulateHandoff() adds handoffs to the anchor
 * - clearAnchor() finalizes and returns accumulated summaries
 * - getAnchorHandoff() retrieves accumulated summary without clearing
 */

import type { HandoffSummary } from "./handoff-manager.ts";

/**
 * Represents a shared summary point where multiple handoffs accumulate.
 */
export interface Anchor {
	/** Unique anchor identifier */
	id: string;
	/** Session ID this anchor belongs to */
	sessionId: string;
	/** Timestamp when anchor was created */
	createdAt: number;
	/** Accumulated handoffs */
	handoffs: HandoffSummary[];
	/** Initial context when anchor was set */
	context: Record<string, unknown>;
}

/**
 * Options for AnchorManager.
 */
export interface AnchorManagerOptions {
	/** Custom event emitter for anchor events */
	eventEmitter?: AnchorEventEmitter;
}

/**
 * Event emitter interface for anchor lifecycle events.
 */
export interface AnchorEventEmitter {
	emit(event: string, data: unknown): void;
}

/**
 * Event data for anchor lifecycle events.
 */
export interface AnchorEventData {
	anchor: Anchor;
}

export interface AnchorClearedEventData {
	anchorId: string;
	accumulated: HandoffSummary;
}

export interface AnchorHandoffAccumulatedEventData {
	anchorId: string;
	handoff: HandoffSummary;
}

/**
 * AnchorManager creates shared summary points where multiple handoffs accumulate.
 * This enables scenarios where multiple agents contribute to a shared summary
 * that is then passed to a parent or used for tree navigation.
 */
export class AnchorManager {
	private anchors: Map<string, Anchor> = new Map();
	private sessionAnchors: Map<string, string> = new Map();
	private options: AnchorManagerOptions;
	private readonly MAX_ANCHORS = 1000;
	private readonly TTL_MS = 300000; // 5 minutes

	constructor(options: AnchorManagerOptions = {}) {
		this.options = options;
	}

	/**
	 * Set an anchor point for a session.
	 * All subsequent handoffs will accumulate to this anchor.
	 *
	 * @param sessionId - The session ID to create anchor for
	 * @param context - Initial context for the anchor
	 * @returns The anchor ID
	 */
	setAnchor(sessionId: string, context: Record<string, unknown> = {}): string {
		const anchorId = this.generateAnchorId();

		// Evict expired or overflow anchors before adding new one
		this.evictExpiredAnchors();
		if (this.anchors.size >= this.MAX_ANCHORS) {
			this.evictOldestAnchor();
		}

		const anchor: Anchor = {
			id: anchorId,
			sessionId,
			createdAt: Date.now(),
			handoffs: [],
			context,
		};

		this.anchors.set(anchorId, anchor);
		this.sessionAnchors.set(sessionId, anchorId);

		this.options.eventEmitter?.emit("anchor:created", { anchor });

		return anchorId;
	}

	/**
	 * Get the current anchor for a session.
	 *
	 * @param sessionId - The session ID
	 * @returns The anchor if exists, null otherwise
	 */
	getAnchor(sessionId: string): Anchor | null {
		this.evictExpiredAnchors();
		const anchorId = this.sessionAnchors.get(sessionId);
		if (!anchorId) return null;
		return this.anchors.get(anchorId) ?? null;
	}

	/**
	 * Get the anchor ID for a session.
	 *
	 * @param sessionId - The session ID
	 * @returns The anchor ID if exists, undefined otherwise
	 */
	getAnchorId(sessionId: string): string | undefined {
		return this.sessionAnchors.get(sessionId);
	}

	/**
	 * Clear an anchor and return the accumulated handoff summary.
	 * This removes the anchor and returns merged handoffs.
	 *
	 * @param anchorId - The anchor ID to clear
	 * @returns The accumulated handoff summary
	 * @throws Error if anchor not found or no handoffs accumulated
	 */
	clearAnchor(anchorId: string): HandoffSummary {
		const anchor = this.anchors.get(anchorId);

		if (!anchor) {
			throw new AnchorNotFoundError(anchorId);
		}

		const accumulated = this.accumulateHandoffs(anchor.handoffs);

		// Clean up maps
		this.sessionAnchors.delete(anchor.sessionId);
		this.anchors.delete(anchorId);

		this.options.eventEmitter?.emit("anchor:cleared", {
			anchorId,
			accumulated,
		});

		return accumulated;
	}

	/**
	 * Clear anchor by session ID.
	 *
	 * @param sessionId - The session ID
	 * @returns The accumulated handoff summary
	 */
	clearAnchorBySession(sessionId: string): HandoffSummary | null {
		const anchorId = this.sessionAnchors.get(sessionId);
		if (!anchorId) return null;
		return this.clearAnchor(anchorId);
	}

	/**
	 * Accumulate a handoff to an anchor.
	 * If anchor doesn't exist, creates an implicit anchor.
	 *
	 * @param anchorId - The anchor ID
	 * @param handoff - The handoff summary to accumulate
	 */
	accumulateHandoff(anchorId: string, handoff: HandoffSummary): void {
		let anchor = this.anchors.get(anchorId);

		// Create implicit anchor if doesn't exist - create directly with the given anchorId
		if (!anchor) {
			// Evict oldest anchor if at capacity
			if (this.anchors.size >= MAX_ANCHORS) {
				const oldest = this.anchors.keys().next().value;
				if (oldest) {
					this.anchors.delete(oldest);
				}
			}
			const implicitAnchor: Anchor = {
				id: anchorId,
				sessionId: handoff.runId,
				createdAt: Date.now(),
				handoffs: [],
				context: {},
			};
			this.anchors.set(anchorId, implicitAnchor);
			anchor = implicitAnchor;
		}

		// Enforce handoff limit per anchor to prevent unbounded growth
		if (anchor!.handoffs.length >= MAX_HANDOFFS_PER_ANCHOR) {
			anchor!.handoffs.shift();
		}
		anchor!.handoffs.push(handoff);

		this.options.eventEmitter?.emit("anchor:handoffAccumulated", {
			anchorId: anchor!.id,
			handoff,
		});
	}

	/**
	 * Accumulate handoff by session ID.
	 *
	 * @param sessionId - The session ID
	 * @param handoff - The handoff summary to accumulate
	 */
	accumulateHandoffBySession(sessionId: string, handoff: HandoffSummary): void {
		const anchorId = this.sessionAnchors.get(sessionId);
		if (!anchorId) {
			// Create new anchor for this session
			const newAnchorId = this.setAnchor(sessionId);
			this.accumulateHandoff(newAnchorId, handoff);
		} else {
			this.accumulateHandoff(anchorId, handoff);
		}
	}

	/**
	 * Get the accumulated handoff for an anchor without clearing it.
	 *
	 * @param anchorId - The anchor ID
	 * @returns The accumulated handoff summary, or null if anchor not found or no handoffs
	 */
	getAnchorHandoff(anchorId: string): HandoffSummary | null {
		const anchor = this.anchors.get(anchorId);
		if (!anchor) return null;
		if (anchor.handoffs.length === 0) return null;
		return this.accumulateHandoffs(anchor.handoffs);
	}

	/**
	 * Get accumulated handoff by session ID.
	 *
	 * @param sessionId - The session ID
	 * @returns The accumulated handoff summary, or null if no anchor or handoffs
	 */
	getAnchorHandoffBySession(sessionId: string): HandoffSummary | null {
		const anchorId = this.sessionAnchors.get(sessionId);
		if (!anchorId) return null;
		return this.getAnchorHandoff(anchorId);
	}

	/**
	 * Get status information for an anchor.
	 *
	 * @param anchorId - The anchor ID
	 * @returns Status object or null if anchor not found
	 */
	getAnchorStatus(anchorId: string): AnchorStatus | null {
		const anchor = this.anchors.get(anchorId);
		if (!anchor) return null;

		return {
			anchorId: anchor.id,
			sessionId: anchor.sessionId,
			createdAt: anchor.createdAt,
			handoffCount: anchor.handoffs.length,
			totalTokens: anchor.handoffs.reduce((sum, h) => sum + h.metrics.tokensUsed, 0),
			totalDuration: anchor.handoffs.reduce((sum, h) => sum + h.metrics.duration, 0),
			context: anchor.context,
		};
	}

	/**
	 * Get status by session ID.
	 *
	 * @param sessionId - The session ID
	 * @returns Status object or null if no anchor
	 */
	getAnchorStatusBySession(sessionId: string): AnchorStatus | null {
		const anchorId = this.sessionAnchors.get(sessionId);
		if (!anchorId) return null;
		return this.getAnchorStatus(anchorId);
	}

	/**
	 * Check if an anchor has handoffs accumulated.
	 *
	 * @param anchorId - The anchor ID
	 * @returns True if anchor has handoffs
	 */
	hasHandoffs(anchorId: string): boolean {
		const anchor = this.anchors.get(anchorId);
		return anchor ? anchor.handoffs.length > 0 : false;
	}

	/**
	 * Get all anchors.
	 *
	 * @returns Array of all anchors
	 */
	getAllAnchors(): Anchor[] {
		return Array.from(this.anchors.values());
	}

	/**
	 * Clear all anchors.
	 */
	clearAll(): void {
		this.anchors.clear();
		this.sessionAnchors.clear();
		this.options.eventEmitter?.emit("anchor:cleared_all", {});
	}

	/**
	 * Merge multiple handoffs into a single accumulated summary.
	 */
	private accumulateHandoffs(handoffs: HandoffSummary[]): HandoffSummary {
		if (handoffs.length === 0) {
			throw new NoHandoffsError();
		}

		const allMetrics = handoffs.reduce(
			(acc, h) => ({
				tokensUsed: acc.tokensUsed + h.metrics.tokensUsed,
				duration: acc.duration + h.metrics.duration,
				iterations: acc.iterations + h.metrics.iterations,
				toolsUsed: [...acc.toolsUsed, ...h.metrics.toolsUsed],
			}),
			{
				tokensUsed: 0,
				duration: 0,
				iterations: 0,
				toolsUsed: [] as string[],
			},
		);

		// Deduplicate tools
		const uniqueTools = [...new Set(allMetrics.toolsUsed)];

		return {
			taskId: `anchor-${handoffs[0].taskId}`,
			runId: handoffs[0].runId,
			timestamp: Date.now(),

			task: `Accumulated: ${handoffs.map((h) => h.task).join(" → ")}`,
			outcome: handoffs.every((h) => h.outcome === "success")
				? "success"
				: handoffs.some((h) => h.outcome === "failure")
					? "failure"
					: "partial",

			filesCreated: [...new Set(handoffs.flatMap((h) => h.filesCreated))],
			filesModified: [...new Set(handoffs.flatMap((h) => h.filesModified))],
			filesDeleted: [...new Set(handoffs.flatMap((h) => h.filesDeleted))],

			decisions: handoffs.flatMap((h) => h.decisions),
			blockers: [...new Set(handoffs.flatMap((h) => h.blockers))],
			nextSteps: handoffs.flatMap((h) => h.nextSteps),

			metrics: {
				tokensUsed: allMetrics.tokensUsed,
				duration: allMetrics.duration,
				iterations: allMetrics.iterations,
				toolsUsed: uniqueTools,
			},

			contextSnapshot: handoffs.map((h) => h.contextSnapshot).join("\n---\n"),
		};
	}

	/**
	 * Generate a unique anchor ID.
	 */
	private generateAnchorId(): string {
		return `anchor-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
	}

	/**
	 * Evict expired anchors based on TTL.
	 */
	private evictExpiredAnchors(): void {
		const now = Date.now();
		for (const [anchorId, anchor] of this.anchors) {
			if (now - anchor.createdAt > this.TTL_MS) {
				this.sessionAnchors.delete(anchor.sessionId);
				this.anchors.delete(anchorId);
			}
		}
	}

	/**
	 * Evict the oldest anchor (LRU eviction when at max capacity).
	 */
	private evictOldestAnchor(): void {
		let oldestAnchorId: string | null = null;
		let oldestTime = Infinity;
		for (const [anchorId, anchor] of this.anchors) {
			if (anchor.createdAt < oldestTime) {
				oldestTime = anchor.createdAt;
				oldestAnchorId = anchorId;
			}
		}
		if (oldestAnchorId) {
			const anchor = this.anchors.get(oldestAnchorId);
			if (anchor) {
				this.sessionAnchors.delete(anchor.sessionId);
			}
			this.anchors.delete(oldestAnchorId);
		}
	}
}

/**
 * Status information for an anchor.
 */
export interface AnchorStatus {
	anchorId: string;
	sessionId: string;
	createdAt: number;
	handoffCount: number;
	totalTokens: number;
	totalDuration: number;
	context: Record<string, unknown>;
}

/**
 * Error thrown when an anchor is not found.
 */
export class AnchorNotFoundError extends Error {
	public readonly anchorId: string;

	constructor(anchorId: string) {
		super(`Anchor not found: ${anchorId}`);
		this.name = "AnchorNotFoundError";
		this.anchorId = anchorId;
	}
}

/**
 * Error thrown when there are no handoffs to accumulate.
 */
export class NoHandoffsError extends Error {
	constructor() {
		super("No handoffs to accumulate");
		this.name = "NoHandoffsError";
	}
}

/**
 * Create an AnchorManager with default options.
 */
export function createAnchorManager(options?: AnchorManagerOptions): AnchorManager {
	return new AnchorManager(options);
}

// Re-export HandoffSummary for consumers
export type { HandoffSummary } from "./handoff-manager.ts";
