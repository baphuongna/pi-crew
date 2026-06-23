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

import { runChildPi } from "./child-pi.ts";
import { parsePiJsonOutput } from "./pi-json-output.ts";
import { extractStructuredResult } from "./result-extractor.ts";
import { mapConcurrent } from "./parallel-utils.ts";
import { Semaphore } from "./semaphore.ts";
import { executeWithRetry } from "./retry-executor.ts";
import { allAgents, discoverAgents } from "../agents/discover-agents.ts";
import { writeArtifact } from "../state/artifact-store.ts";
import { appendEvent } from "../state/event-log.ts";
import { appendMailboxMessage, readMailbox } from "../state/mailbox.ts";
import { renderPlanTemplate } from "./plan-templates.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { randomBytes } from "node:crypto";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { TeamConfig } from "../teams/team-config.ts";
import type { TeamRunManifest } from "../state/types.ts";

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

export interface WorkflowCtx {
	cwd: string;
	runId: string;
	goal?: string;
	/** Spawn one agent, await result. Concurrency enforced by ctx.semaphore. */
	agent(opts: AgentCallOpts): Promise<AgentResult>;
	/** Bounded fan-out preserving order (wraps mapConcurrent). */
	fanOut<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<AgentResult>): Promise<AgentResult[]>;
	/** Run a reviewer agent over an artifact; parse {outcome, feedback}. §3.2. */
	review(taskId: string, reviewerRole?: string, opts?: { content?: string; artifactPath?: string; disableTools?: boolean }): Promise<{ outcome: "accept" | "reject" | "changes_requested"; feedback: string }>;
	/** Re-run a task with feedback (wraps executeWithRetry). */
	retry(taskId: string, opts?: { feedback?: string }): Promise<AgentResult>;
	/** Send a mailbox message to another agent/leader. */
	mail(to: string, body: string, opts?: { kind?: string; taskId?: string; replyTo?: string; replyDeadline?: number }): string;
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
	semaphore: Semaphore;
	/** Abort signal (cancel/stop). */
	signal: AbortSignal;
}

export interface MakeWorkflowCtxOptions {
	concurrency?: number;
	signal: AbortSignal;
	team?: TeamConfig;
	modelOverride?: string;
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
		systemPrompt: `You are ${name}.`,
		model,
		tools: [],
		inheritProjectContext: false,
		inheritSkills: false,
	};
}

