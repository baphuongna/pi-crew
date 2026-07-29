import { Type, type TSchema } from "@sinclair/typebox";

// ───────────────────────────────────────────────────────────────────────────
// API-5 facade split: the 54-action mega-tool schema is split into 5 domain
// schemas. Each domain owns a subset of the action union; all parameter fields
// are shared across every variant so Phase 1 validation is identical to the
// pre-split flat Object (additionalProperties: true → no tightening).
// `TeamToolParams` is re-exported as a TypeBox Union for backward compat.
// ───────────────────────────────────────────────────────────────────────────

const SkillOverride = Type.Unsafe({
	description:
		"Skill name(s) to add to role/default skills, an array of skill names, or false to disable all injected skills for this run.",
	anyOf: [
		{ type: "string", maxLength: 2048 },
		{
			type: "array",
			maxItems: 32,
			items: { type: "string", maxLength: 80 },
		},
		{ type: "boolean" },
	],
});

const FreeformConfig = Type.Unsafe({
	description: "Resource config for management actions.",
	type: "object",
	additionalProperties: true,
});

/**
 * All optional parameter fields shared across every domain schema.
 *
 * Phase 1 (API-5): every field appears in every domain variant so validation
 * is byte-for-byte identical to the pre-split flat Object — no field is
 * dropped or loosened. Phase 2 may tighten per-domain field membership once
 * characterization tests lock the surface.
 */
