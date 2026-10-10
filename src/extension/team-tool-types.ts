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
	/** F1 (2026-09-12): set when a run returned early because a task parked on
	 * `ask` — the tool result carries the question; answer via respond then
	 * re-block via wait. */
	taskId?: string;
	questionId?: string;
	waiting?: boolean;
	/** RELIABILITY FIX 2026-10-10 (bug #2): set when the foreground run's WATCH
	 * window expired (waitForRun timeout) — the run itself was NOT cancelled
	 * and keeps executing; the async notifier reports completion later. */
	partialWatch?: boolean;
	/** Structured data for programmatic consumption (e.g. TUI widgets). */
	data?: Record<string, unknown>;
}
