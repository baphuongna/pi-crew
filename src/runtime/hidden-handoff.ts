/**
 * HiddenHandoffService - Sends hidden boomerang-handoff messages to parent agents.
 * 
 * Based on pi-boomerang's triggerHiddenOrchestratorHandoff() pattern:
 * - Sends customType: "boomerang-handoff" messages
 * - Full handoff details in hidden message to parent
 * - Orchestrator immediately reads summary
 * 
 * @see docs/pi-boomerang-integration-plan.md
 */

import type { HandoffSummary } from "./handoff-manager.ts";

/**
 * Type of hidden handoff message.
 */
export type HiddenHandoffType = "boomerang-handoff" | "task-complete" | "context-ready";

/**
 * Hidden handoff message sent to parent agent.
 */
export interface HiddenHandoff {
	type: HiddenHandoffType;
	hidden: true;
	content: HandoffContent;
	metadata: HiddenHandoffMetadata;
}

/**
 * Metadata for hidden handoff message.
 */
export interface HiddenHandoffMetadata {
	taskId: string;
	runId: string;
	timestamp: number;
	priority: HandoffPriority;
}

/**
 * Priority level for hidden handoffs.
 */
export type HandoffPriority = "low" | "normal" | "high";

/**
 * Content of a hidden handoff message.
 */
export interface HandoffContent {
	summary: string;
	files: {
		created: string[];
		modified: string[];
		deleted: string[];
	};
	decisions: {
		rationale: string;
		outcome: string;
	}[];
	nextSteps: string[];
	metrics: {
		tokens: number;
		duration: number;
	};
}

/**
 * Options for HiddenHandoffService.
 */
export interface HiddenHandoffServiceOptions {
	/** Custom mailbox service for sending messages */
	mailbox?: HiddenHandoffMailbox;
	/** Event emitter for handoff events */
	eventEmitter?: HiddenHandoffEventEmitter;
	/** Get parent agent ID callback */
	getParentAgentId?: () => string;
}

/**
 * Mailbox interface for sending hidden handoffs.
 */
export interface HiddenHandoffMailbox {
	send(recipient: string, message: HiddenHandoff): void;
}

/**
 * Event emitter for hidden handoff events.
 */
export interface HiddenHandoffEventEmitter {
	emit(event: string, data: unknown): void;
}

/**
 * Event data for hidden handoff sent event.
 */
export interface HiddenHandoffSentEventData {
	summary: HandoffSummary;
	recipient: string;
	priority: HandoffPriority;
}

/**
 * HiddenHandoffService sends hidden boomerang-handoff messages to parent agents.
 * This enables agents to communicate progress and context without explicit user-visible output.
 */
export class HiddenHandoffService {
	private mailbox: HiddenHandoffMailbox | null = null;
	private eventEmitter: HiddenHandoffEventEmitter | null = null;
	private getParentAgentIdFn: (() => string) | null = null;
	private enabled = true;
	// C7: Track rate limiting per recipient
	private sendTimestamps = new Map<string, number[]>();
	private readonly RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
	private readonly RATE_LIMIT_MAX_SENDS = 10; // Max handoffs per window

	constructor(options: HiddenHandoffServiceOptions = {}) {
		if (options.mailbox) {
			this.mailbox = options.mailbox;
		}
		if (options.eventEmitter) {
			this.eventEmitter = options.eventEmitter;
		}
		if (options.getParentAgentId) {
			this.getParentAgentIdFn = options.getParentAgentId;
		}
	}

	/**
	 * Check if hidden handoff service is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled;
	}

	/**
	 * Enable or disable hidden handoff service.
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * Set the mailbox service for sending messages.
	 */
	setMailbox(mailbox: HiddenHandoffMailbox): void {
		this.mailbox = mailbox;
	}

	/**
	 * Set the event emitter for events.
	 */
	setEventEmitter(eventEmitter: HiddenHandoffEventEmitter): void {
		this.eventEmitter = eventEmitter;
	}

	/**
	 * Set the function to get parent agent ID.
	 */
	setGetParentAgentId(fn: () => string): void {
		this.getParentAgentIdFn = fn;
	}

	/**
	 * Send a hidden handoff to the parent agent or specified recipient.
	 * 
	 * @param summary - The handoff summary to send
	 * @param options - Send options
	 */
	sendHandoff(
		summary: HandoffSummary,
		options: SendHandoffOptions = {},
	): void {
		if (!this.enabled) {
			return;
		}

		const priority = options.priority ?? this.inferPriority(summary);
		const content = this.buildContent(summary);
		let recipient = options.to ?? this.getParentAgentId();

		if (!recipient) {
			// No parent to send to, but we still emit the event
			this.eventEmitter?.emit("handoff:sent_no_recipient", {
				summary,
				priority,
			});
			return;
		}

		// C7: Validate recipient is a reasonable agent ID
		if (!this.isValidRecipient(recipient)) {
			this.eventEmitter?.emit("handoff:invalid_recipient", {
				recipient,
				summary,
			});
			return;
		}

		// C7: Check rate limit
		if (this.isRateLimited(recipient)) {
			this.eventEmitter?.emit("handoff:rate_limited", {
				recipient,
				summary,
			});
			return;
		}

		const message: HiddenHandoff = {
			type: options.customType ?? "boomerang-handoff",
			hidden: true,
			content,
			metadata: {
				taskId: summary.taskId,
				runId: summary.runId,
				timestamp: Date.now(),
				priority,
			},
		};

		if (this.mailbox) {
			this.mailbox.send(recipient, message);
		}

		// C7: Record send for rate limiting
		this.recordSend(recipient);

		this.eventEmitter?.emit("handoff:sent", {
			summary,
			recipient,
			priority,
		});
	}

