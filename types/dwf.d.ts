/**
 * Authoring types for pi-crew dynamic workflow scripts (`.dwf.ts`).
 *
 * Round-14 P1-1: gives TS users IDE IntelliSense for the `ctx` object passed to a
 * workflow script's `export default async function(ctx) { ... }`.
 *
 * pi-crew passes `ctx` as a parameter (NOT as ambient globals), so the types here are
 * named exports. Import them in your workflow script:
 *
 * ```ts
 * import type { WorkflowCtx } from "pi-crew/workflow";
 *
 * export default async function run(ctx: WorkflowCtx): Promise<void> {
 *   ctx.log("starting");
 *   const res = await ctx.agent({ role: "explorer", prompt: "look around" });
 *   ctx.setResult(res.artifactPath ?? "");
 * }
 * ```
 *
 * Alternatively, add a triple-slash reference so the package's type map is loaded:
 *
 * ```ts
 * /// <reference types="pi-crew/workflow" />
 * import type { WorkflowCtx } from "pi-crew/workflow";
 * ```
 *
 * These interfaces mirror the runtime types in `src/runtime/dynamic-workflow-context.ts`.
 * They are authoring-only (no runtime values); the real implementations live in the runner.
 */

export interface AgentCallOpts {
	prompt: string;
	/** Role name (resolved via 4-tier chain) OR explicit agent name. */
	role?: string;
	/** Explicit agent name — bypasses team-role lookup. */
	agent?: string;
	description?: string;
	model?: string;
	skill?: string[] | false;
	maxTurns?: number;
	graceTurns?: number;
	/** Dependency artifact paths injected into the agent prompt. */
	inputs?: string[];
	/** Disable ALL tools for this call (pure-judgment / verdict steps). */
	disableTools?: boolean;
	/** Override the resolved agent's system prompt. */
	systemPrompt?: string;
	/** Round-13: optional TypeBox schema. When set, output is validated; mismatch yields ok:false. */
	schema?: { readonly [key: string]: unknown };
}

export interface AgentResult {
	ok: boolean;
	text: string;
	structured?: unknown;
	usage?: { input?: number; output?: number; cost?: number; turns?: number };
	runId?: string;
	taskId?: string;
	artifactPath?: string;
	error?: string;
	durationMs?: number;
}

/** Round-14 P1-2: per-workflow token budget. */
export interface WorkflowBudget {
	/** Configured budget, or null when unbounded. */
	total: number | null;
	/** Tokens consumed so far (accumulated from each ctx.agent() run's usage). */
	spent(): number;
	/** Tokens remaining; Infinity when total is null. */
	remaining(): number;
}

export interface ReviewResult {
	outcome: "accept" | "reject" | "changes_requested";
	feedback: string;
}

/** Options for ctx.mail(). */
export interface MailOpts {
	kind?: string;
	taskId?: string;
	replyTo?: string;
	replyDeadline?: number;
}

/** Options for ctx.review(). */
export interface ReviewOpts {
	content?: string;
	artifactPath?: string;
	disableTools?: boolean;
}

/** Options for ctx.retry(). */
export interface RetryOpts {
	feedback?: string;
}

/**
 * The capability-locked context object passed to a `.dwf.ts` script's
 * `export default async function(ctx)`. Exposes ONLY the documented methods —
 * no raw manifest/process/require leaks.
 *
 * NOTE: v1 has NO vm sandbox; the script CAN reach process/require directly.
 * The frozen ctx is a contract surface, not a security boundary. `.dwf.ts`
 * scripts are postinstall-equivalent trust.
 */
export interface WorkflowCtx {
	cwd: string;
	runId: string;
	goal?: string;
	/** Script-local persistent variables. */
	vars: Record<string, unknown>;
	/** Abort signal (cancel/stop). */
	signal: AbortSignal;
	/** Concurrency semaphore (bounded by ctx concurrency). */
	semaphore: import("../src/runtime/semaphore").Semaphore;

	/** Spawn one agent, await result. Concurrency enforced by ctx.semaphore. */
	agent(opts: AgentCallOpts): Promise<AgentResult>;
	/** Bounded fan-out preserving order. */
	fanOut<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<AgentResult>): Promise<AgentResult[]>;
	/** Pipeline: sequential per-item stages, parallel across items (bounded by ctx.semaphore).
	 *  Failed stage → null for that item (logged); other items continue. round-16 (P2-1). */
	pipeline<TItem, TResult = unknown>(
		items: TItem[],
		...stages: Array<(previous: TResult, original: TItem, index: number) => Promise<TResult> | TResult>
	): Promise<(TResult | null)[]>;
	/** Run a reviewer agent over an artifact; parse {outcome, feedback}. */
	review(taskId: string, reviewerRole?: string, opts?: ReviewOpts): Promise<ReviewResult>;
	/** Re-run a task with feedback (wraps executeWithRetry). */
	retry(taskId: string, opts?: RetryOpts): Promise<AgentResult>;
	/** Send a mailbox message to another agent/leader. Returns the message id. */
	mail(to: string, body: string, opts?: MailOpts): string;
	/** Block until N mailbox replies arrive or deadline. */
	gatherReplies(messageIds: string[], deadlineMs: number): Promise<unknown[]>;
	/** Render a built-in plan template (full-implementation / standard-review). */
	renderTemplate(name: string, vars: Record<string, string>): unknown;
	/** Mark the final result. ONLY this artifact reaches the main context. */
	setResult(artifactPath: string, meta?: Record<string, unknown>): void;
	/** Round-12: mark the start of a named workflow phase (emits dwf.phase_started/_completed). Idempotent on the same title. */
	phase(title: string): void;
	/** Round-14 P1-3: append a workflow-level log line (emits a dwf.log event). */
	log(message: unknown): void;
	/** Round-14 P1-2: per-workflow token budget; ctx.agent() auto-rejects when exhausted. */
	budget: WorkflowBudget;
	/** Round-14 P1-5: typed workflow arguments (sourced from manifest.args). Defaults to {}. */
	args<T = unknown>(): T;
}

export {};
