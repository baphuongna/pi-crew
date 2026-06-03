// HandoffManager defaults
const DEFAULT_SUMMARIZE_THRESHOLD = 5000;
const DEFAULT_HANDOVER_TIMEOUT_MS = 300000; // 5 minutes
const DEFAULT_CLEANUP_INTERVAL_MS = 60000; // 1 minute
const MAX_PENDING_HANDOFFS = 1000; // Prevent unbounded growth

/**
 * Type guard for HandoffSummary structure validation.
 */
export function isValidHandoffSummary(value: unknown): value is HandoffSummary {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const obj = value as Record<string, unknown>;

	// Check required fields
	if (typeof obj.taskId !== 'string' || !obj.taskId) return false;
	if (typeof obj.runId !== 'string' || !obj.runId) return false;
	if (typeof obj.timestamp !== 'number') return false;
	if (typeof obj.task !== 'string' || !obj.task) return false;
	if (typeof obj.outcome !== 'string') return false;
	if (!['success', 'failure', 'partial'].includes(obj.outcome)) return false;

	// Check arrays
	if (!Array.isArray(obj.filesCreated)) return false;
	if (!Array.isArray(obj.filesModified)) return false;
	if (!Array.isArray(obj.filesDeleted)) return false;
	if (!Array.isArray(obj.decisions)) return false;
	if (!Array.isArray(obj.blockers)) return false;
	if (!Array.isArray(obj.nextSteps)) return false;

	// Check metrics object
	if (!obj.metrics || typeof obj.metrics !== 'object') return false;
	const metrics = obj.metrics as Record<string, unknown>;
	if (typeof metrics.tokensUsed !== 'number') return false;
	if (typeof metrics.duration !== 'number') return false;
	if (typeof metrics.iterations !== 'number') return false;
	if (!Array.isArray(metrics.toolsUsed)) return false;

	// Check contextSnapshot
	if (typeof obj.contextSnapshot !== 'string') return false;

	return true;
}

/**
 * HandoffManager - Generates structured summaries for agent handoffs.
 * 
 * Based on pi-boomerang's session_before_tree hook pattern:
 * - Detects task completion via agent_end hook
 * - Generates structured summaries with token metrics, artifacts, decisions
 * - Optionally collapses context to reduce token usage
 * 
 * @see docs/pi-boomerang-integration-plan.md
 */

import type { TeamEvent } from "../state/event-log.ts";

/**
 * Represents a key decision made during task execution.
 */
export interface Decision {
	rationale: string;
	outcome: string;
	alternativesConsidered: string[];
}

/**
 * Structured handoff summary for passing context between agents.
 */
export interface HandoffSummary {
	taskId: string;
	runId: string;
	timestamp: number;

	// Core summary
	task: string;
	outcome: "success" | "failure" | "partial";

	// Structured artifacts
	filesCreated: string[];
	filesModified: string[];
	filesDeleted: string[];

	// Key decisions made
	decisions: Decision[];

	// Open issues / next steps
	blockers: string[];
	nextSteps: string[];

	// Metrics
	metrics: {
		tokensUsed: number;
		duration: number;
		iterations: number;
		toolsUsed: string[];
	};

	// Context snapshot
	contextSnapshot: string;
}

/**
 * Task result interface (simplified for handoff generation).
 */
export interface TaskResult {
	outcome: "success" | "failure" | "partial";
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
	};
	duration?: number;
	iterations?: number;
	toolsUsed?: string[];
	blockers?: string[];
	nextSteps?: string[];
	filesCreated?: string[];
	filesModified?: string[];
	filesDeleted?: string[];
	decisions?: Decision[];
	error?: string;
}

/**
 * Task packet interface (minimal for handoff generation).
 */
export interface TaskPacket {
	taskId: string;
	runId: string;
	goal: string;
	sessionId?: string;
	summarizeThreshold?: number;
	collapseContext?: boolean;
	forceSummarize?: boolean;
	context?: Record<string, unknown>;
}

