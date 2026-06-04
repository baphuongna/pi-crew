export type HookName =
	| "before_run_start"
	| "after_run_complete"
	| "before_task_start"
	| "after_task_complete"
	| "task_result"
	| "before_cancel"
	| "before_retry"
	| "before_forget"
	| "before_cleanup"
	| "before_publish"
	| "session_before_switch"
	| "session_after_connect"
	| "session_after_disconnect"
	| "run_recovery";

/**
 * Hook exit codes inspired by claude-mem's lifecycle architecture:
 * - 0 = allow (success)
 * - 1 = warn (non-blocking error, continue)
 * - 2 = block (blocking error, stop)
 */
/** @internal */ const HOOK_EXIT_SUCCESS = 0 as const;
/** @internal */ const HOOK_EXIT_WARN = 1 as const;
/** @internal */ const HOOK_EXIT_BLOCK = 2 as const;

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
	// SECURITY: Optional workspace scoping. When set, the hook only executes for
	// runs in the specified workspace. When absent, the hook applies to all runs.
	workspaceId?: string;
}

export interface HookExecutionReport {
	hookName: HookName;
	outcome: HookOutcome;
	durationMs: number;
	reason?: string;
	modifiedData?: Record<string, unknown>;
}