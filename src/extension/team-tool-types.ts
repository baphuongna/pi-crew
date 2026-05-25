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
	/** Structured data for programmatic consumption (e.g. TUI widgets). */
	data?: Record<string, unknown>;
}