const sharedFields = {
	resource: Type.Optional(
		Type.Union([Type.Literal("agent"), Type.Literal("team"), Type.Literal("workflow")], {
			description: "Resource kind for get/create/update/delete/list. Defaults to all for list.",
		}),
	),
	team: Type.Optional(
		Type.String({
			description: "Team name, e.g. default or implementation.",
		}),
	),
	workflow: Type.Optional(Type.String({ description: "Workflow name, e.g. default or review." })),
	role: Type.Optional(
		Type.String({
			description: "Role name to run directly within a team.",
		}),
	),
	agent: Type.Optional(Type.String({ description: "Agent name to inspect or run directly." })),
	goal: Type.Optional(Type.String({ description: "High-level objective for a team run." })),
	chain: Type.Optional(
		Type.String({
			description:
				'Chain expression: "step1 -> step2 -> step3". Runs each step as a sequential team run, passing handoff context forward via the goal text. Supports inline goals ("...") and @team references. e.g. chain=\'"Research X" -> "Analyze" -> "Write report"\'.',
		}),
	),
	task: Type.Optional(
		Type.String({
			description: "Concrete task text for direct role/agent execution.",
		}),
	),
	singleAgent: Type.Optional(
		Type.Boolean({
			description:
				"When true (with action=plan), compose a single-agent sequential prompt for the workflow instead of a multi-agent plan. Cliff-resilient mode.",
		}),
	),
	runId: Type.Optional(
		Type.String({
			description: "Run ID for status, cancel, or resume.",
			pattern: "^[A-Za-z0-9_-]+$",
		}),
	),
	taskId: Type.Optional(Type.String({ description: "Task ID for respond action." })),
	message: Type.Optional(Type.String({ description: "Message for respond action." })),
	async: Type.Optional(
		Type.Boolean({
			description: "Run in background when execution support is enabled.",
		}),
	),
	details: Type.Optional(
		Type.Boolean({
			default: true,
			description:
				"(status) Output detail level. true (default) = full status (task graph, agents, effectiveness, events). false = compact summary (status, goal, task counts, and only failed/attention task errors) for quick checks.",
		}),
	),
	workspaceMode: Type.Optional(
		Type.Union([Type.Literal("single"), Type.Literal("worktree")], {
			description: "Workspace isolation mode. Worktree mode is planned after MVP.",
		}),
	),
	context: Type.Optional(
		Type.Union([Type.Literal("fresh"), Type.Literal("fork")], {
			description: "Child context mode for workers.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory override." })),
	model: Type.Optional(Type.String({ description: "Model override for direct runs." })),
	skill: Type.Optional(SkillOverride),
	scope: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
			description: "Resource scope for discovery or management.",
		}),
	),
	config: Type.Optional(FreeformConfig),
	dryRun: Type.Optional(
		Type.Boolean({
			description: "Preview a management mutation without writing files.",
		}),
	),
	confirm: Type.Optional(
		Type.Boolean({
			description: "Required for destructive management actions.",
		}),
	),
	force: Type.Optional(
		Type.Boolean({
			description: "Override reference checks for destructive management actions.",
		}),
	),
	keep: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Number of finished runs to keep for prune.",
		}),
	),
	updateReferences: Type.Optional(
		Type.Boolean({
			description: "When renaming agents or workflows, update team references in the same project/user scope.",
		}),
	),
	replyTo: Type.Optional(
		Type.String({
			description: "ID of the original mailbox message this is a reply to.",
		}),
	),
	replyFrom: Type.Optional(Type.String({ description: "Task ID sending the reply." })),
	replyDeadline: Type.Optional(Type.Integer({ description: "Ms epoch deadline for a reply." })),
	planPath: Type.Optional(
		Type.String({
			description: "Path to a markdown plan document for orchestration.",
		}),
	),
	subAction: Type.Optional(Type.String({ description: "Sub-action for schedule management (remove, disable, enable, update)." })),
	jobId: Type.Optional(Type.String({ description: "Job ID for schedule management actions." })),
	cron: Type.Optional(
		Type.String({
			description: "Cron expression for recurring scheduled runs (e.g., '0 9 * * MON').",
		}),
	),
	interval: Type.Optional(
		Type.Number({
			description: "Interval in milliseconds between recurring scheduled runs.",
		}),
	),
	once: Type.Optional(
		Type.Union([Type.String(), Type.Number()], {
			description: "ISO timestamp or epoch ms for a one-time scheduled run.",
		}),
	),
	excludeContextBash: Type.Optional(
		Type.Boolean({
			description: "Mark certain bash commands as excludeFromContext to reduce context tokens (default: false).",
		}),
	),
	budgetTotal: Type.Optional(
		Type.Number({
			description:
				"Total token budget for the run. When set, enables budget tracking with default 80% warning and 95% abort thresholds. Minimum 1000 — this is a MISCONFIGURATION GUARD (catches typos / silent-abort configs like budgetTotal:1, which would abort on turn 1), NOT a usefulness guarantee; a productive multi-turn goal needs far more than 1000 tokens.",
			minimum: 1000,
		}),
	),
	budgetUnlimited: Type.Optional(
		Type.Boolean({
			description:
				"When true, skip budget enforcement entirely (explicit opt-out). Goal-start validation requires budgetTotal>=1000 OR budgetUnlimited:true; audit-logged when set. The validation itself is enforced in a later integration task.",
		}),
	),
	budgetWarning: Type.Optional(
		Type.Number({
			description:
				"Budget warning threshold as a fraction (0-1). Default: 0.8 (80%). Emits warning event when this threshold is crossed.",
			minimum: 0,
			maximum: 1,
		}),
	),
	budgetAbort: Type.Optional(
		Type.Number({
			description:
				"Budget abort threshold as a fraction (0-1). Default: 0.95 (95%). Aborts further execution when this threshold is crossed.",
			minimum: 0,
			maximum: 1,
		}),
	),
	runKind: Type.Optional(
		Type.Union([Type.Literal("team-run"), Type.Literal("goal-loop"), Type.Literal("dynamic-workflow")], {
			description:
				'Background dispatch discriminator. Default "team-run" runs the normal executeTeamRun workflow; "goal-loop" (P0/P1) and "dynamic-workflow" (P2/P3) dispatch to their respective background runners. Absent = "team-run" for backward compatibility.',
		}),
	),
	tokenBudget: Type.Optional(
		Type.Number({
			description:
				"Per-workflow token budget for dynamic-workflow runs. When set, ctx.agent() auto-rejects with ok:false once exhausted. Accumulated from each agent run's reported usage. Overrides workflow.maxTokenBudget.",
			minimum: 0,
		}),
	),
	args: Type.Optional(Type.Any()),
	analysis: Type.Optional(
		Type.String({
			maxLength: 100_000,
			description:
				"Inline analysis/context notes from the calling session. Persisted to artifacts/{runId}/shared/analysis.md (audit trail) and auto-injected into any workflow step declaring reads: analysis.md (e.g. builtin 'plan-execute'). Mutually exclusive with analysisPath. Ignored by goal-wrapped runs and chain dispatch in v1.",
		}),
	),
	analysisPath: Type.Optional(
		Type.String({
			description:
				"Path to an existing markdown analysis file (resolved within cwd). Copied into shared/analysis.md. Mutually exclusive with analysis.",
		}),
	),
	focus: Type.Optional(
		Type.String({
			description:
				"Sub-focus for the doctor action. 'zombies' runs a READ-ONLY scan for orphaned pi-crew sub-agent processes (identified by PI_CREW_KIND=subagent); it never kills and never matches the user's interactive main session.",
		}),
	),
};

