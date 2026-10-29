/**
 * dynamic-workflow-context.ts — WorkflowCtx facade for dynamic-workflow scripts (P2).
 *
 * Spec: research-findings/goal-workflow/00-SPEC.md §3.2
 * Plan: 07-PLAN.md v3 P2 + §0b G4 + §0c C4/C5/C7.
 *
 * The `ctx` object passed to a `.dwf.ts` script's `export default async function(ctx)`.
 * Capability-locked: exposes ONLY the documented methods (no raw manifest/process/require).
 * The script host (dynamic-workflow-runner.ts) loads the script via jiti in plain module
 * scope with a FROZEN WorkflowCtx. v1 has NO vm sandbox (review H-2): the script CAN
 * reach `process`/`require`/`import` directly — the frozen ctx is a contract surface,
 * not a security boundary. `.dwf.ts` = postinstall-equivalent trust. isolated-vm v1.5.
 *
 * `agent()` resolution (§0b G4): 4-tier precedence
 *   1. opts.agent (explicit name) — bypasses team lookup
 *   2. team.roles.find(r => r.name === role)?.agent → allAgents lookup
 *   3. allAgents(discoverAgents(cwd)).find(a => a.name === role)  (role name == agent name)
 *   4. synthesize minimal AgentConfig (source:"dynamic", systemPrompt:"You are {role}.")
 *
 * Isolation (§0b G3 / report 05 §C.4): worker output → artifact file; `agent()` returns
 * structured data + writes a side artifact. The script holds results in JS vars; only
 * `setResult()` reaches the main context.
 */

import { randomBytes } from "node:crypto";
import type { TSchema } from "@sinclair/typebox";
import type { AgentConfig } from "../../agents/agent-config.ts";
import { allAgents, discoverAgents } from "../../agents/discover-agents.ts";
import { renderInboxMessage } from "../../prompt/prompt-runtime.ts";
import { appendMailboxMessage, type MailboxMessage, readMailbox } from "../../state/coordination/mailbox.ts";
import { appendEvent } from "../../state/event-log/event-log.ts";
import { writeArtifact } from "../../state/stores/artifact-store.ts";
import type { TeamRunManifest } from "../../state/types.ts";
import type { TeamConfig } from "../../teams/team-config.ts";
import { logInternalError } from "../../utils/internal-error.ts";
import { safeAbort } from "../../utils/safe-abort.ts";
import { countTokens } from "../../utils/token-counter.ts";
import { cleanupAgentWorktreeAsync, prepareAgentWorktreeAsync } from "../../worktree/worktree-manager.ts";
import type { ChildPiRunResult } from "../child-pi/child-pi.ts";
import { DWF_CHECKPOINT_VERSION, type DwfCheckpointState } from "../dwf-state-store.ts";
import { type ParsedPiJsonOutput, parsePiJsonOutput } from "../output/pi-json-output.ts";
import { extractStructuredResult } from "../output/result-extractor.ts";
import { executeWithRetry } from "../recovery/retry-executor.ts";
import { runWorker } from "../run-worker.ts";
import { mapConcurrent } from "../scheduling/parallel-utils.ts";
import { Semaphore } from "../scheduling/semaphore.ts";
import { renderPlanTemplate } from "./plan-templates.ts";

export interface AgentCallOpts {
	prompt: string;
	/** Role name (resolved via G4 4-tier chain) OR explicit agent name. */
	role?: string;
	/** Explicit agent name — bypasses team-role lookup (tier 1). */
	agent?: string;
	description?: string;
	model?: string;
	skill?: string[] | false;
	maxTurns?: number;
	graceTurns?: number;
	/** Dependency artifact paths injected into the agent prompt. */
	inputs?: string[];
	/** Disable ALL tools for this call (Pi `--no-tools`, §0c C6). Use for pure-judgment /
	 *  verdict steps where the agent must answer directly without exploring, e.g.
	 *  `ctx.review()`'s JSON-verdict call. Without this, role-based tools (read/grep/bash)
	 *  apply and the model may loop exploring instead of answering. */
	disableTools?: boolean;
	/** Override the resolved agent's system prompt. Use when the call needs a different
	 *  persona/output-format than the role's defined agent — e.g. `ctx.review()` needs a
	 *  JSON-verdict judge, but the user's reviewer.md agent is a markdown code-reviewer.
	 *  When set, the resolved agent's systemPrompt is replaced entirely. */
	systemPrompt?: string;
	/** Round-13 P0-3: optional TypeBox schema. When set, the call's output is validated
	 *  against the schema after extraction. Validation failure yields ok:false with a
	 *  structured `error` and undefined `structured` field. Forward-compatible: when
	 *  undefined, behavior is identical to the regex-based extractor. */
	schema?: TSchema;
	/** round-17 P2-4: spawn this agent in an isolated git worktree.
	 *  Useful when parallel agents modify files concurrently (avoids conflicts). The
	 *  worktree is created from HEAD, the agent runs there, and on completion the
	 *  diff is captured as an artifact before cleanup. Default false.
	 *  If worktree creation fails (no git repo, dirty leader), the agent runs in the
	 *  normal cwd and a warning is logged via ctx.log(). Backward compatible —
	 *  omitting it is identical to `false`. */
	worktree?: boolean;
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

/** round-14 P1-2: per-workflow token budget. Frozen read-only surface exposed as ctx.budget. */
export interface WorkflowBudget {
	/** Configured budget, or null when unbounded. */
	total: number | null;
	/** Tokens consumed so far (accumulated from each ctx.agent() run's usage). */
	spent(): number;
	/** Tokens remaining; Infinity when total is null. */
	remaining(): number;
}

/** SDD-3 W-C G13: default cap on ctx.agent() invocations per DWF run.
 *
 * Rationale: the largest real workflows observed (distill pipelines, adaptive
 * plans) use ~10-40 agent calls; 200 gives ≥5× headroom so a legitimate run
 * never trips it. Cost-wise 200 calls × ~5k tokens/call bounds a no-budget run
 * to roughly a million tokens — an explainable blast radius. For real spawns
 * the 30-min script timeout usually binds first; this cap's job is the
 * no-budget runaway class, which previously had NO bound on the number of
 * spawned steps and died only via the blind timeout (upgrade plan §2 G13). */
export const DEFAULT_MAX_AGENT_CALLS = 200;

/** SDD-3 W-C G13: structured termination error thrown when the agent-call cap trips.
 * Propagates out of ctx.agent() (and therefore out of the .dwf.ts script unless
 * the script catches it) so the runner fails the run with a structured reason
 * (dwf.failed) instead of waiting out the blind script timeout. */
export class DwfAgentCallCapError extends Error {
	/** Effective cap that was tripped. */
	readonly limit: number;
	/** Completed agent() invocations when the cap tripped. */
	readonly used: number;
	constructor(limit: number, used: number) {
		super(`dynamic workflow agent-call cap reached (${used}/${limit} calls; raise the run's maxAgentCalls to allow more)`);
		this.name = "DwfAgentCallCapError";
		this.limit = limit;
		this.used = used;
	}
}

/** R6-10 (DR-03 round-6, 2026-10-16): typed bridge error thrown INSIDE ctx.retry()
 *  when ctx.agent() resolves ok:false. executeWithRetry retries THROWN errors
 *  only, so an ok:false result previously flowed straight out of ctx.retry —
 *  a 1-attempt "retry" for every failure class except DwfAgentCallCapError.
 *  Throwing this wrapper makes the failure retryable; ctx.retry catches it after
 *  exhaustion and returns the CARRIED AgentResult, so ctx.retry's public return
 *  type/shape is unchanged. DwfAgentCallCapError keeps its passthrough semantics
 *  (the cap must terminate the workflow, never be retried into silence). */
export class DwfRetryFailure extends Error {
	/** The ok:false AgentResult the failed attempt produced. */
	readonly result: AgentResult;
	constructor(result: AgentResult) {
		super(result.error ?? "dynamic workflow retry: agent call returned ok:false");
		this.name = "DwfRetryFailure";
		this.result = result;
	}
}

/** R6-7 (DR-03 round-6, 2026-10-16): DWF empty-settle gate WITH the sibling
 *  exemptions the task-runner's attemptErrorFor (child-executor.ts:428-431) has
 *  but ctx.agent()'s inline gate lacked. Returns the structured 429-style error
 *  string when the worker settled without a final answer AND the exemptions do
 *  NOT apply, else undefined (gate passes):
 *  - patches are real work: coder roles may legitimately end patch-only
 *    (empty final assistant message is fine when the diff already landed);
 *  - cancelled/aborted attempts are excluded so an abort never surfaces as an
 *    upstream-rate-limit failure (and never burns fallback/retry budget on it).
 *  Mirrors child-executor.ts exactly — extracted so the exemptions are unit-testable
 *  at this seam (the mock-fixture layer cannot synthesise patch/cancelled shapes). */
export function dwfSettledWithoutAnswerFailure(
	childResult: Pick<ChildPiRunResult, "exitStatus">,
	parsed: Pick<ParsedPiJsonOutput, "settledWithoutAnswer" | "patches">,
): string | undefined {
	if (parsed.settledWithoutAnswer !== true) return undefined;
	if ((parsed.patches?.length ?? 0) > 0) return undefined;
	if (childResult.exitStatus?.cancelled) return undefined;
	return "Model settled without a final answer (empty final assistant message; upstream rate-limit/429 exhaustion)";
}

export interface WorkflowCtx {
	cwd: string;
	runId: string;
	goal?: string;
	/** Spawn one agent, await result. Concurrency enforced by ctx.semaphore. */
	agent(opts: AgentCallOpts): Promise<AgentResult>;
	/** Bounded fan-out preserving order (wraps mapConcurrent). */
	fanOut<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<AgentResult>): Promise<AgentResult[]>;
	/** Pipeline: sequential per-item stages, parallel across items (bounded by
	 *  ctx.semaphore). Each item passes through all stages in order; different
	 *  items may run concurrently. A failed stage yields `null` for that item
	 *  (logged via ctx.log) and other items continue. Aborts propagate.
	 *  round-16 (P2-1). */
	pipeline<TItem, TResult = unknown>(
		items: TItem[],
		...stages: Array<(previous: TResult, original: TItem, index: number) => Promise<TResult> | TResult>
	): Promise<(TResult | null)[]>;
	/** Run a reviewer agent over an artifact; parse {outcome, feedback}. §3.2. */
	review(
		taskId: string,
		reviewerRole?: string,
		opts?: {
			content?: string;
			artifactPath?: string;
			disableTools?: boolean;
		},
	): Promise<{
		outcome: "accept" | "reject" | "changes_requested";
		feedback: string;
	}>;
	/** Re-run a task with feedback (wraps executeWithRetry). */
	retry(taskId: string, opts?: { feedback?: string }): Promise<AgentResult>;
	/** Send a mailbox message to another agent/leader. */
	mail(
		to: string,
		body: string,
		opts?: {
			kind?: string;
			taskId?: string;
			replyTo?: string;
			replyDeadline?: number;
		},
	): string;
	/** Block until N mailbox replies arrive or deadline. ~10 LOC net-new (report 05 §G.4). */
	gatherReplies(messageIds: string[], deadlineMs: number): Promise<unknown[]>;
	/** Render a built-in plan template (full-implementation / standard-review). */
	renderTemplate(name: string, vars: Record<string, string>): unknown;
	/** Persistent variables (revived intermediate-store). */
	vars: Record<string, unknown>;
	/** Mark the final result. ONLY this artifact reaches the main context. */
	setResult(artifactPath: string, meta?: Record<string, unknown>): void;
	/** Mark the start of a named workflow phase. Emits a `dwf.phase_started` event
	 *  (and a `dwf.phase_completed` for the previous phase, if any) to the run's
	 *  events.jsonl. Idempotent on the same title — calling twice with the same
	 *  title is a no-op. Phase titles are in-memory only; the events log is the
	 *  durable source of truth for phase boundaries. */
	phase(title: string): void;
	/** round-14 P1-3: append a workflow-level log line. Persists to events.jsonl
	 *  as a `dwf.log` event and keeps a bounded in-memory copy (capped at 1000). */
	log(message: unknown): void;
	/** round-14 P1-2: per-workflow token budget. ctx.agent() auto-rejects with
	 *  ok:false once exhausted. */
	budget: WorkflowBudget;
	/** round-14 P1-5: typed workflow arguments. Reads the value passed via
	 *  MakeWorkflowCtxOptions.args (sourced from manifest.args). Defaults to {}
	 *  when unset. */
	args<T = unknown>(): T;
	semaphore: Semaphore;
	/** Abort signal (cancel/stop). */
	signal: AbortSignal;
}