	/**
	 * Send a hidden handoff immediately (fire and forget).
	 */
	sendHandoffAsync(
		summary: HandoffSummary,
		options?: SendHandoffOptions,
	): void {
		// Fire and forget - no await
		try {
			this.sendHandoff(summary, options);
		} catch (error) {
			// Log but don't throw
			console.error("Hidden handoff failed:", error);
		}
	}

	/**
	 * Infer priority based on summary outcome.
	 */
	private inferPriority(summary: HandoffSummary): HandoffPriority {
		if (summary.outcome === "failure") {
			return "high";
		}
		if (summary.blockers.length > 0) {
			return "normal";
		}
		if (summary.metrics.tokensUsed > 10000) {
			return "normal";
		}
		return "low";
	}

	/**
	 * Build handoff content from summary.
	 */
	private buildContent(summary: HandoffSummary): HandoffContent {
		return {
			summary: this.buildSummaryText(summary),
			files: {
				created: summary.filesCreated,
				modified: summary.filesModified,
				deleted: summary.filesDeleted,
			},
			decisions: summary.decisions.map((d) => ({
				rationale: d.rationale,
				outcome: d.outcome,
			})),
			nextSteps: summary.nextSteps,
			metrics: {
				tokens: summary.metrics.tokensUsed,
				duration: summary.metrics.duration,
			},
		};
	}

	/**
	 * Build summary text from summary.
	 */
	private buildSummaryText(summary: HandoffSummary): string {
		const parts: string[] = [
			`Completed: ${summary.task}`,
			`Outcome: ${summary.outcome}`,
		];

		if (summary.filesCreated.length > 0) {
			parts.push(`Files created: ${summary.filesCreated.join(", ")}`);
		}
		if (summary.filesModified.length > 0) {
			parts.push(`Files modified: ${summary.filesModified.join(", ")}`);
		}
		if (summary.decisions.length > 0) {
			parts.push(`Decisions: ${summary.decisions.length}`);
		}
		if (summary.blockers.length > 0) {
			parts.push(`Blockers: ${summary.blockers.join("; ")}`);
		}
		if (summary.nextSteps.length > 0) {
			parts.push(`Next steps: ${summary.nextSteps.join("; ")}`);
		}

		parts.push(
			`Tokens: ${summary.metrics.tokensUsed}`,
			`Duration: ${Math.round(summary.metrics.duration / 1000)}s`,
		);

		return parts.join("\n");
	}

	/**
	 * Get parent agent ID from callback or context.
	 */
	private getParentAgentId(): string | undefined {
		if (this.getParentAgentIdFn) {
			return this.getParentAgentIdFn();
		}
		// Fallback: try to get from global context
		const ctx = (globalThis as Record<string, unknown>).__piCrewContext;
		if (ctx && typeof ctx === "object") {
			return (ctx as Record<string, unknown>).parentAgentId as string | undefined;
		}
		return undefined;
	}

	/**
	 * C7: Validate recipient is a reasonable agent ID.
	 */
	private isValidRecipient(recipient: string): boolean {
		if (!recipient || typeof recipient !== "string") {
			return false;
		}
		// Reasonable length for an agent ID
		if (recipient.length < 1 || recipient.length > 256) {
			return false;
		}
		// Only allow alphanumeric, hyphen, underscore, colon, and period
		// This prevents injection in mailbox routing
		if (!/^[a-zA-Z0-9_:.-]+$/.test(recipient)) {
			return false;
		}
		return true;
	}

	/**
	 * C7: Check if recipient is rate limited.
	 */
	private isRateLimited(recipient: string): boolean {
		const now = Date.now();
		const timestamps = this.sendTimestamps.get(recipient) ?? [];

		// Filter out old timestamps outside the window
		const recentTimestamps = timestamps.filter(
			(t) => now - t < this.RATE_LIMIT_WINDOW_MS,
		);

		return recentTimestamps.length >= this.RATE_LIMIT_MAX_SENDS;
	}

	/**
	 * C7: Record a send for rate limiting.
	 */
	private recordSend(recipient: string): void {
		const now = Date.now();
		const timestamps = this.sendTimestamps.get(recipient) ?? [];
		timestamps.push(now);

		// Keep only recent timestamps (last 5 minutes)
		const recentTimestamps = timestamps.filter(
			(t) => now - t < 300000,
		);

		this.sendTimestamps.set(recipient, recentTimestamps);
	}
}

/**
 * Options for sending hidden handoffs.
 */
export interface SendHandoffOptions {
	/** Recipient agent ID (defaults to parent) */
	to?: string;
	/** Priority level */
	priority?: HandoffPriority;
	/** Custom handoff type */
	customType?: HiddenHandoffType;
}

/**
 * Create a HiddenHandoffService with default options.
 */
export function createHiddenHandoffService(
	options?: HiddenHandoffServiceOptions,
): HiddenHandoffService {
	return new HiddenHandoffService(options);
}