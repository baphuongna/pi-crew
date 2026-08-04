import { type TSchema, Type, TypeRegistry } from "@sinclair/typebox";

// ─────────────────────────────────────────────────────────────────────────
// EXT-7: Compact enum action schema. TypeBox has no built-in type that
// produces JSON Schema `{ enum: [...] }` AND validates via Value.Check.
// Type.Unsafe defaults to Kind 'Unsafe' which Value.Check throws on.
// We register a custom 'StringEnum' kind once: JSON Schema consumers (the
// LLM tool definition) see the compact `{ type: "string", enum: [...] }`
// (~600 chars vs ~1890 for anyOf+const), and Value.Check validates via
// the registered predicate.
//
// GUARD (v0.9.58 — load-crash fix): TypeRegistry was added in
// @sinclair/typebox@0.34.50. Pi installs ALL extensions into ONE shared
// npm store with hoisted deps, and on update it only checks the extension's
// own package.json version — if pi-crew is already latest, it does NOT re-
// resolve transitive deps. So an install could land pi-crew@0.9.57 (which
// needs TypeRegistry) over a stale hoisted @sinclair/typebox@0.34.49 (which
// lacks it). Under ESM↔CJS interop, `import { TypeRegistry }` then resolves
// to `undefined`, and the unguarded top-level `TypeRegistry.Set(...)` crashed
// extension load: "Cannot read properties of undefined (reading 'Set')".
//
// We now feature-detect TypeRegistry and skip registration when it is absent;
// buildStringEnum() falls back to a verbose-but-validating anyOf-of-literals
// in that case, so the extension ALWAYS loads regardless of the store's
// typebox. buildStringEnum() is exported so unit tests cover BOTH branches.
// ─────────────────────────────────────────────────────────────────────────
const KIND = Symbol.for("TypeBox.Kind");

// Feature-detect TypeRegistry.Set (typebox >= 0.34.50). Guarded so a stale
// hoisted typebox (e.g. 0.34.49 in a shared npm store) cannot crash load.
export const HAS_TYPE_REGISTRY =
	typeof TypeRegistry === "object" && TypeRegistry !== null && typeof (TypeRegistry as { Set?: unknown }).Set === "function";

if (HAS_TYPE_REGISTRY) {
	TypeRegistry.Set("StringEnum", (schema, value) => {
		const s = schema as { enum?: unknown[] };
		return typeof value === "string" && Array.isArray(s.enum) && s.enum.includes(value);
	});
}

/**
 * Build a compact `{ type: "string", enum: [...] }` action-enum schema that
 * Value.Check can validate.
 *
 * - Registry branch (typebox >= 0.34.50): registered "StringEnum" kind →
 *   compact enum (EXT-7 optimization, ~600 chars).
 * - Fallback branch (stale hoisted typebox < 0.34.50): `anyOf` of
 * `Type.Literal`s → ~3x larger JSON but natively validating with no custom
 *   kind, so Value.Check still works. This is what keeps pi-crew loadable on
 *   installs whose shared store still carries an older @sinclair/typebox.
 *
 * `hasRegistry` is injectable so unit tests exercise BOTH branches against the
 * real typebox Type/Value (test/unit/schema/stringenum-typebox-guard.test.ts).
 *
 * Empty string is the unset marker (calling models emit "" for an omitted
 * action; the handler treats it as "list"). It must be a plain member so
 * JSON-Schema consumers (pi-ai validation) accept it without coercion.
 */
export function buildStringEnum(values: readonly string[], description: string, opts: { hasRegistry?: boolean } = {}): TSchema {
	const hasRegistry = opts.hasRegistry ?? HAS_TYPE_REGISTRY;
	if (hasRegistry) {
		return Type.Unsafe({ [KIND]: "StringEnum", type: "string", enum: ["", ...values], description });
	}
	return Type.Union([Type.Literal(""), ...values.map((v) => Type.Literal(v))], { description });
}

// ───────────────────────────────────────────────────────────────────────────
// API-5 facade split: the 54-action mega-tool schema is split into 5 domain
// schemas. Each domain owns a subset of the action union; all parameter fields
// are shared across every variant so Phase 1 validation is identical to the
// pre-split flat Object (additionalProperties: true → no tightening).
// `TeamToolParams` is re-exported as a TypeBox Union for backward compat.
// ───────────────────────────────────────────────────────────────────────────

const SkillOverride = Type.Union(
	[Type.String({ maxLength: 2048 }), Type.Array(Type.String({ maxLength: 80 }), { maxItems: 32 }), Type.Boolean()],
	{
		description:
			"Skill name(s) to add to role/default skills, an array of skill names, or false to disable all injected skills for this run.",
	},
);