export interface HandoffManagerOptions {
	/** Default token threshold for triggering summarization */
	defaultSummarizeThreshold?: number;
	/** Enable context collapse after handoff */
	enableContextCollapse?: boolean;
	/** Custom event emitter for handoff events */
	eventEmitter?: HandoffEventEmitter;
	/** Timeout for pending handoffs in ms (default: 300000 = 5 minutes) */
	handoffTimeoutMs?: number;
	/** Interval for cleanup of old pending handoffs in ms (default: 60000 = 1 minute) */
	cleanupIntervalMs?: number;
}

export interface HandoffEventEmitter {
	emit(event: string, data: unknown): void;
}

/**
 * Result of shouldSummarize check.
 */
export interface SummarizeDecision {
	shouldSummarize: boolean;
	reason: string;
	tokenCount: number;
}

/**
 * HandoffManager generates structured summaries when agents complete tasks,
 * enabling efficient context passing to subsequent agents.
 * 
 * H1: Includes memory management to prevent unbounded growth of pendingHandoffs Map.
 */
export class HandoffManager {
	private pendingHandoffs = new Map<string, HandoffSummary>();
	private options: HandoffManagerOptions;
	private handoffTimestamps = new Map<string, number>(); // Track when handoffs were added
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	constructor(options: HandoffManagerOptions = {}) {
		this.options = {
			defaultSummarizeThreshold: DEFAULT_SUMMARIZE_THRESHOLD,
			handoffTimeoutMs: DEFAULT_HANDOVER_TIMEOUT_MS,
			cleanupIntervalMs: DEFAULT_CLEANUP_INTERVAL_MS,
			...options,
		};

		// Start cleanup timer
		this.startCleanupTimer();
	}

	/**
	 * Start the periodic cleanup timer for stale pending handoffs.
	 * H1: Prevents memory leak by clearing old entries.
	 */
	private startCleanupTimer(): void {
		if (this.disposed) {
			return;
		}
		if (this.cleanupTimer) {
			return;
		}
		this.cleanupTimer = setInterval(() => {
			this.cleanupStaleHandoffs();
		}, this.options.cleanupIntervalMs);
	}

	/**
	 * Clean up stale pending handoffs that have exceeded the timeout.
	 * H1: Prevents memory leak by removing old entries.
	 * FIX: Iterate over entries() instead of mutating Map during iteration.
	 */
	private cleanupStaleHandoffs(): void {
		if (this.disposed) return;

		const now = Date.now();
		const timeout = this.options.handoffTimeoutMs ?? DEFAULT_HANDOVER_TIMEOUT_MS;
		const cutoff = now - timeout;

		// Collect keys to delete to avoid mutation during iteration
		const toDelete: string[] = [];
		for (const [sessionId, timestamp] of this.handoffTimestamps.entries()) {
			if (timestamp < cutoff) {
				toDelete.push(sessionId);
			}
		}
		for (const sessionId of toDelete) {
			this.pendingHandoffs.delete(sessionId);
			this.handoffTimestamps.delete(sessionId);
		}

		// Also enforce max handoffs limit
		if (this.pendingHandoffs.size > MAX_PENDING_HANDOFFS) {
			// Remove oldest entries
			const sortedEntries = [...this.handoffTimestamps.entries()]
				.sort((a, b) => a[1] - b[1]);
			const removeCount = sortedEntries.length - MAX_PENDING_HANDOFFS;
			for (let i = 0; i < removeCount; i++) {
				const sessionId = sortedEntries[i][0];
				this.pendingHandoffs.delete(sessionId);
				this.handoffTimestamps.delete(sessionId);
			}
		}
	}

	/**
	 * Hook: agent_end
	 * Called when agent completes a task.
	 * 
	 * @param packet - The task packet
	 * @param result - The task result
	 */
	async onAgentEnd(packet: TaskPacket, result: TaskResult): Promise<HandoffSummary | null> {
		if (this.disposed) {
			return null;
		}

		// Check if summarization is needed
		if (!this.shouldSummarize(packet, result).shouldSummarize) {
			return null;
		}

		// Generate handoff summary
		const summary = await this.generateSummary(packet, result);

		// H7: Validate generated summary structure
		if (!isValidHandoffSummary(summary)) {
			this.options.eventEmitter?.emit("handoff:validation_failed", {
				packet,
				error: "Generated summary failed structure validation",
			});
			return null;
		}

		// Store pending handoff for tree navigation
		if (packet.sessionId) {
			this.pendingHandoffs.set(packet.sessionId, summary);
			this.handoffTimestamps.set(packet.sessionId, Date.now());
		}

		// Emit handoff event
		this.options.eventEmitter?.emit("handoff:generated", { packet, summary });

		// Optionally collapse context
		if (packet.collapseContext) {
			await this.collapseContext(packet, summary);
		}

		return summary;
	}