export interface MakeWorkflowCtxOptions {
	concurrency?: number;
	signal: AbortSignal;
	team?: TeamConfig;
	modelOverride?: string;
	/** round-14 P1-2: per-workflow token budget. null/undefined = unbounded. */
	tokenBudget?: number | null;
	/** SDD-3 W-C G13: cap on ctx.agent() invocations (new spawns AND cached
	 *  replays) per run. null/undefined = DEFAULT_MAX_AGENT_CALLS — a run is
	 *  always bounded even with no tokenBudget configured. */
	maxAgentCalls?: number | null;
	/** round-14 P1-5: typed workflow arguments (sourced from manifest.args). Defaults to {}. */
	args?: unknown;
	/** round-18 P2-3: checkpoint state to hydrate ctx with on resume. When provided,
	 *  the ctx starts with the resumed vars/phases/logs/spent/agentCount instead of
	 *  empty defaults. Omit (or undefined) for a fresh run — backward compatible. */
	resumedState?: DwfCheckpointState;
	/** round-18 P2-3: callback invoked after each `ctx.agent()` call completes
	 *  (success OR fail). The runner wires this to `DwfStore.save()` so a crash after
	 *  an agent call leaves a durable checkpoint. Best-effort — failures are swallowed
	 *  so checkpointing can never crash the workflow. */
	onCheckpoint?: (state: DwfCheckpointState) => void;
}

/**
 * Resolve a role/agent name to a full AgentConfig (§0b G4 4-tier precedence).
 * Module-local — NOT promoted to a shared module (keeps P2 isolated from the
 * load-bearing team-runner path).
 */
export function resolveAgentForRole(
	roleName: string | undefined,
	opts: { explicitAgent?: string; team?: TeamConfig; cwd: string },
): AgentConfig {
	const cwd = opts.cwd;
	// Tier 1: explicit agent name.
	if (opts.explicitAgent) {
		const found = allAgents(discoverAgents(cwd)).find((a) => a.name === opts.explicitAgent);
		if (found) return found;
		// Fall through to synthesize if the named agent doesn't exist (P2-friendly).
	}
	// Tier 2: team.roles[].agent lookup.
	if (opts.team) {
		const role = opts.team.roles.find((r) => r.name === roleName);
		if (role) {
			const byAgentName = allAgents(discoverAgents(cwd)).find((a) => a.name === role.agent);
			if (byAgentName) return byAgentName;
		}
	}
	// Tier 3: discoverAgents by role name (role name == agent name).
	if (roleName) {
		const byRoleName = allAgents(discoverAgents(cwd)).find((a) => a.name === roleName);
		if (byRoleName) return byRoleName;
	}
	// Tier 4: synthesize a minimal AgentConfig.
	const name = opts.explicitAgent ?? roleName ?? "executor";
	return synthesizeAgentConfig(name);
}

