export type HookName =
	| "before_run_start"
	| "before_task_start"
	| "task_result"
	| "before_cancel"
	| "before_forget"
	| "before_cleanup"
	| "before_publish"
	| "session_before_switch"
	| "run_recovery";

export type HookMode = "blocking" | "non_blocking";
export type HookOutcome = "allow" | "block" | "modify" | "diagnostic";

export interface HookContext {
	runId: string;
	taskId?: string;
	cwd: string;
	[key: string]: unknown;
}

export interface HookResult {
	outcome: HookOutcome;
	reason?: string;
	data?: Record<string, unknown>;
}

export interface HookDefinition {
	name: HookName;
	mode: HookMode;
	handler: (ctx: HookContext) => HookResult | Promise<HookResult>;
}

export interface HookExecutionReport {
	hookName: HookName;
	outcome: HookOutcome;
	durationMs: number;
	reason?: string;
	modifiedData?: Record<string, unknown>;
}