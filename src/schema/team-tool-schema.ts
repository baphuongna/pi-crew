import { Type } from "typebox";

const SkillOverride = Type.Unsafe({
	description: "Skill name(s) to inject, array of skill names, or false to disable role defaults.",
	anyOf: [
		{ type: "string" },
		{ type: "array", items: { type: "string" } },
		{ type: "boolean" },
	],
});

const FreeformConfig = Type.Unsafe({
	description: "Resource config for management actions.",
	type: "object",
	additionalProperties: true,
});

export const TeamToolParams = Type.Object({
	action: Type.Optional(Type.Union([
		Type.Literal("run"),
		Type.Literal("plan"),
		Type.Literal("status"),
		Type.Literal("list"),
		Type.Literal("get"),
		Type.Literal("cancel"),
		Type.Literal("resume"),
		Type.Literal("respond"),
		Type.Literal("create"),
		Type.Literal("update"),
		Type.Literal("delete"),
		Type.Literal("doctor"),
		Type.Literal("cleanup"),
		Type.Literal("events"),
		Type.Literal("artifacts"),
		Type.Literal("worktrees"),
		Type.Literal("forget"),
		Type.Literal("summary"),
		Type.Literal("prune"),
		Type.Literal("export"),
		Type.Literal("import"),
		Type.Literal("imports"),
		Type.Literal("help"),
		Type.Literal("validate"),
		Type.Literal("config"),
		Type.Literal("init"),
		Type.Literal("recommend"),
		Type.Literal("autonomy"),
		Type.Literal("api"),
		Type.Literal("settings"),
	], { description: "Team action. Defaults to 'list' when omitted." })),
	resource: Type.Optional(Type.Union([
		Type.Literal("agent"),
		Type.Literal("team"),
		Type.Literal("workflow"),
	], { description: "Resource kind for get/create/update/delete/list. Defaults to all for list." })),
	team: Type.Optional(Type.String({ description: "Team name, e.g. default or implementation." })),
	workflow: Type.Optional(Type.String({ description: "Workflow name, e.g. default or review." })),
	role: Type.Optional(Type.String({ description: "Role name to run directly within a team." })),
	agent: Type.Optional(Type.String({ description: "Agent name to inspect or run directly." })),
	goal: Type.Optional(Type.String({ description: "High-level objective for a team run." })),
	task: Type.Optional(Type.String({ description: "Concrete task text for direct role/agent execution." })),
	runId: Type.Optional(Type.String({ description: "Run ID for status, cancel, or resume." })),
	taskId: Type.Optional(Type.String({ description: "Task ID for respond action." })),
	message: Type.Optional(Type.String({ description: "Message for respond action." })),
	async: Type.Optional(Type.Boolean({ description: "Run in background when execution support is enabled." })),
	workspaceMode: Type.Optional(Type.Union([
		Type.Literal("single"),
		Type.Literal("worktree"),
	], { description: "Workspace isolation mode. Worktree mode is planned after MVP." })),
	context: Type.Optional(Type.Union([
		Type.Literal("fresh"),
		Type.Literal("fork"),
	], { description: "Child context mode for workers." })),
	cwd: Type.Optional(Type.String({ description: "Working directory override." })),
	model: Type.Optional(Type.String({ description: "Model override for direct runs." })),
	skill: Type.Optional(SkillOverride),
	scope: Type.Optional(Type.Union([
		Type.Literal("user"),
		Type.Literal("project"),
		Type.Literal("both"),
	], { description: "Resource scope for discovery or management." })),
	config: Type.Optional(FreeformConfig),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview a management mutation without writing files." })),
	confirm: Type.Optional(Type.Boolean({ description: "Required for destructive management actions." })),
	force: Type.Optional(Type.Boolean({ description: "Override reference checks for destructive management actions." })),
	keep: Type.Optional(Type.Integer({ minimum: 0, description: "Number of finished runs to keep for prune." })),
	updateReferences: Type.Optional(Type.Boolean({ description: "When renaming agents or workflows, update team references in the same project/user scope." })),
});

export interface TeamToolParamsValue {
	action?: "run" | "plan" | "status" | "list" | "get" | "cancel" | "resume" | "respond" | "create" | "update" | "delete" | "doctor" | "cleanup" | "events" | "artifacts" | "worktrees" | "forget" | "summary" | "prune" | "export" | "import" | "imports" | "help" | "validate" | "config" | "init" | "recommend" | "autonomy" | "api" | "settings";
	resource?: "agent" | "team" | "workflow";
	team?: string;
	workflow?: string;
	role?: string;
	agent?: string;
	goal?: string;
	task?: string;
	runId?: string;
	taskId?: string;
	message?: string;
	async?: boolean;
	workspaceMode?: "single" | "worktree";
	context?: "fresh" | "fork";
	cwd?: string;
	model?: string;
	skill?: string | string[] | boolean;
	scope?: "user" | "project" | "both";
	config?: Record<string, unknown>;
	dryRun?: boolean;
	confirm?: boolean;
	force?: boolean;
	keep?: number;
	updateReferences?: boolean;
}