/** Synthesize a minimal AgentConfig (§0c C7: source:"dynamic", not "synthetic"). */
export function synthesizeAgentConfig(name: string, model?: string): AgentConfig {
	return {
		name,
		description: `Synthesized agent for dynamic workflow (${name}).`,
		source: "dynamic",
		filePath: `<dynamic-workflow>`,
		systemPrompt: `You are ${name}, an agent in a dynamic pi-crew workflow. Use the provided tools (read, grep, find, ls, bash) to investigate the target and produce concrete written findings. Do not return an empty response — always output substantive content for your task.`,
		model,
		// Round-N fix: give synthesized agents the STANDARD file-investigation toolkit
		// (matches real built-in agents). Previously tools:[] relied on pi-args default
		// behavior, which left most synthesized agents (explorer/analyst/critic/executor)
		// unable to read the codebase → 10/11 agents returned empty/!ok in distill-dwf runs.
		tools: ["read", "grep", "find", "ls", "bash"],
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

/** Build the WorkflowCtx facade. Capability-locked: only documented methods exposed. */
export function makeWorkflowCtx(manifest: TeamRunManifest, opts: MakeWorkflowCtxOptions): WorkflowCtx {
	const concurrency = Math.max(1, opts.concurrency ?? 4);
	const semaphore = new Semaphore(concurrency);
	let finalResult: { artifactPath: string; meta?: Record<string, unknown> } | undefined;
	// SDD-3 W-C G13: effective agent-call cap. Always ≥ 1 — omitting every knob
	// still leaves the run bounded (default DEFAULT_MAX_AGENT_CALLS). A cap error
	// aborts capController below so in-flight children are killed and pipeline()
	// rethrows the cap error instead of swallowing it into a null item.
	const maxAgentCalls =
		typeof opts.maxAgentCalls === "number" && Number.isFinite(opts.maxAgentCalls) && opts.maxAgentCalls >= 1
			? Math.floor(opts.maxAgentCalls)
			: DEFAULT_MAX_AGENT_CALLS;
	const capController = new AbortController();
	// G13: combine the caller's signal with the cap controller so EITHER source
	// (external abort OR cap trip) reaches runWorker and ctx.signal consumers.
	// AbortSignal.any is available since Node 20.3 (project requires Node 22+);
	// an already-aborted input yields an already-aborted combined signal.
	const ctxSignal = AbortSignal.any([opts.signal, capController.signal]);
	// round-18 P2-3: agent invocation counter. Hydrated from a resumed checkpoint so a
	// resumed run keeps an accurate count; incremented in agent()'s finally block.
	let agentCount = opts.resumedState ? opts.resumedState.agentCount : 0;
	// round-12 P0-1: in-memory phase state, exposed via non-enumerable getter like __finalResult.
	// The events log is the durable source of truth for phase boundaries.
	// round-18 P2-3: hydrate phaseState from a resumed checkpoint (backward compatible when unset).
	const phaseState: { currentPhase: string | undefined; phases: string[] } = opts.resumedState
		? {
				currentPhase: opts.resumedState.currentPhase,
				phases: [...opts.resumedState.phases],
			}
		: { currentPhase: undefined, phases: [] };
	let phaseCapWarned = false;
	// R6-12 (DR-03 round-6): phases already recorded in the hydrated checkpoint.
	// ctx.phase() does NOT re-emit phase_started/phase_completed for these on a
	// resumed run — the script re-executes from the top and re-walks its phase
	// history; without this guard every replayed phase title re-emitted its events
	// (duplicated phase boundaries in events.jsonl). Empty on a fresh run, so the
	// guard is resume-only: a fresh script may still legitimately re-enter a title
	// later (e.g. phase("review") rounds) and get its events.
	const hydratedPhases = new Set<string>(opts.resumedState?.phases ?? []);
	// round-14 P1-2/P1-3/P1-5: closure-scoped runtime state shared by budget/log/args.
	// Mirrors the pi-dynamic-workflows RuntimeState pattern (workflow.ts:state).
	// round-18 P2-3: hydrate spent/logs from a resumed checkpoint (backward compatible when unset).
	const wfState: { spent: number; logs: string[]; args: unknown } = {
		spent: opts.resumedState?.spent ?? 0,
		logs: opts.resumedState ? [...opts.resumedState.logs].slice(0, 1000) : [],
		args: opts.args ?? {},
	};
	// PERS-1: per-agent-call idempotency cache. Hydrated from resumedState so a DWF
	// resume skips already-completed agent calls (avoids duplicating artifacts/mailbox/tokens).
	// Uses Record (not Map) for JSON serialization safety. R6-3 (DR-03 round-6):
	// values are the FULL AgentResult (text + usage + structured + artifactPath +
	// actual durationMs) so replay does not drop structured output / artifact linkage.
	const completedAgentCalls: Record<string, AgentResult> = opts.resumedState?.completedAgentCalls ?? {};
	// R2-M-B5 + R5-M-A2 (Wave-3): the identical-call cache is RESUME-ONLY.
	// Only calls HYDRATED from resumedState (this Set) are eligible for a
	// cache hit; results added during a LIVE run are still recorded for a
	// future resume's checkpoint, but identical call options within the SAME
	// run RE-SPAWN. The previous within-run hit made the documented
	// `while(true){review; if accept break; retry}` loop replay round-1's
	// verdict forever (stale-verdict hazard, docs/dynamic-workflows.md).
	const hydratedCallIds = new Set<string>(Object.keys(opts.resumedState?.completedAgentCalls ?? {}));
	// W1b binding (security fix gatherreplies-replyto-only-binding): messageId →
	// expected addressee, recorded when ctx.mail() issues each mail. gatherReplies
	// only accepts a reply row when its broker-authenticated sender (m.from)
	// equals the expected addressee of the mail the reply claims (m.replyTo) — a
	// forged replyTo from any other task cannot enter the reply stream.
	const mailedAddressees = new Map<string, string>();
	const unresolvedMailLookups = new Set<string>();
	// Resolve the expected addressee for a mailed id, falling back to the run
	// outbox ONCE per unknown id (resume path: mails sent by a previous process
	// of the same workflow are not in the in-memory map; their outbox rows are
	// host-written — workers cannot append to the outbox lane — so the recorded
	// `to` is a trusted binding source. Inbox rows are never consulted).
	const expectedReplyAddressee = (messageId: string): string | undefined => {
		const known = mailedAddressees.get(messageId);
		if (known !== undefined) return known;
		if (unresolvedMailLookups.has(messageId)) return undefined;
		unresolvedMailLookups.add(messageId);
		const mailed = readMailbox(manifest, "outbox").find((m) => m.id === messageId && m.from === "dynamic-workflow" && m.to);
		if (mailed?.to) mailedAddressees.set(messageId, mailed.to);
		return mailedAddressees.get(messageId);
	};
	// round-14 P1-2: frozen budget surface. The closures read wfState.spent so the
	// object stays live after Object.freeze(ctx). total is a snapshot primitive.
	const budget = Object.freeze({
		total: opts.tokenBudget ?? null,
		spent: () => wfState.spent,
		remaining: () => (opts.tokenBudget == null ? Infinity : Math.max(0, opts.tokenBudget - wfState.spent)),
	} satisfies WorkflowBudget);

	const ctx: WorkflowCtx = {
		cwd: manifest.cwd,
		runId: manifest.runId,
		goal: manifest.goal,
		signal: ctxSignal,
		semaphore,
		async agent(call: AgentCallOpts): Promise<AgentResult> {
			await semaphore.acquire();
			const started = Date.now();
			// round-17 P2-4: declared before the try so the finally can clean it up
			// regardless of which return/throw path is taken.
			let worktreePath: string | undefined;
			let worktreeBranch: string | undefined;
			// BDG-2 + G14 (SDD-3): content-based reserve estimate — replaces the flat
			// ESTIMATE=4096. countTokens() (R5-7, DR-02 round-5: the in-tree
			// CJK-aware estimator from utils/token-counter.ts — replaces the chars/4
			// estimateTokens call, which under-counted CJK/Vietnamese-diacritic
			// prompts ~2-3x and could let N concurrent calls blow past the budget)
			// runs over the call's prompt + optional systemPrompt override, floored
			// at 512 tokens for the fixed per-call overhead (schema/JSON directive,
			// artifact headers) not present in the prompt string. Short calls stop
			// over-reserving; very long prompts reserve proportionally so N
			// concurrent calls cannot blow past the budget between reserve and the
			// post-run adjust. Every BDG-2 site below (check/reserve/un-reserve/
			// adjust/refund) uses THIS value, so refund always matches what was
			// reserved.
			const estimate = Math.max(512, countTokens(`${call.prompt ?? ""}${call.systemPrompt ?? ""}`));
			let reserved = false;
			try {
				// SDD-3 W-C G13: agent-call cap — the structured bound for no-budget runs.
				// Checked BEFORE the PERS-1 cache lookup on purpose: cached replays are
				// free but must still count, so a spin loop over the same prompt cannot
				// bypass the cap (the default 200 leaves ≥5× headroom over the largest
				// real workflows, so resume replays never trip it legitimately). Counts
				// completed invocations; up to concurrency-1 extra calls may already be
				// in flight when it trips (they are killed by the cap abort below).
				if (agentCount >= maxAgentCalls) {
					// Durable record (dwf.log is the registered workflow-log event type).
					// U2 (2026-10-10): kept SYNC — ctx closures are exercised DIRECTLY by
					// unit tests that readEvents() synchronously right after the call
					// (dynamic-workflow-context.test.ts rounds 12/14/18); no await boundary
					// exists between a ctx call and those readers. The runner-level
					// lifecycle events (dwf.started/completed/failed) ARE migrated —
					// awaited appendEventAsync in dynamic-workflow-runner.ts.
					appendEvent(manifest.eventsPath, {
						type: "dwf.log",
						runId: manifest.runId,
						data: {
							message: `agent-call cap reached: ${agentCount}/${maxAgentCalls} — terminating workflow (raise maxAgentCalls to allow more)`,
							limit: maxAgentCalls,
							used: agentCount,
						},
					});
					// Kill in-flight children + make pipeline()/gatherReplies() see the abort.
					safeAbort(capController, "dwf-agent-call-cap");
					throw new DwfAgentCallCapError(maxAgentCalls, agentCount);
				}
				// PERS-1: per-agent-call idempotency. Compute a deterministic call ID
				// from the call arguments and check if this call was already completed
				// in a PREVIOUS run (hydrated from resumedState — R2-M-B5: resume-only;
				// identical calls within a LIVE run re-spawn). If hydrated, return the
				// cached result without re-spawning the agent.
				// R6-3 (DR-03 round-6, HIGH): the key now covers ALL call-shaping fields
				// (inputs/systemPrompt/disableTools/maxTurns/graceTurns/worktree/skill/…
				// and the schema BY VALUE) — previously only {role,agent,prompt,model,
				// schema:"yes"/"no"}, so two DIFFERENT calls sharing those 5 fields hit the
				// same cache entry on EVERY call (e.g. same prompt with different inputs
				// returned the first call's result — inputs provably alter the dispatched
				// task via composeAgentTask). See computeCallId for the normalization.
				const callId = computeCallId(call);
				const cached = hydratedCallIds.has(callId) ? completedAgentCalls[callId] : undefined;
				if (cached) {
					// Full-result replay (R6-3): structured + artifactPath survive the
					// round-trip through the checkpoint. ok is forced true — only successful
					// results are cached, and legacy (pre-R6-3) hydrated records lack the field.
					return { ...cached, ok: true };
				}

				// BDG-2: reserve-then-adjust budget. Before spawning, estimate the cost and
				// reserve it by adding to wfState.spent. This prevents N concurrent calls from
				// all seeing the same remaining budget and overspending.
				if (budget.total !== null && budget.remaining() < estimate) {
					return {
						ok: false,
						text: "",
						error: "workflow token budget exhausted",
						durationMs: 0,
					};
				}
				// Reserve the estimate before spawning.
				wfState.spent += estimate;
				reserved = true;

				const agentConfig = resolveAgentForRole(call.role, {
					explicitAgent: call.agent,
					team: opts.team,
					cwd: manifest.cwd,
				});
				// §0c C6: per-call disableTools override. When set, force Pi `--no-tools` so the
				// agent answers directly without exploring. Applied AFTER role resolution so it
				// wins over any role-defined tools.
				let effectiveAgent = call.disableTools === true ? { ...agentConfig, disableTools: true, tools: [] } : agentConfig;
				// Per-call systemPrompt override (replaces the resolved agent's persona/output-format).
				// Used by ctx.review() to force a JSON-verdict judge instead of the role's markdown reviewer.
				// Round-13 P0-3: when a schema is provided, append a JSON-output instruction so
				// the model returns parseable JSON instead of prose. Schema name is intentionally
				// generic — we don't reveal TypeBox internal types.
				//
				// Smoke-test fix: when BOTH schema AND an explicit call.systemPrompt are set,
				// the call.systemPrompt is the caller's intended persona (e.g. a JSON-verdict
				// judge). It MUST be used as the base for the JSON instruction — otherwise the
				// role's persona leaks through and the model returns prose, failing schema
				// validation. Previously call.systemPrompt was silently dropped when a schema
				// was present, which confused models into returning text like "hello".
				if (call.schema !== undefined) {
					const base = call.systemPrompt ?? effectiveAgent.systemPrompt;
					effectiveAgent = {
						...effectiveAgent,
						systemPrompt: composeSchemaSystemPrompt(base, call.schema),
					};
				} else if (call.systemPrompt !== undefined) {
					effectiveAgent = {
						...effectiveAgent,
						systemPrompt: call.systemPrompt,
					};
				}
				const task = composeAgentTask(call);

				// round-17 P2-4: worktree isolation per agent. When requested, spawn the
				// agent in an isolated git worktree so parallel file-modifying agents
				// don't clobber each other. Falls back to the normal cwd (with a warning)
				// when worktree creation is unavailable (no git repo, dirty leader).
				let agentCwd = manifest.cwd;
				if (call.worktree === true) {
					const wt = await prepareAgentWorktreeAsync(manifest, `dwf-agent-${Date.now()}-${randomBytes(4).toString("hex")}`);
					if (wt?.worktreePath) {
						agentCwd = wt.cwd;
						worktreePath = wt.worktreePath;
						worktreeBranch = wt.branch;
						ctx.log(`worktree: agent isolated at ${wt.worktreePath}`);
					} else {
						ctx.log("worktree: creation unavailable — falling back to normal cwd");
					}
				}

				const childResult = await runWorker({
					cwd: agentCwd,
					task,
					agent: effectiveAgent,
					model: call.model ?? opts.modelOverride ?? agentConfig.model,
					skillPaths: undefined, // skills resolved via agent config + team-role plumbing
					maxTurns: call.maxTurns,
					graceTurns: call.graceTurns,
					signal: ctxSignal,
					artifactsRoot: manifest.artifactsRoot,
					runId: manifest.runId,
					role: call.role ?? call.agent,
				});
				const parsed = parsePiJsonOutput(childResult.stdout);
				// DR-01 P0 completeness (DWF): the attemptErrorFor empty-settle branch
				// lives in the task-runner attempt loop, which ctx.agent() bypasses
				// (runWorker is called directly here). Without this gate a
				// 429-exhausted worker (exit 0, empty final assistant message) passes
				// the exitCode/error check and its rawFinalText/finalText — an early
				// opening sentence — becomes the step's "result": a false-green DWF
				// step. See run team_20261014082741 for the live stdio shape.
				// R6-7 (DR-03 round-6): the settledWithoutAnswer term now carries the
				// sibling exemptions (patches = real work; cancelled ≠ 429) via
				// dwfSettledWithoutAnswerFailure — mirroring child-executor.ts:428-431
				// exactly, so DWF and the task-runner classify the same transcript the
				// same way (a patch-only coder step or an aborted attempt no longer fails
				// as rate-limit exhaustion here while passing there).
				const settledFailure = dwfSettledWithoutAnswerFailure(childResult, parsed);
				if (childResult.exitCode !== 0 || childResult.error || settledFailure !== undefined) {
					// BDG-2: un-reserve the estimate on spawn failure.
					wfState.spent -= estimate;
					reserved = false;
					return {
						ok: false,
						text: "",
						error: childResult.error ?? settledFailure ?? `exit ${childResult.exitCode}`,
						durationMs: Date.now() - started,
					};
				}
				// round-14 P1-2: accumulate this run's token usage into the workflow budget.
				// BDG-2: adjust the reserve — subtract the estimate, add the actual usage.
				// This correctly reduces spent when actualUsage < estimate.
				wfState.spent += (parsed.usage?.input ?? 0) + (parsed.usage?.output ?? 0) - estimate;
				reserved = false;
				let text = childResult.rawFinalText || parsed.finalText || "";
				// Round-11 test fix: parsePiJsonOutput only extracts text from pi event stream
				// ({type:"message_end", message:{role:"assistant", content:[...]}}). When the
				// agent emits plain JSON, plain text, or a different format, finalText is empty.
				// Fallback to a more permissive extraction that handles multiple output shapes.
				if (!text.trim()) {
					text = extractTextFallback(childResult.stdout);
				}
				// Round-13 P0-3: schema validation post-extraction. The schema option is
				// additive — when undefined the call site is unchanged. With a schema,
				// extracted.error means the worker output didn't match expected shape and
				// the script should treat the result as failed (ok:false, error set).
				const extracted = extractStructuredResult(text, call.schema);
				// Write a side artifact for audit/isolation (§0b G3).
				const rel = `wf/${Date.now()}-${randomBytes(4).toString("hex")}.md`;
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "result",
					relativePath: rel,
					content: text,
					producer: "dynamic-workflow",
				});
				if (call.schema !== undefined && !extracted.structured) {
					// BDG-2: un-reserve was already done above (reserved = false after adjust).
					return {
						ok: false,
						text,
						usage: parsed.usage,
						artifactPath: artifact.path,
						error: extracted.error ?? "structured output does not match schema",
						durationMs: Date.now() - started,
					};
				}
				// PERS-1: cache the FULL successful result for idempotency on resume
				// (R6-3: structured + artifactPath + actual durationMs included, so
				// replay returns the same payload a live call would have).
				completedAgentCalls[callId] = {
					ok: true,
					text,
					structured: extracted.structured ? extracted.data : undefined,
					usage: parsed.usage,
					artifactPath: artifact.path,
					durationMs: Date.now() - started,
				};
				return {
					ok: true,
					text,
					structured: extracted.structured ? extracted.data : undefined,
					usage: parsed.usage,
					artifactPath: artifact.path,
					durationMs: Date.now() - started,
				};
			} catch (error) {
				// BDG-2: un-reserve the estimate on failure (only if still reserved).
				if (reserved) wfState.spent -= estimate;
				// SDD-3 W-C G13: cap errors must TERMINATE the script with the
				// structured reason — degrading to ok:false would let scripts (and the
				// review()/retry()/pipeline fallbacks) swallow the cap and keep looping.
				if (error instanceof DwfAgentCallCapError) throw error;
				logInternalError("dynamic-workflow-context.agent", error, `runId=${manifest.runId}`);
				return {
					ok: false,
					text: "",
					error: error instanceof Error ? error.message : String(error),
					durationMs: Date.now() - started,
				};
			} finally {
				// R6-12 (DR-03 round-6): CHECKPOINT BEFORE CLEANUP. agentCount++ and
				// onCheckpoint must land BEFORE the worktree-cleanup await — previously
				// the checkpoint ran after it, so a crash/hang during cleanup lost the
				// just-completed call from the durable checkpoint and resume re-spawned
				// the same agent (duplicate work/tokens). Cleanup is best-effort and
				// idempotent-ish (a leaked worktree is recoverable; a lost call is not).
				agentCount++;
				if (opts.onCheckpoint) {
					try {
						opts.onCheckpoint({
							version: DWF_CHECKPOINT_VERSION,
							runId: manifest.runId,
							vars: ctx.vars,
							phases: phaseState.phases,
							currentPhase: phaseState.currentPhase,
							logs: wfState.logs.slice(0, 1000),
							spent: wfState.spent,
							agentCount,
							completedAgentCalls,
							updatedAt: new Date().toISOString(),
						});
					} catch (checkpointError) {
						logInternalError("dynamic-workflow-context.checkpoint", checkpointError, `runId=${manifest.runId}`);
					}
				}
				// round-17 P2-4: clean up the worktree after the agent completes (success
				// OR failure). Captures the diff as an artifact before removal. Best-effort
				// — a leak must never crash the workflow. R6-12: runs AFTER the checkpoint
				// (see above) — ordering is the fix.
				if (worktreePath) {
					try {
						await cleanupAgentWorktreeAsync(manifest, worktreePath, worktreeBranch);
					} catch (cleanupError) {
						logInternalError("dynamic-workflow-context.worktree-cleanup", cleanupError, `worktreePath=${worktreePath}`);
					}
				}
				semaphore.release();
			}
		},
		async fanOut<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<AgentResult>): Promise<AgentResult[]> {
			return mapConcurrent(items, Math.max(1, limit), fn);
		},
		async pipeline<TItem, TResult = unknown>(
			items: TItem[],
			...stages: Array<(previous: TResult, original: TItem, index: number) => Promise<TResult> | TResult>
		): Promise<(TResult | null)[]> {
			if (!Array.isArray(items)) {
				throw new TypeError("pipeline() expects an array as the first argument");
			}
			if (stages.length === 0 || stages.some((s) => typeof s !== "function")) {
				throw new TypeError("pipeline() stages must be functions");
			}
			if (items.length === 0) return [];
			// Parallel across items, bounded by the workflow concurrency (mirrors fanOut).
			// Per-item stages run sequentially. A failed stage yields null for that item
			// (logged via ctx.log) and the remaining items continue. Aborts propagate.
			return mapConcurrent(items, concurrency, async (item, index): Promise<TResult | null> => {
				let value: unknown = item;
				for (const stage of stages) {
					try {
						value = await stage(value as TResult, item, index);
					} catch (error) {
						// G13: ctxSignal is aborted on cap trip — rethrow so the structured cap
						// error terminates the workflow instead of degrading to a null item.
						if (ctxSignal.aborted) throw error;
						ctx.log(`pipeline[${index}] failed: ${error instanceof Error ? error.message : String(error)}`);
						return null;
					}
				}
				return value as TResult;
			});
		},
		async review(
			taskId: string,
			reviewerRole = "reviewer",
			reviewOpts?: {
				content?: string;
				artifactPath?: string;
				disableTools?: boolean;
			},
		): Promise<{
			outcome: "accept" | "reject" | "changes_requested";
			feedback: string;
		}> {
			// review() is a VERDICT step: it must produce a parseable JSON {outcome, feedback}, not a
			// free-form markdown review. The resolved reviewer agent (e.g. ~/.pi/agent/agents/reviewer.md)
			// has tools (read/grep/bash) + a markdown-output system prompt. Without disableTools, the
			// reviewer explores the repo looking for the task's work, loops, and gets killed (exit 143)
			// before producing JSON — leaving text="" and the fallback verdict. Default: disableTools so
			// the reviewer judges the provided content (or taskId context) directly.
			const disableTools = reviewOpts?.disableTools !== false; // default true
			const workContext = reviewOpts?.content
				? `\n\nWork to review:\n"""\n${reviewOpts.content}\n"""`
				: reviewOpts?.artifactPath
					? `\n\nRead the work from artifact: ${reviewOpts.artifactPath}`
					: "";
			const res = await ctx.agent({
				role: reviewerRole,
				prompt: `You are reviewing the work for task '${taskId}'.${workContext}\n\nEvaluate the work and respond with ONLY a single JSON object, no prose, no markdown:\n{"outcome":"accept|reject|changes_requested","feedback":"<one-paragraph explanation>"}\n\n- "accept": work is complete and correct.\n- "reject": work is fundamentally wrong.\n- "changes_requested": work needs revision (explain what in feedback).`,
				maxTurns: 3,
				disableTools,
				systemPrompt:
					'You are a JSON verdict judge. You output ONLY a single JSON object with keys "outcome" (one of accept/reject/changes_requested) and "feedback" (a concise explanation). Never output prose, markdown, or code fences. Begin your response with { and end with }.',
			});
			const extracted = res.structured as { outcome?: string; feedback?: string } | undefined;
			if (extracted && typeof extracted.outcome === "string" && typeof extracted.feedback === "string") {
				const outcome =
					extracted.outcome === "accept" || extracted.outcome === "reject" || extracted.outcome === "changes_requested"
						? extracted.outcome
						: "changes_requested";
				return { outcome, feedback: extracted.feedback };
			}
			// Fallback (round-11 runtime): many models (e.g. MiniMax-M3) ignore JSON-output
			// instructions and produce a prose review instead. Rather than report an
			// unparseable verdict, run a tiny judge call that converts the prose review into a
			// JSON verdict. This guarantees ctx.review() always returns a structured verdict
			// regardless of the reviewer's output format. Skipped when the reviewer produced
			// no text at all (genuine failure).
			if (res.text.trim()) {
				const judge = await ctx.agent({
					role: reviewerRole,
					prompt: `Convert the following code review into a verdict JSON. Read the review and decide the outcome.\n\nREVIEW:\n"""\n${res.text.slice(0, 4000)}\n"""\n\nRespond with ONLY a JSON object:\n{"outcome":"accept|reject|changes_requested","feedback":"<concise summary>"}\n- accept: review found no real issues.\n- reject: review found critical/fundamental problems.\n- changes_requested: review found issues that need fixing.`,
					maxTurns: 1,
					disableTools: true,
					systemPrompt:
						"You output ONLY a single JSON object with keys outcome and feedback. Begin with { and end with }. Never output prose.",
				});
				const judged = judge.structured as { outcome?: string; feedback?: string } | undefined;
				if (judged && typeof judged.outcome === "string" && typeof judged.feedback === "string") {
					const outcome =
						judged.outcome === "accept" || judged.outcome === "reject" || judged.outcome === "changes_requested"
							? judged.outcome
							: "changes_requested";
					return { outcome, feedback: judged.feedback };
				}
			}
			// Tier-3 sentiment fallback (round-11): when neither the reviewer nor the judge
			// produced JSON (common with MiniMax-M3, GLM, which ignore JSON-output
			// instructions), classify the outcome from the REVIEWER's prose sentiment. We use
			// the reviewer's text (not the judge's terse output) because the original review is
			// the richest sentiment signal. This keeps outcome ACCURATE (accept vs reject vs
			// changes_requested) even when no JSON is ever produced — without it, outcome was
			// always the hardcoded 'changes_requested' default (e.g. correct code was
			// misclassified as needing changes).
			if (res.text.trim()) {
				return {
					outcome: classifyReviewOutcome(res.text),
					feedback: res.text,
				};
			}
			return {
				outcome: "changes_requested",
				feedback: res.text || "(reviewer produced no parseable verdict)",
			};
		},
		async retry(taskId: string, retryOpts?: { feedback?: string }): Promise<AgentResult> {
			// R6-10 (DR-03 round-6): executeWithRetry retries THROWN errors only, but
			// ctx.agent() returns {ok:false} for every failure class except
			// DwfAgentCallCapError — so the previous pass-through never retried an
			// ok:false attempt (a 1-attempt "retry"). Bridge: throw DwfRetryFailure
			// (typed, carries the AgentResult) on !ok so executeWithRetry retries it;
			// after exhaustion catch it and return the CARRIED result (public return
			// type/shape unchanged). DwfAgentCallCapError is not wrapped — it keeps
			// its terminate-the-workflow semantics and propagates untouched.
			try {
				return await executeWithRetry(
					async () => {
						const res = await ctx.agent({
							role: "executor",
							prompt: `Re-do task '${taskId}'.${retryOpts?.feedback ? ` Feedback: ${retryOpts.feedback}` : ""}`,
						});
						if (!res.ok) throw new DwfRetryFailure(res);
						return res;
					},
					{
						maxAttempts: 3,
						backoffMs: 0,
						jitterRatio: 0,
						exponentialFactor: 1,
					},
				);
			} catch (error) {
				if (error instanceof DwfRetryFailure) return error.result;
				throw error;
			}
		},
		mail(
			to: string,
			body: string,
			mailOpts?: {
				kind?: string;
				taskId?: string;
				replyTo?: string;
				replyDeadline?: number;
			},
		): string {
			const msg = appendMailboxMessage(manifest, {
				direction: "outbox",
				from: "dynamic-workflow",
				to,
				body,
				kind: (mailOpts?.kind as never) ?? "message",
				taskId: mailOpts?.taskId,
				replyTo: mailOpts?.replyTo,
				replyDeadline: mailOpts?.replyDeadline,
			});
			// W1b binding: record the expected addressee so gatherReplies can verify
			// that a reply row's authenticated sender (from) is the task this mail
			// was addressed to (replyTo target ownership).
			mailedAddressees.set(msg.id, to);
			return msg.id;
		},
		async gatherReplies(messageIds: string[], deadlineMs: number): Promise<unknown[]> {
			// W1b binding (security fix gatherreplies-replyto-only-binding): a reply
			// row counts ONLY when (a) it targets the run-level parent lane
			// (to === "parent" — the lane this gather polls), (b) its replyTo is one
			// of the awaited ids, and (c) its broker-authenticated sender (from)
			// equals the addressee recorded for that id at mail time. Duplicate rows
			// from one sender no longer satisfy a multi-id gather (distinct
			// (replyTo, from) pairs are counted toward messageIds.length), and every
			// delivered body is fenced through renderInboxMessage (same seam as
			// worker inbox delivery: control-char strip, closing-tag neutralization,
			// 8192-char cap) before it enters workflow variables.
			const collectBoundReplies = (): MailboxMessage[] =>
				readMailbox(manifest, "inbox").filter((m) => {
					if (!m.replyTo || !messageIds.includes(m.replyTo) || m.to !== "parent") return false;
					return expectedReplyAddressee(m.replyTo) === m.from;
				});
			const distinctReplyPairs = (rows: MailboxMessage[]): number => new Set(rows.map((m) => `${m.replyTo}\u0000${m.from}`)).size;
			const fenceReplyRow = (m: MailboxMessage): MailboxMessage => ({ ...m, body: renderInboxMessage(m) });
			const deadline = Date.now() + deadlineMs;
			for (;;) {
				const got = collectBoundReplies();
				if (distinctReplyPairs(got) >= messageIds.length) return got.map(fenceReplyRow);
				if (Date.now() >= deadline || ctxSignal.aborted) return got.map(fenceReplyRow);
				await new Promise((r) => setTimeout(r, 500));
			}
		},
		renderTemplate(name: string, vars: Record<string, string>): unknown {
			return renderPlanTemplate(name, vars);
		},
		vars: opts.resumedState ? { ...opts.resumedState.vars } : ({} as Record<string, unknown>),
		setResult(artifactPath: string, meta?: Record<string, unknown>): void {
			finalResult = { artifactPath, meta };
		},
		phase(title: string): void {
			if (typeof title !== "string" || title.length === 0) {
				throw new TypeError("ctx.phase(title) requires a non-empty string title.");
			}
			// Idempotency: same phase title → no event, no state change.
			if (title === phaseState.currentPhase) return;
			// R6-12 (DR-03 round-6): phase no-dup on resume. A phase already recorded
			// in the hydrated checkpoint is NOT re-emitted — the resumed script
			// re-walks its phase history and would otherwise duplicate phase_started/
			// phase_completed events in events.jsonl. Resume-only guard: hydratedPhases
			// is empty on a fresh run, so legitimate same-title re-entry later in a
			// fresh script still emits (see the fresh-run counter-pin test).
			if (hydratedPhases.has(title)) return;
			// Close out the previous open phase BEFORE the new one opens.
			// U2 (2026-10-10): kept SYNC — ctx closures are exercised DIRECTLY by
			// unit tests that readEvents() synchronously right after the call
			// (dynamic-workflow-context.test.ts); no await boundary exists between a
			// ctx call and those readers. The runner-level lifecycle events ARE
			// migrated (awaited appendEventAsync in dynamic-workflow-runner.ts).
			// Close out the previous open phase BEFORE the new one opens.
			if (phaseState.currentPhase !== undefined) {
				appendEvent(manifest.eventsPath, {
					type: "dwf.phase_completed",
					runId: manifest.runId,
					data: { phase: phaseState.currentPhase },
				});
			}
			phaseState.currentPhase = title;
			// Dedup append with hard cap to bound memory; events still flow.
			if (!phaseState.phases.includes(title)) {
				if (phaseState.phases.length < 100) {
					phaseState.phases.push(title);
				} else if (!phaseCapWarned) {
					phaseCapWarned = true;
					logInternalError(
						"dynamic-workflow-context.phase-cap",
						new Error(
							"Phase list cap of 100 reached; further phases still emit events but are not added to the in-memory phases[] list. Use the events log as the durable source of truth.",
						),
						`runId=${manifest.runId}`,
					);
				}
			}
			// U2 (2026-10-10): kept SYNC — see the phase_completed note above.
			appendEvent(manifest.eventsPath, {
				type: "dwf.phase_started",
				runId: manifest.runId,
				data: { phase: title },
			});
		},
		budget,
		log(message: unknown): void {
			// round-14 P1-3: stringify non-strings, keep a bounded in-memory copy, and
			// always emit a dwf.log event (the events log is the durable source of truth).
			const text = typeof message === "string" ? message : JSON.stringify(message);
			if (wfState.logs.length < 1000) {
				wfState.logs.push(text);
			}
			// U2 (2026-10-10): kept SYNC — see the phase_completed note above.
			appendEvent(manifest.eventsPath, {
				type: "dwf.log",
				runId: manifest.runId,
				data: { message: text },
			});
		},
		args<T = unknown>(): T {
			// round-14 P1-5: typed workflow args sourced from manifest (via opts.args).
			return wfState.args as T;
		},
	};

	// Attach the final-result slot via a non-enumerable getter so the runner can read it
	// without exposing a mutation surface on the ctx the script sees.
	Object.defineProperty(ctx, "__finalResult", {
		get: () => finalResult,
		enumerable: false,
	});
	// round-12 P0-1: phase state is read-only from the runner; the script can only mutate
	// it via ctx.phase(title), which is the documented public surface.
	Object.defineProperty(ctx, "__phaseState", {
		get: () => phaseState,
		enumerable: false,
	});
	// round-14 P1-3: in-memory log buffer is read-only from the runner; the script can only
	// append via ctx.log(message). The events log remains the durable source of truth.
	Object.defineProperty(ctx, "__logs", {
		get: () => wfState.logs,
		enumerable: false,
	});
	// round-18 P2-3: agent invocation counter is read-only from the runner. The script can
	// only advance it via ctx.agent() (incremented in agent()'s finally). Exposed so
	// getWorkflowCheckpoint() can report an accurate count.
	Object.defineProperty(ctx, "__agentCount", {
		get: () => agentCount,
		enumerable: false,
	});
	// SDD-3 W-C G13: effective run limits are read-only from the runner (mirrors
	// __agentCount). Exposed so getWorkflowLimits() can report the effective cap.
	Object.defineProperty(ctx, "__limits", {
		get: () => ({ maxAgentCalls }),
		enumerable: false,
	});
	// PERS-1: completedAgentCalls is read-only from the runner; the agent() method
	// is the only writer. Exposed so getWorkflowCheckpoint() can include it.
	Object.defineProperty(ctx, "__completedAgentCalls", {
		get: () => completedAgentCalls,
		enumerable: false,
	});
	return ctx;
}