	/**
	 * Hook: session_before_tree
	 * Called before navigating to tree view.
	 * Injects pending handoff summaries into the tree.
	 * 
	 * @param sessionId - The session ID
	 * @param targetId - The target tree node ID
	 */
	async onBeforeTreeNavigation(sessionId: string, targetId: string): Promise<HandoffSummary | null> {
		if (this.disposed) {
			return null;
		}

		const pendingHandoff = this.pendingHandoffs.get(sessionId);

		if (pendingHandoff) {
			// Clear the pending handoff after injection
			this.pendingHandoffs.delete(sessionId);
			this.handoffTimestamps.delete(sessionId);
			return pendingHandoff;
		}

		return null;
	}

	/**
	 * Check if summarization should be performed.
	 * H7: Validates input parameters before generating summary.
	 */
	shouldSummarize(packet: TaskPacket, result: TaskResult): SummarizeDecision {
		// H7: Validate packet structure
		if (!packet || typeof packet.taskId !== 'string' || !packet.taskId) {
			return {
				shouldSummarize: false,
				reason: 'Invalid task packet structure',
				tokenCount: 0,
			};
		}

		// H7: Validate result structure
		if (!result || typeof result.outcome !== 'string') {
			return {
				shouldSummarize: false,
				reason: 'Invalid task result structure',
				tokenCount: 0,
			};
		}

		const threshold = packet.summarizeThreshold ?? this.options.defaultSummarizeThreshold ?? DEFAULT_SUMMARIZE_THRESHOLD;
		const tokenCount = result.usage?.totalTokens ?? 0;

		// Summarize if:
		// 1. Task exceeded threshold tokens
		if (tokenCount > threshold) {
			return {
				shouldSummarize: true,
				reason: `Token count ${tokenCount} exceeds threshold ${threshold}`,
				tokenCount,
			};
		}

		// 2. Task completed with significant work (3 or more tools used)
		if (result.outcome === "success" && (result.toolsUsed?.length ?? 0) >= 3) {
			return {
				shouldSummarize: true,
				reason: `Task used ${result.toolsUsed?.length ?? 0} tools, exceeding minimum of 3`,
				tokenCount,
			};
		}

		// 3. Explicitly requested
		if (packet.forceSummarize === true) {
			return {
				shouldSummarize: true,
				reason: "Forced summarization requested",
				tokenCount,
			};
		}

		// 4. Task has significant artifacts or decisions
		const hasArtifacts = (result.filesCreated?.length ?? 0) > 0 ||
			(result.filesModified?.length ?? 0) > 0;
		const hasDecisions = (result.decisions?.length ?? 0) > 0;

		if (hasArtifacts || hasDecisions) {
			return {
				shouldSummarize: true,
				reason: "Task produced significant artifacts or decisions",
				tokenCount,
			};
		}

		// 5. Task outcome is not success (failure or partial)
		if (result.outcome !== "success") {
			return {
				shouldSummarize: true,
				reason: `Task outcome is ${result.outcome}`,
				tokenCount,
			};
		}

		return {
			shouldSummarize: false,
			reason: "Task below summarization threshold",
			tokenCount,
		};
	}

	/**
	 * Generate a structured handoff summary.
	 */
	async generateSummary(packet: TaskPacket, result: TaskResult): Promise<HandoffSummary> {
		const artifacts = this.extractArtifacts(result);
		// Use extractDecisionsFromResult to handle empty array and generate defaults
		const decisions = this.extractDecisionsFromResult(result);
		const contextSnapshot = await this.generateContextSnapshot(
			packet.runId,
			packet.taskId,
			result
		);

		return {
			taskId: packet.taskId,
			runId: packet.runId,
			timestamp: Date.now(),

			task: packet.goal,
			outcome: result.outcome,

			filesCreated: artifacts.created,
			filesModified: artifacts.modified,
			filesDeleted: artifacts.deleted,

			decisions,
			blockers: result.blockers ?? [],
			nextSteps: result.nextSteps ?? [],

			metrics: {
				tokensUsed: result.usage?.totalTokens ?? 0,
				duration: result.duration ?? 0,
				iterations: result.iterations ?? 1,
				toolsUsed: result.toolsUsed ?? [],
			},

			contextSnapshot,
		};
	}

