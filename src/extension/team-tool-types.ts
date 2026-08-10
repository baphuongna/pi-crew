export interface TeamToolDetails {
	action: string;
	status: "ok" | "error" | "planned";
	runId?: string;
	artifactsRoot?: string;
	abortedIds?: string[];
	missingIds?: string[];
	foreignIds?: string[];
	intent?: string;
	resumedIds?: string[];
	retriedTaskIds?: string[];
	mailboxIds?: string[];
	/** Whether a config write actually persisted (false on no-op/skip-write). */
	written?: boolean;
	/** Resource scope affected by the action (e.g. cleanup: "project"). */
	scope?: string;
	/** Run metrics for compact display in TUI tool result rendering. */
	metrics?: {
		taskCount?: number;
		completedCount?: number;
		totalTokens?: number;
		totalCost?: number;
		durationMs?: number;
		consistencyScore?: number;
	};
	/** Structured data for programmatic consumption (e.g. TUI widgets). */
	data?: Record<string, unknown>;
}