// Freeform object: Type.Record + Any is TypeBox-native (no custom Unsafe kind),
// so Value.Check/Compile can walk it without throwing "Unknown type".
const FreeformConfig = Type.Record(Type.String(), Type.Any(), {
	description: "Resource config for management actions.",
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
		Type.Union([Type.Literal(""), Type.Literal("agent"), Type.Literal("team"), Type.Literal("workflow")], {
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
			// Empty string allowed: calling models emit "" for unset keys; the handler
			// treats it as omitted (see normalizeTeamParams in team-tool.ts).
			pattern: "^$|^[A-Za-z0-9_-]+$",
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
		Type.Union([Type.Literal(""), Type.Literal("single"), Type.Literal("worktree")], {
			description: "Workspace isolation mode. Worktree mode is planned after MVP.",
		}),
	),
	context: Type.Optional(
		Type.Union([Type.Literal(""), Type.Literal("fresh"), Type.Literal("fork")], {
			description: "Child context mode for workers.",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory override." })),
	model: Type.Optional(Type.String({ description: "Model override for direct runs." })),
	skill: Type.Optional(SkillOverride),
	scope: Type.Optional(
		Type.Union([Type.Literal(""), Type.Literal("user"), Type.Literal("project"), Type.Literal("both")], {
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
		// Boolean false accepted: calling models emit false for unset; treated as omitted.
		Type.Union([Type.Boolean(), Type.Integer({ minimum: 0 })], {
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
	replyDeadline: Type.Optional(
		// Allow the empty-string unset marker (models emit "" when no deadline is
		// set; pi-ai validateToolArguments runs BEFORE the handler and rejects a
		// bare Integer for ""). Mirror the other falsy-allowances (budgetTotal:0).
		Type.Union([Type.Literal(""), Type.Integer({ description: "Ms epoch deadline for a reply." })], {
			description: "Ms epoch deadline for a reply.",
		}),
	),
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
		// Boolean false accepted: calling models emit false for unset; treated as omitted.
		Type.Union([Type.Boolean(), Type.String(), Type.Number()], {
			description: "ISO timestamp or epoch ms for a one-time scheduled run.",
		}),
	),
	excludeContextBash: Type.Optional(
		Type.Boolean({
			description: "Mark certain bash commands as excludeFromContext to reduce context tokens (default: false).",
		}),
	),
	budgetTotal: Type.Optional(
		// 0 accepted as "unset/disabled" (models emit 0 for off); still rejects 1-999
		// as the MISCONFIGURATION GUARD against typo'd silent-abort configs.
		Type.Union(
			[
				Type.Literal(0),
				Type.Number({
					minimum: 1000,
				}),
			],
			{
				description:
					"Total token budget for the run. When set, enables budget tracking with default 80% warning and 95% abort thresholds. Minimum 1000 — this is a MISCONFIGURATION GUARD (catches typos / silent-abort configs like budgetTotal:1, which would abort on turn 1), NOT a usefulness guarantee; a productive multi-turn goal needs far more than 1000 tokens. 0 = unset.",
			},
		),
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
		Type.Union([Type.Literal(""), Type.Literal("team-run"), Type.Literal("goal-loop"), Type.Literal("dynamic-workflow")], {
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

const RUN_ACTIONS = ["run", "parallel", "plan", "orchestrate", "resume", "retry", "wait", "steer", "goal"] as const;
const runActions = Type.Optional(buildStringEnum(RUN_ACTIONS, ACTION_DESCRIPTION));

const STATUS_ACTIONS = [
	"status",
	"list",
	"get",
	"events",
	"artifacts",
	"summary",
	"graph",
	"search",
	"health",
	"worktrees",
	"checkpoint",
	"cache",
	"explain",
	"onboard",
	"recommend",
	"help",
] as const;
const statusActions = Type.Optional(buildStringEnum(STATUS_ACTIONS, ACTION_DESCRIPTION));

const CONTROL_ACTIONS = ["cancel", "invalidate", "respond", "cleanup", "prune", "forget", "doctor"] as const;
const controlActions = Type.Optional(buildStringEnum(CONTROL_ACTIONS, ACTION_DESCRIPTION));

const MANAGE_ACTIONS = [
	"create",
	"update",
	"delete",
	"init",
	"config",
	"validate",
	"autonomy",
	"settings",
	"workflow-create",
	"workflow-get",
	"workflow-list",
	"workflow-save",
	"workflow-delete",
	"import",
	"imports",
	"export",
] as const;
const manageActions = Type.Optional(buildStringEnum(MANAGE_ACTIONS, ACTION_DESCRIPTION));

const AUTOMATE_ACTIONS = ["schedule", "scheduled", "anchor", "auto-summarize", "auto_boomerang", "api"] as const;
const automateActions = Type.Optional(buildStringEnum(AUTOMATE_ACTIONS, ACTION_DESCRIPTION));

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
export const allActionLiterals = ([runActions, statusActions, controlActions, manageActions, automateActions] as TSchema[]).flatMap(
	(set) => {
		const literals =
			(set.anyOf as { const: string }[] | undefined) ??
			(Array.isArray(set.enum) ? set.enum.map((v: unknown) => ({ const: v })) : []) ??
			[];
		// buildStringEnum accepts "" as an unset marker for model callers; it is NOT
		// an action, so exclude it from the literal/type/suggestion derivations.
		return literals.filter((l) => l.const !== "");
	},
);

/**
 * EXT-8: Single source of truth for the valid `action` type. Derived from the
 * domain action arrays (the same arrays `allActionLiterals` reads), so the
 * `TeamToolParamsValue.action` interface field, schema enum, and suggestions
 * can never drift apart. Adding/removing an action in any `*_ACTIONS` array
 * propagates to every consumer automatically.
 */
export type TeamAction =
	| (typeof RUN_ACTIONS)[number]
	| (typeof STATUS_ACTIONS)[number]
	| (typeof CONTROL_ACTIONS)[number]
	| (typeof MANAGE_ACTIONS)[number]
	| (typeof AUTOMATE_ACTIONS)[number];

export const TeamToolParams = Type.Object(
	{
		action: Type.Optional(
			buildStringEnum(
				allActionLiterals.map((l) => (l as { const: string }).const),
				ACTION_DESCRIPTION,
			),
		),
		...sharedFields,
	},
	{ additionalProperties: true },
);

/** Domain discriminator for the facade dispatch. */
export type TeamDomain = "run" | "status" | "control" | "manage" | "automate";

export interface TeamToolParamsValue {
	action?: TeamAction;
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