/** Read the final result set by the script (runner-only; not part of the public ctx surface). */
export function getWorkflowFinalResult(ctx: WorkflowCtx): { artifactPath: string; meta?: Record<string, unknown> } | undefined {
	return (
		ctx as unknown as {
			__finalResult?: {
				artifactPath: string;
				meta?: Record<string, unknown>;
			};
		}
	).__finalResult;
}

/** Read the in-memory phase state set by the script (runner-only; not part of the public ctx surface). */
export function getWorkflowPhaseState(ctx: WorkflowCtx): { currentPhase: string | undefined; phases: string[] } | undefined {
	return (
		ctx as unknown as {
			__phaseState?: {
				currentPhase: string | undefined;
				phases: string[];
			};
		}
	).__phaseState;
}

/** Read the in-memory log buffer appended by ctx.log() (runner-only; not part of the public ctx surface).
 *  Capped at 1000 entries — the events log (dwf.log) is the durable source of truth. */
export function getWorkflowLogs(ctx: WorkflowCtx): string[] | undefined {
	return (ctx as unknown as { __logs?: string[] }).__logs;
}

/** SDD-3 W-C G13: read the effective run limits (runner-only; not part of the public
 *  ctx surface). Mirrors getWorkflowFinalResult/getWorkflowPhaseState — exposed for
 *  tests and diagnostics so the default cap is observable without dispatching calls. */