/** Build the WorkflowCtx facade. Capability-locked: only documented methods exposed. */
export function makeWorkflowCtx(manifest: TeamRunManifest, opts: MakeWorkflowCtxOptions): WorkflowCtx {
	const concurrency = Math.max(1, opts.concurrency ?? 4);
	const semaphore = new Semaphore(concurrency);
	let finalResult: { artifactPath: string; meta?: Record<string, unknown> } | undefined;
	// round-12 P0-1: in-memory phase state, exposed via non-enumerable getter like __finalResult.
	// The events log is the durable source of truth for phase boundaries.
	let phaseState: { currentPhase: string | undefined; phases: string[] } = { currentPhase: undefined, phases: [] };
	let phaseCapWarned = false;

	const ctx: WorkflowCtx = {
		cwd: manifest.cwd,
		runId: manifest.runId,
		goal: manifest.goal,
		signal: opts.signal,
		semaphore,
		async agent(call: AgentCallOpts): Promise<AgentResult> {
			await semaphore.acquire();
			const started = Date.now();
			try {
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
				if (call.systemPrompt !== undefined) {
					effectiveAgent = { ...effectiveAgent, systemPrompt: call.systemPrompt };
				}
				const task = composeAgentTask(call);
				const childResult = await runChildPi({
					cwd: manifest.cwd,
					task,
					agent: effectiveAgent,
					model: call.model ?? opts.modelOverride ?? agentConfig.model,
					skillPaths: undefined, // skills resolved via agent config + team-role plumbing
					maxTurns: call.maxTurns,
					graceTurns: call.graceTurns,
					signal: opts.signal,
					artifactsRoot: manifest.artifactsRoot,
					runId: manifest.runId,
					role: call.role ?? call.agent,
				});
				if (childResult.exitCode !== 0 || childResult.error) {
					return { ok: false, text: "", error: childResult.error ?? `exit ${childResult.exitCode}`, durationMs: Date.now() - started };
				}
				const parsed = parsePiJsonOutput(childResult.stdout);
				let text = parsed.finalText ?? "";
				// Round-11 test fix: parsePiJsonOutput only extracts text from pi event stream
				// ({type:"message_end", message:{role:"assistant", content:[...]}}). When the
				// agent emits plain JSON, plain text, or a different format, finalText is empty.
				// Fallback to a more permissive extraction that handles multiple output shapes.
				if (!text.trim()) {
					text = extractTextFallback(childResult.stdout);
				}
				const extracted = extractStructuredResult(text);
				// Write a side artifact for audit/isolation (§0b G3).
				const rel = `wf/${Date.now()}-${randomBytes(4).toString("hex")}.md`;
				const artifact = writeArtifact(manifest.artifactsRoot, {
					kind: "result",
					relativePath: rel,
					content: text,
					producer: "dynamic-workflow",
				});
				return {
					ok: true,
					text,
					structured: extracted.structured ? extracted.data : undefined,
					usage: parsed.usage,
					artifactPath: artifact.path,
					durationMs: Date.now() - started,
				};
			} catch (error) {
				logInternalError("dynamic-workflow-context.agent", error, `runId=${manifest.runId}`);
				return { ok: false, text: "", error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
			} finally {
				semaphore.release();
			}
		},
		async fanOut<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<AgentResult>): Promise<AgentResult[]> {
			return mapConcurrent(items, Math.max(1, limit), fn);
		},
		async review(taskId: string, reviewerRole = "reviewer", reviewOpts?: { content?: string; artifactPath?: string; disableTools?: boolean }): Promise<{ outcome: "accept" | "reject" | "changes_requested"; feedback: string }> {
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
				systemPrompt: "You are a JSON verdict judge. You output ONLY a single JSON object with keys \"outcome\" (one of accept/reject/changes_requested) and \"feedback\" (a concise explanation). Never output prose, markdown, or code fences. Begin your response with { and end with }.",
			});
			const extracted = res.structured as { outcome?: string; feedback?: string } | undefined;
			if (extracted && typeof extracted.outcome === "string" && typeof extracted.feedback === "string") {
				const outcome = (extracted.outcome === "accept" || extracted.outcome === "reject" || extracted.outcome === "changes_requested")
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
					systemPrompt: "You output ONLY a single JSON object with keys outcome and feedback. Begin with { and end with }. Never output prose.",
				});
				const judged = judge.structured as { outcome?: string; feedback?: string } | undefined;
				if (judged && typeof judged.outcome === "string" && typeof judged.feedback === "string") {
					const outcome = (judged.outcome === "accept" || judged.outcome === "reject" || judged.outcome === "changes_requested")
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
				return { outcome: classifyReviewOutcome(res.text), feedback: res.text };
			}
			return { outcome: "changes_requested", feedback: res.text || "(reviewer produced no parseable verdict)" };
		},
		async retry(taskId: string, retryOpts?: { feedback?: string }): Promise<AgentResult> {
			return executeWithRetry(
				async () => ctx.agent({
					role: "executor",
					prompt: `Re-do task '${taskId}'.${retryOpts?.feedback ? ` Feedback: ${retryOpts.feedback}` : ""}`,
				}),
				{ maxAttempts: 3, backoffMs: 0, jitterRatio: 0, exponentialFactor: 1 },
			);
		},
		mail(to: string, body: string, mailOpts?: { kind?: string; taskId?: string; replyTo?: string; replyDeadline?: number }): string {
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
			return msg.id;
		},
		async gatherReplies(messageIds: string[], deadlineMs: number): Promise<unknown[]> {
			const deadline = Date.now() + deadlineMs;
			while (Date.now() < deadline) {
				const inbox = readMailbox(manifest, "inbox");
				const got = inbox.filter((m) => m.replyTo && messageIds.includes(m.replyTo));
				if (got.length >= messageIds.length) return got;
				await new Promise((r) => setTimeout(r, 500));
				if (opts.signal.aborted) return inbox.filter((m) => m.replyTo && messageIds.includes(m.replyTo));
			}
			return readMailbox(manifest, "inbox").filter((m) => m.replyTo && messageIds.includes(m.replyTo));
		},
		renderTemplate(name: string, vars: Record<string, string>): unknown {
			return renderPlanTemplate(name, vars);
		},
		vars: {} as Record<string, unknown>,
		setResult(artifactPath: string, meta?: Record<string, unknown>): void {
			finalResult = { artifactPath, meta };
		},
		phase(title: string): void {
			if (typeof title !== "string" || title.length === 0) {
				throw new TypeError("ctx.phase(title) requires a non-empty string title.");
			}
			// Idempotency: same phase title → no event, no state change.
			if (title === phaseState.currentPhase) return;
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
						new Error("Phase list cap of 100 reached; further phases still emit events but are not added to the in-memory phases[] list. Use the events log as the durable source of truth."),
						`runId=${manifest.runId}`,
					);
				}
			}
			appendEvent(manifest.eventsPath, {
				type: "dwf.phase_started",
				runId: manifest.runId,
				data: { phase: title },
			});
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
	return ctx;
}