	/**
	 * Collapse context after handoff.
	 * Signals to other extensions not to prompt during collapse.
	 */
	async collapseContext(packet: TaskPacket, summary: HandoffSummary): Promise<void> {
		// Set global flag to signal collapse in progress
		(globalThis as Record<string, unknown>).__boomerangCollapseInProgress = true;

		try {
			// Emit event that context will be collapsed
			this.options.eventEmitter?.emit("handoff:context_collapse", {
				sessionId: packet.sessionId,
				taskId: packet.taskId,
				summary,
			});
		} finally {
			// Clear the flag
			(globalThis as Record<string, unknown>).__boomerangCollapseInProgress = false;
		}
	}

	/**
	 * Get pending handoff for a session.
	 */
	getPendingHandoff(sessionId: string): HandoffSummary | undefined {
		return this.pendingHandoffs.get(sessionId);
	}

	/**
	 * Clear pending handoff for a session.
	 */
	clearPendingHandoff(sessionId: string): void {
		this.pendingHandoffs.delete(sessionId);
		this.handoffTimestamps.delete(sessionId);
	}

	/**
	 * Clear all pending handoffs.
	 * H1: Manual cleanup method for memory management.
	 */
	clearAllPendingHandoffs(): void {
		this.pendingHandoffs.clear();
		this.handoffTimestamps.clear();
	}

	/**
	 * Get the count of pending handoffs.
	 * Useful for monitoring and debugging.
	 */
	getPendingCount(): number {
		return this.pendingHandoffs.size;
	}

	/**
	 * Extract file artifacts from task result.
	 */
	private extractArtifacts(result: TaskResult): {
		created: string[];
		modified: string[];
		deleted: string[];
	} {
		return {
			created: result.filesCreated ?? [],
			modified: result.filesModified ?? [],
			deleted: result.filesDeleted ?? [],
		};
	}

	/**
	 * Extract decisions from task result.
	 */
	private extractDecisionsFromResult(result: TaskResult): Decision[] {
		if (result.decisions && result.decisions.length > 0) {
			return result.decisions;
		}

		// Generate a default decision for failure outcomes
		if (result.outcome === "failure") {
			return [{
				rationale: "Task failed",
				outcome: result.error ?? "Unknown error",
				alternativesConsidered: [],
			}];
		}

		return [];
	}

	/**
	 * Generate context snapshot for handoff.
	 */
	private async generateContextSnapshot(
		runId: string,
		taskId: string,
		result: TaskResult
	): Promise<string> {
		const parts: string[] = [];

		parts.push(`Task: ${taskId}`);
		parts.push(`Outcome: ${result.outcome}`);

		if (result.usage?.totalTokens) {
			parts.push(`Tokens: ${result.usage.totalTokens}`);
		}

		if (result.toolsUsed?.length) {
			parts.push(`Tools: ${result.toolsUsed.join(", ")}`);
		}

		if (result.blockers?.length) {
			parts.push(`Blockers: ${result.blockers.join("; ")}`);
		}

		if (result.nextSteps?.length) {
			parts.push(`Next Steps: ${result.nextSteps.join("; ")}`);
		}

		return parts.join("\n");
	}

	/**
	 * H8: Dispose of resources. Call when manager is no longer needed.
	 * Clears all pending handoffs and stops cleanup timer.
	 */
	dispose(): void {
		this.disposed = true;

		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}

		this.pendingHandoffs.clear();
		this.handoffTimestamps.clear();
	}

	/**
	 * Check if the manager has been disposed.
	 */
	isDisposed(): boolean {
		return this.disposed;
	}
}

/**
 * Create a HandoffManager with default options.
 */
export function createHandoffManager(options?: HandoffManagerOptions): HandoffManager {
	return new HandoffManager(options);
}