export function getWorkflowLimits(ctx: WorkflowCtx): { maxAgentCalls: number } | undefined {
	return (ctx as unknown as { __limits?: { maxAgentCalls: number } }).__limits;
}

/** round-18 P2-3: snapshot the current DWF checkpoint state (runner-only; not part of the public
 *  ctx surface). Mirrors getWorkflowFinalResult/getWorkflowPhaseState. The runner relies on the
 *  `onCheckpoint` callback for accurate per-agent-call checkpoints (it captures the closure value
 *  at call time); this helper is a best-effort snapshot for inspection/debugging. */
export function getWorkflowCheckpoint(ctx: WorkflowCtx): DwfCheckpointState {
	const phaseState = getWorkflowPhaseState(ctx);
	const logs = getWorkflowLogs(ctx);
	return {
		// R6-12: snapshot carries the format version (mirrors the onCheckpoint payload).
		version: DWF_CHECKPOINT_VERSION,
		runId: ctx.runId,
		vars: ctx.vars,
		phases: phaseState?.phases ?? [],
		currentPhase: phaseState?.currentPhase,
		logs: logs ?? [],
		spent: ctx.budget.spent(),
		agentCount: (ctx as unknown as { __agentCount?: number }).__agentCount ?? 0,
		completedAgentCalls: (ctx as unknown as { __completedAgentCalls?: Record<string, AgentResult> }).__completedAgentCalls ?? {},
		updatedAt: new Date().toISOString(),
	};
}

