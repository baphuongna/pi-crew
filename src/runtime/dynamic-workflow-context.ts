/**
 * dynamic-workflow-context.ts — WorkflowCtx facade for dynamic-workflow scripts (P2).
 *
 * Spec: research-findings/goal-workflow/00-SPEC.md §3.2
 * Plan: 07-PLAN.md v3 P2 + §0b G4 + §0c C4/C5/C7.
 *
 * The `ctx` object passed to a `.dwf.ts` script's `export default async function(ctx)`.
 * Capability-locked: exposes ONLY the documented methods (no raw manifest/process/require).
 * The script host (dynamic-workflow-runner.ts) loads the script via vm.runInNewContext
 * with a minimal globals object so the script cannot reach `process`/`require`/`import`
 * directly (§0c C4 — v1 trust boundary, not security boundary; isolated-vm deferred to v1.5).
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
	review(taskId: string, reviewerRole?: string): Promise<{ outcome: "accept" | "reject" | "changes_requested"; feedback: string }>;
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
				const task = composeAgentTask(call);
				const childResult = await runChildPi({
					cwd: manifest.cwd,
					task,
					agent: agentConfig,
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
				const text = parsed.finalText ?? "";
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
		async review(taskId: string, reviewerRole = "reviewer"): Promise<{ outcome: "accept" | "reject" | "changes_requested"; feedback: string }> {
			const res = await ctx.agent({
				role: reviewerRole,
				prompt: `Review the work for task '${taskId}'. Respond with ONLY JSON: {"outcome":"accept|reject|changes_requested","feedback":"..."}`,
				maxTurns: 2,
			});
			const extracted = res.structured as { outcome?: string; feedback?: string } | undefined;
			if (extracted && typeof extracted.outcome === "string" && typeof extracted.feedback === "string") {
				const outcome = (extracted.outcome === "accept" || extracted.outcome === "reject" || extracted.outcome === "changes_requested")
					? extracted.outcome
					: "changes_requested";
				return { outcome, feedback: extracted.feedback };
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
	};

	// Attach the final-result slot via a non-enumerable getter so the runner can read it
	// without exposing a mutation surface on the ctx the script sees.
	Object.defineProperty(ctx, "__finalResult", {
		get: () => finalResult,
		enumerable: false,
	});
	return ctx;
}

/** Read the final result set by the script (runner-only; not part of the public ctx surface). */
export function getWorkflowFinalResult(ctx: WorkflowCtx): { artifactPath: string; meta?: Record<string, unknown> } | undefined {
	return (ctx as unknown as { __finalResult?: { artifactPath: string; meta?: Record<string, unknown> } }).__finalResult;
}

/** Compose the agent task: prompt + optional dependency-input context block. */
function composeAgentTask(call: AgentCallOpts): string {
	if (!call.inputs?.length) return call.prompt;
	const block = call.inputs.map((p) => `- ${p}`).join("\n");
	return `${call.prompt}\n\n## Inputs (artifact paths)\n${block}`;
}