/** Read the final result set by the script (runner-only; not part of the public ctx surface). */
export function getWorkflowFinalResult(ctx: WorkflowCtx): { artifactPath: string; meta?: Record<string, unknown> } | undefined {
	return (ctx as unknown as { __finalResult?: { artifactPath: string; meta?: Record<string, unknown> } }).__finalResult;
}

/** Read the in-memory phase state set by the script (runner-only; not part of the public ctx surface). */
export function getWorkflowPhaseState(ctx: WorkflowCtx): { currentPhase: string | undefined; phases: string[] } | undefined {
	return (ctx as unknown as { __phaseState?: { currentPhase: string | undefined; phases: string[] } }).__phaseState;
}

/** Compose the agent task: prompt + optional dependency-input context block. */
function composeAgentTask(call: AgentCallOpts): string {
	if (!call.inputs?.length) return call.prompt;
	const block = call.inputs.map((p) => `- ${p}`).join("\n");
	return `${call.prompt}\n\n## Inputs (artifact paths)\n${block}`;
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
export function classifyReviewOutcome(prose: string): "accept" | "reject" | "changes_requested" {
	const text = prose.toLowerCase();
	// Strong negative signals → reject. These indicate fundamental/critical problems.
	const rejectSignals = [
		"\breject\b", "fundamentally", "completely broken", "totally broken",
		"critical bug", "critical issue", "critical flaw", "security vulnerability",
		"does not work", "doesn't work", "will not work", "fails to",
		"unacceptable", "must not be merged", "do not merge", "wrong approach",
		"logically incorrect", "incorrectly implements", "returns the opposite",
		"subtraction instead of addition", "opposite of its intended",
	];
	// Acceptance signals → accept. These indicate explicit approval with no real issues.
	const acceptSignals = [
		"\baccept\b", "looks good", "well done", "no issues", "no real issues",
		"no problems", "no concerns", "nothing to change", "ready to merge",
		"lgtm", "ship it", "correctly implements", "correctly returns",
		"works as expected", "works correctly", "no bugs", "no defects",
		"meets all requirements", "all requirements met", "passes all",
		"is correct", "are correct", "no changes needed", "no changes required",
		"no further changes", "nothing more to", "complete and correct", "sound implementation",
	];
	const hasReject = rejectSignals.some((sig) => new RegExp(sig).test(text));
	const hasAccept = acceptSignals.some((sig) => new RegExp(sig).test(text));
	if (hasReject) return "reject";
	if (hasAccept) return "accept";
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
		} catch { /* skip */ }
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