/**
 * R6-3 (DR-03 round-6, HIGH): deterministic PERS-1 cache key over ALL
 * call-shaping AgentCallOpts fields — the JSON of the resolved call object
 * with stable ordering:
 *  - object keys sorted (two identical calls built with different literal key
 *    orders still share a cache entry);
 *  - top-level array fields (inputs, skill) keyed as a SORTED copy — the same
 *    set in a different order is the same call;
 *  - undefined fields dropped;
 *  - the schema is included BY VALUE (a structural change to the expected
 *    output shape changes the dispatched task and must miss the cache — the
 *    old "yes"/"no" placeholder collided different schemas).
 * Previously the key was {role, agent, prompt, model, schema:"yes"/"no"} only,
 * omitting inputs/systemPrompt/disableTools/maxTurns/graceTurns/worktree/skill
 * — e.g. the same prompt with DIFFERENT inputs (which provably alter the
 * dispatched task via composeAgentTask) hit the first call's cache entry on
 * EVERY call and returned the wrong call's result (lead-verified :398-412).
 * Note: fields that do NOT shape the call (description) are included anyway —
 * over-keying only costs a cache miss (a fresh spawn), never correctness.
 */
function computeCallId(call: AgentCallOpts): string {
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(call).sort()) {
		const value: unknown = call[key as keyof AgentCallOpts];
		if (value === undefined) continue;
		normalized[key] = Array.isArray(value) ? [...(value as unknown[])].sort() : value;
	}
	return JSON.stringify(normalized);
}