// ─── Domain action unions (9+16+7+16+6 = 54 actions) ───────────────────────

const ACTION_DESCRIPTION = "Team action. Defaults to 'list' when omitted.";

const runActions = Type.Optional(
	Type.Union(
		[
			Type.Literal("run"),
			Type.Literal("parallel"),
			Type.Literal("plan"),
			Type.Literal("orchestrate"),
			Type.Literal("resume"),
			Type.Literal("retry"),
			Type.Literal("wait"),
			Type.Literal("steer"),
			Type.Literal("goal"),
		],
		{ description: ACTION_DESCRIPTION },
	),
);

const statusActions = Type.Optional(
	Type.Union(
		[
			Type.Literal("status"),
			Type.Literal("list"),
			Type.Literal("get"),
			Type.Literal("events"),
			Type.Literal("artifacts"),
			Type.Literal("summary"),
			Type.Literal("graph"),
			Type.Literal("search"),
			Type.Literal("health"),
			Type.Literal("worktrees"),
			Type.Literal("checkpoint"),
			Type.Literal("cache"),
			Type.Literal("explain"),
			Type.Literal("onboard"),
			Type.Literal("recommend"),
			Type.Literal("help"),
		],
		{ description: ACTION_DESCRIPTION },
	),
);

const controlActions = Type.Optional(
	Type.Union(
		[
			Type.Literal("cancel"),
			Type.Literal("invalidate"),
			Type.Literal("respond"),
			Type.Literal("cleanup"),
			Type.Literal("prune"),
			Type.Literal("forget"),
			Type.Literal("doctor"),
		],
		{ description: ACTION_DESCRIPTION },
	),
);

const manageActions = Type.Optional(
	Type.Union(
		[
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("delete"),
			Type.Literal("init"),
			Type.Literal("config"),
			Type.Literal("validate"),
			Type.Literal("autonomy"),
			Type.Literal("settings"),
			Type.Literal("workflow-create"),
			Type.Literal("workflow-get"),
			Type.Literal("workflow-list"),
			Type.Literal("workflow-save"),
			Type.Literal("workflow-delete"),
			Type.Literal("import"),
			Type.Literal("imports"),
			Type.Literal("export"),
		],
		{ description: ACTION_DESCRIPTION },
	),
);

const automateActions = Type.Optional(
	Type.Union(
		[
			Type.Literal("schedule"),
			Type.Literal("scheduled"),
			Type.Literal("anchor"),
			Type.Literal("auto-summarize"),
			Type.Literal("auto_boomerang"),
			Type.Literal("api"),
		],
		{ description: ACTION_DESCRIPTION },
	),
);

// ─── Domain schemas (additionalProperties: true — Phase 1, not tightened) ────

export const RunDomainParams = Type.Object({ action: runActions, ...sharedFields }, { additionalProperties: true });

export const StatusDomainParams = Type.Object({ action: statusActions, ...sharedFields }, { additionalProperties: true });

export const ControlDomainParams = Type.Object({ action: controlActions, ...sharedFields }, { additionalProperties: true });

export const ManageDomainParams = Type.Object({ action: manageActions, ...sharedFields }, { additionalProperties: true });

export const AutomateDomainParams = Type.Object({ action: automateActions, ...sharedFields }, { additionalProperties: true });

/**
 * LLM-facing team-tool schema. FLAT single Object (all actions + all shared
 * fields optional) — NOT the former 5-variant Type.Union. The union emitted a
 * giant `anyOf` (each variant repeated all ~30 shared fields) that LLM
 * tool-callers could not reliably satisfy → empty/malformed calls → params
 * dropped → the tool defaulted to `list`. The handler validates per-action
 * fields at runtime (defense-in-depth, team-tool.ts execute()), so the schema
 * only needs to enumerate valid actions + field types. Domain objects above
 * (RunDomainParams etc.) are kept for the facade dispatch + backward compat.
 */
const allActionLiterals = ([runActions, statusActions, controlActions, manageActions, automateActions] as TSchema[]).flatMap(
	(set) => set.anyOf ?? [],
);
export const TeamToolParams = Type.Object(
	{
		action: Type.Optional(Type.Union(allActionLiterals, { description: ACTION_DESCRIPTION })),
		...sharedFields,
	},
	{ additionalProperties: true },
);

