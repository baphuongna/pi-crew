export interface TeamToolDetails {
	action: string;
	status: "ok" | "error" | "planned";
	runId?: string;
	artifactsRoot?: string;
	abortedIds?: string[];
	missingIds?: string[];
	foreignIds?: string[];
	resumedIds?: string[];
}