/** Compose the agent task: prompt + optional dependency-input context block. */
function composeAgentTask(call: AgentCallOpts): string {
	let base = call.prompt;
	if (call.inputs?.length) {
		const block = call.inputs.map((p) => `- ${p}`).join("\n");
		base = `${base}\n\n## Inputs (artifact paths)\n${block}`;
	}
	// Round-13 P0-3: when a schema is requested, append a JSON-output directive.
	// The directive lives at the END of the prompt so it wins over any conflicting
	// persona instruction in the agent's system prompt.
	if (call.schema !== undefined) {
		base = `${base}\n\n## Output format\nRespond with ONLY a single JSON object that matches the schema described in your instructions. Begin your response with { and end with }. Do not wrap the JSON in a code fence. Do not add any prose before or after the JSON.`;
	}
	return base;
}

/**
 * Round-13 P0-3: compose a system-prompt suffix that asks the agent to output a
 * structured JSON object matching the schema's required shape. We don't expose
 * the TypeBox internal type — we describe the SHAPE so the model can match it.
 */
function composeSchemaSystemPrompt(base: string | undefined, schema: TSchema): string {
	const shape = describeSchemaShape(schema, 0);
	const intro = "You are a structured-output assistant. ";
	const instruction = `When responding, output ONLY a single JSON object matching this shape (no prose, no markdown fences, no commentary): ${shape}. Begin your response with { and end with }.`;
	if (typeof base === "string" && base.length > 0) {
		return `${base}\n\n${intro}${instruction}`;
	}
	return `${intro}${instruction}`;
}