/** Domain discriminator for the facade dispatch. */
export type TeamDomain = "run" | "status" | "control" | "manage" | "automate";

export interface TeamToolParamsValue {
	action?:
		| "run"
		| "parallel"
		| "plan"
		| "status"
		| "wait"
		| "list"
		| "get"
		| "cancel"
		| "retry"
		| "resume"
		| "respond"
		| "create"
		| "update"
		| "delete"
		| "doctor"
		| "cleanup"
		| "events"
		| "artifacts"
		| "worktrees"
		| "forget"
		| "summary"
		| "prune"
		| "export"
		| "import"
		| "imports"
		| "help"
		| "validate"
		| "config"
		| "init"
		| "recommend"
		| "autonomy"
		| "api"
		| "settings"
		| "steer"
		| "invalidate"
		| "health"
		| "graph"
		| "onboard"
		| "explain"
		| "cache"
		| "checkpoint"
		| "search"
		| "orchestrate"
		| "schedule"
		| "scheduled"
		| "anchor"
		| "auto-summarize"
		| "auto_boomerang"
		| "goal"
		| "workflow-create"
		| "workflow-get"
		| "workflow-list"
		| "workflow-save"
		| "workflow-delete";
	resource?: "agent" | "team" | "workflow";
	team?: string;
	workflow?: string;
	role?: string;
	agent?: string;
	goal?: string;
	/** Chain expression: "step1 -> step2 -> step3". Runs each step as a sequential
	 *  team run with handoff context passed forward via the goal. */
	chain?: string;
	task?: string;
	singleAgent?: boolean;
	runId?: string;
	taskId?: string;
	message?: string;
	async?: boolean;
	/** (status) Output detail level. false = compact summary. Default: true (full). */
	details?: boolean;
	workspaceMode?: "single" | "worktree";
	context?: "fresh" | "fork";
	cwd?: string;
	model?: string;
	skill?: string | string[] | boolean;
	scope?: "user" | "project" | "both";
	config?: Record<string, unknown>;
	/** Sub-focus for the `doctor` action. `"zombies"` runs a READ-ONLY scan for
	 *  orphaned pi-crew sub-agent processes (identified by PI_CREW_KIND=subagent);
	 *  it never kills and never matches the user's interactive main session. */
	focus?: string;
	dryRun?: boolean;
	confirm?: boolean;
	force?: boolean;
	keep?: number;
	updateReferences?: boolean;
	/** ID of the original mailbox message this is a reply to. */
	replyTo?: string;
	/** Task ID sending the reply. */
	replyFrom?: string;
	/** Ms epoch deadline for a reply. */
	replyDeadline?: number;
	/** Path to a markdown plan document for orchestration. */
	planPath?: string;
	cron?: string;
	interval?: number;
	once?: string | number;

	// schedule sub-actions (removal/toggle/update of an existing job)
	subAction?: string;
	jobId?: string;
	/** Mark certain bash commands as excludeFromContext to reduce context tokens (default: false). */
	excludeContextBash?: boolean;
	/** Total token budget for the run. When set, enables budget tracking (minimum 1000). */
	budgetTotal?: number;
	/** When true, skip budget enforcement entirely (explicit opt-out). */
	budgetUnlimited?: boolean;
	/** Budget warning threshold as a fraction (0-1). Default: 0.8. */
	budgetWarning?: number;
	/** Budget abort threshold as a fraction (0-1). Default: 0.95. */
	budgetAbort?: number;
	/** Background dispatch discriminator. Default "team-run". "goal-loop"/"dynamic-workflow" dispatch to their runners (P0/P2). */
	runKind?: "team-run" | "goal-loop" | "dynamic-workflow";
	/** Per-workflow token budget for dynamic-workflow runs (round-14 P1-2). */
	tokenBudget?: number;
	/** Typed workflow arguments for .dwf.ts scripts, accessible via ctx.args<T>() (round-14 P1-5). */
	args?: unknown;
	/** Inline analysis/context notes from the calling session. Persisted to
	 *  artifacts/{runId}/shared/analysis.md (audit trail) and auto-injected into
	 *  any workflow step declaring reads: analysis.md (e.g. builtin 'plan-execute').
	 *  Mutually exclusive with `analysisPath`. */
	analysis?: string;
	/** Path to an existing analysis file resolved within `cwd`. Copied into
	 *  shared/analysis.md. Mutually exclusive with `analysis`. */
	analysisPath?: string;
}