/**
 * Walk a TypeBox schema recursively and produce a human-readable shape description.
 * Depth-limited to avoid runaway expansion on deeply nested schemas.
 */
function describeSchemaShape(schema: unknown, depth: number): string {
	if (depth > 4) return "{...}";
	if (!schema || typeof schema !== "object") return "any";
	const obj = schema as Record<string, unknown>;
	// TypeBox: every schema has a `type` discriminator or a `kind` field.
	const kind = obj.kind as string | undefined;
	const type = obj.type as string | undefined;
	if (kind === "object" || type === "object") {
		const properties = obj.properties;
		if (!properties || typeof properties !== "object") return "{}";
		const required = Array.isArray(obj.required) ? new Set(obj.required as string[]) : new Set<string>();
		const props = Object.entries(properties as Record<string, unknown>)
			.map(([key, sub]) => {
				const mark = required.has(key) ? "" : "?";
				return `"${key}"${mark}: ${describeSchemaShape(sub, depth + 1)}`;
			})
			.join(", ");
		return `{${props}}`;
	}
	if (kind === "array" || type === "array") {
		const items = obj.items;
		return `[${describeSchemaShape(items, depth + 1)}]`;
	}
	if (type === "string") return "string";
	if (type === "number" || type === "integer") return "number";
	if (type === "boolean") return "boolean";
	if (type === "null") return "null";
	// Union/Enum fallbacks.
	if (Array.isArray(obj.anyOf)) return obj.anyOf.map((s) => describeSchemaShape(s, depth + 1)).join(" | ");
	if (Array.isArray(obj.oneOf)) return obj.oneOf.map((s) => describeSchemaShape(s, depth + 1)).join(" | ");
	if (Array.isArray(obj.enum)) return obj.enum.map((v) => JSON.stringify(v)).join(" | ");
	return "any";
}

/**
 * Classify a review outcome from prose when no JSON was produced (round-11 tier-3/4 fallback).
 * Scans the reviewer's prose for sentiment signals to decide accept / reject / changes_requested.
 * This keeps the outcome ACCURATE for models that ignore JSON-output instructions.
 *
 * Decision order: reject (critical issues) → accept (explicit approval) → changes_requested (default).
 * reject is checked first because a review can mention both "correctly" (describing existing code)
 * AND "critical bug" (the verdict) — the verdict signal must win.
 */
// Precompiled review-outcome signals (module scope — compiled once, not per call).
// RR-021 WI-1.1: these were previously string literals like "\baccept\b" compiled
// per call — and "\b" in a TS string literal is a BACKSPACE character (U+0008),
// so those two signals never matched anything. Regex literals here give real word
// boundaries. No /g flags → no shared lastIndex state across .test() calls.
const REJECT_SIGNAL_REGEXES: readonly RegExp[] = [
	/\breject\b/,
	/fundamentally/,
	/completely broken/,
	/totally broken/,
	/critical bug/,
	/critical issue/,
	/critical flaw/,
	/security vulnerability/,
	/does not work/,
	/doesn't work/,
	/will not work/,
	/fails to/,
	/unacceptable/,
	/must not be merged/,
	/do not merge/,
	/wrong approach/,
	/logically incorrect/,
	/incorrectly implements/,
	/returns the opposite/,
	/subtraction instead of addition/,
	/opposite of its intended/,
];
const ACCEPT_SIGNAL_REGEXES: readonly RegExp[] = [
	/\baccept\b/,
	/looks good/,
	/well done/,
	/no issues/,
	/no real issues/,
	/no problems/,
	/no concerns/,
	/nothing to change/,
	/ready to merge/,
	/lgtm/,
	/ship it/,
	/correctly implements/,
	/correctly returns/,
	/works as expected/,
	/works correctly/,
	/no bugs/,
	/no defects/,
	/meets all requirements/,
	/all requirements met/,
	/passes all/,
	/is correct/,
	/are correct/,
	/no changes needed/,
	/no changes required/,
	/no further changes/,
	/nothing more to/,
	/complete and correct/,
	/sound implementation/,
];
// RR-021 WI-1.1 negation guard: phrases that NEGATE the bare "accept" signal.
// "I cannot accept this" is a complaint, not approval — the accept hit must be
// discarded so the outcome falls through to changes_requested (or reject if a
// reject signal is also present).
const NEGATED_ACCEPT_REGEXES: readonly RegExp[] = [
	/\bcannot\s+accept\b/,
	/\bcan'?t\s+accept\b/,
	/\bdon'?t\s+accept\b/,
	/\bwon'?t\s+accept\b/,
	/\bdo\s+not\s+accept\b/,
	/\bwill\s+not\s+accept\b/,
	/\bunable\s+to\s+accept\b/,
	/\bnot\s+accept(?:ed|ing|able)?\b/,
];

export function classifyReviewOutcome(prose: string): "accept" | "reject" | "changes_requested" {
	const text = prose.toLowerCase();
	// Reject-first precedence: a review can mention both "correctly" (describing
	// existing code) AND "critical bug" (the verdict) — the verdict signal must win.
	const hasReject = REJECT_SIGNAL_REGEXES.some((re) => re.test(text));
	if (hasReject) return "reject";
	const hasAccept = ACCEPT_SIGNAL_REGEXES.some((re) => re.test(text));
	if (hasAccept && !NEGATED_ACCEPT_REGEXES.some((re) => re.test(text))) return "accept";
	return "changes_requested";
}

/**
 * Round-11 test fix: permissive text extraction for ctx.agent().
 * parsePiJsonOutput only handles the canonical pi event stream. When the child emits
 * a different shape, finalText is empty. This fallback walks the JSON tree looking
 * for any text-shaped string at any depth, then returns the longest one (typically
 * the final assistant response).
 */
export function extractTextFallback(stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";
	const candidates: string[] = [];
	const collect = (value: unknown): void => {
		if (typeof value === "string") {
			const t = value.trim();
			// Skip very short strings and JSON-ish strings
			if (t.length >= 2 && !t.startsWith("{") && !t.startsWith("[") && !/^[\d.]+$/.test(t)) {
				candidates.push(t);
			}
		} else if (Array.isArray(value)) {
			for (const item of value) collect(item);
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value as Record<string, unknown>)) collect(v);
		}
	};
	// 1. Try parsing each line as JSON, walk tree
	for (const line of trimmed.split("\n")) {
		const lineTrim = line.trim();
		if (!lineTrim.startsWith("{")) continue;
		try {
			const obj = JSON.parse(lineTrim);
			collect(obj);
		} catch {
			/* skip */
		}
	}
	// 2. If nothing from JSON, try plain text (longest non-empty line that's not JSON)
	if (candidates.length === 0) {
		for (const line of trimmed.split("\n")) {
			const l = line.trim();
			if (l.length >= 3 && !l.startsWith("{") && !l.startsWith("[") && !l.startsWith("=")) candidates.push(l);
		}
	}
	// 3. Return the longest candidate (typically the final answer)
	if (candidates.length === 0) return "";
	candidates.sort((a, b) => b.length - a.length);
	return candidates[0];
}
