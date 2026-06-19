/**
 * goal-evaluator.ts — LLM-as-judge evaluator for the autonomous goal loop (P1).
 *
 * Spec: research-findings/goal-workflow/00-SPEC.md §2.5
 * Plan: 07-PLAN.md v3 P1 + §0b G3 + §0c C6/C7.
 *
 * Decision (G3): pi-crew has NO direct LLM client (no fetch/SDK). The evaluator
 * runs via runChildPi with a SYNTHESIZED, capability-LOCKED judge AgentConfig.
 * Spawn cost ~200-500ms/turn is acceptable for v1; P1.5 may migrate to
 * @earendil-works/pi-ai's complete() (already an optional peer dep).
 *
 * Judge lockdown (§0c C6 — supersedes the insufficient `tools:[]` wording):
 *   - disableTools:true → pi-args.ts pushes `--no-tools` (Pi verified flag).
 *   - excludeTools:["bash","read","write","edit"] — defense-in-depth.
 *   - inheritContext:false, excludeContextBash:true, parentContext:undefined —
 *     judge must NOT see the parent session's context (bias).
 *   - extensions:[], inheritProjectContext:false, inheritSkills:false, maxTurns:1.
 *
 * AgentConfig.source:"dynamic" (§0c C7 — "synthetic" is invalid ResourceSource).
 * name:"goal-judge" — safe because it's NOT in PROTECTED_AGENT_NAMES.
 *
 * Evidence bundler (§2.5): composes collectToolCallsFromEvent (exported in P1)
 * + verification-gates results + transcript tail (~8 KiB bounded read).
 */

import { readFileSync, existsSync } from "node:fs";
import { runChildPi } from "./child-pi.ts";
import { parsePiJsonOutput } from "./pi-json-output.ts";
import { extractStructuredResult } from "./result-extractor.ts";
import { collectToolCallsFromEvent } from "./completion-guard.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { AgentConfig } from "../agents/agent-config.ts";
import type { GoalVerdict } from "../state/types.ts";

export interface GoalEvidence {
	/** Tail slice of the turn's worker transcript (bounded ~8 KiB). */
	transcriptSlice: string;
	/** Structured tool-call summary extracted from transcript events. */
	toolCalls: Array<{ tool: string; args?: unknown }>;
	/** Verification command results (exit codes + output refs), if verification ran. */
	verificationResults?: Array<{ command: string; exitCode: number | null; passed: boolean }>;
}

export interface EvaluateGoalInput {
	objective: string;
	scope?: string;
	verification?: { commands: string[]; allowManualEvidence?: boolean };
	evidence: GoalEvidence;
	/** Required (§0c C10): the model to use as the judge. */
	model: string;
	signal?: AbortSignal;
	/** Turn number this evaluation corresponds to. */
	turn: number;
	/** cwd + artifactsRoot for runChildPi. */
	cwd: string;
	artifactsRoot?: string;
}

/** Build the capability-locked judge AgentConfig (C6/C7). */
export function synthesizeJudgeAgentConfig(): AgentConfig {
	return {
		name: "goal-judge",
		description: "Goal-completion evaluator (no agency — emits a JSON verdict only).",
		source: "dynamic", // §0c C7: "synthetic" is invalid ResourceSource.
		filePath: "synthetic://goal-loop/judge", // UI-display only; not a spawn path.
		systemPrompt: JUDGE_SYSTEM_PROMPT,
		// §0c C6 lockdown: disableTools pushes `--no-tools` (pi-args.ts). Empty tools:[] is INSUFFICIENT.
		disableTools: true,
		// Defense-in-depth: if --no-tools is ever bypassed, also denylist these explicitly.
		disallowedTools: ["bash", "read", "write", "edit"],
		tools: [],
		extensions: [],
		excludeExtensions: [],
		inheritProjectContext: false,
		inheritSkills: false,
		maxTurns: 1,
		// §0c C6 lockdown: disableTools pushes `--no-tools` (pi-args.ts). Empty tools:[] is INSUFFICIENT.
		disabled: undefined, // not used; disableTools is the real lockdown
		override: undefined,
	};
}

const JUDGE_SYSTEM_PROMPT = `You are a strict goal-completion evaluator. Decide ONLY from the evidence provided.

RULES:
- Do NOT assume work was done that is not shown in the evidence.
- Do NOT run commands or read files — you have no tools.
- If verification commands are provided, they MUST have exit code 0 (passed=true) for the goal to be achieved.
- "achieved" requires concrete evidence (passing tests, successful build, etc.), not claims.
- If you cannot determine completion from the evidence, return achieved:false with a reason explaining what evidence is missing.
- If progress is genuinely blocked by an external factor the worker cannot resolve, prefix reason with "BLOCKED:".

Respond with ONLY a single JSON object, no prose, no markdown fences:
{"achieved": <true|false>, "reason": "<one concise sentence>", "evidenceRefs": ["<artifact path or transcript quote>", ...]}`;

/** Build the judge task prompt: objective + scope + verification + evidence. */
function buildJudgeTask(input: EvaluateGoalInput): string {
	const lines: string[] = [
		"# Goal to evaluate",
		input.objective,
	];
	if (input.scope) lines.push("", "# Scope (allowed changes)", input.scope);
	if (input.verification?.commands?.length) {
		lines.push("", "# Acceptance verification (ALL must pass with exit code 0)", ...input.verification.commands.map((c) => `- ${c}`));
	}
	lines.push("", "# Evidence");
	if (input.evidence.verificationResults?.length) {
		lines.push("## Verification results");
		for (const r of input.evidence.verificationResults) {
			lines.push(`- \`${r.command}\` → exit ${r.exitCode ?? "null"} (${r.passed ? "PASS" : "FAIL"})`);
		}
	}
	if (input.evidence.toolCalls.length) {
		lines.push("", "## Tool calls observed in this turn");
		const summary = input.evidence.toolCalls.slice(-20).map((c) => `- ${c.tool}${c.args ? ` (args: ${truncate(JSON.stringify(c.args), 80)})` : ""}`);
		lines.push(...summary);
	}
	lines.push("", "## Worker transcript tail (bounded ~8 KiB)");
	lines.push("```");
	lines.push(input.evidence.transcriptSlice || "(no transcript available)");
	lines.push("```");
	lines.push("", "Now respond with the JSON verdict per the system prompt.");
	return lines.join("\n");
}

function truncate(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Evaluate whether the goal is achieved, given the turn's evidence.
 * Returns a GoalVerdict. On any failure (non-zero exit, non-JSON, invalid shape),
 * returns a `BLOCKED:`-prefixed verdict so the loop stops (§0c C6 fallback).
 */
export async function evaluateGoal(input: EvaluateGoalInput): Promise<GoalVerdict> {
	const agent = synthesizeJudgeAgentConfig();
	const task = buildJudgeTask(input);
	const evaluatedAt = new Date().toISOString();

	try {
		const result = await runChildPi({
			cwd: input.cwd,
			task,
			agent,
			model: input.model,
			maxTurns: 1,
			graceTurns: 0,
			inheritContext: false,
			excludeContextBash: true,
			// parentContext intentionally omitted → undefined → judge sees only the task prompt.
			signal: input.signal,
			artifactsRoot: input.artifactsRoot,
			role: "goal-judge",
			runId: `goal-judge-turn-${input.turn}`,
			agentId: "goal-judge",
		});

		if (result.exitCode !== 0 || result.error) {
			return blockedVerdict(input.turn, input.model, evaluatedAt, `judge spawn failed (exit=${result.exitCode}): ${result.error ?? result.stderr.slice(0, 200)}`);
		}

		const parsed = parsePiJsonOutput(result.stdout);
		const finalText = parsed.finalText ?? "";
		if (!finalText.trim()) {
			return blockedVerdict(input.turn, input.model, evaluatedAt, "judge produced no output");
		}

		const extracted = extractStructuredResult(finalText);
		const data = extracted.structured ? (extracted.data as { achieved?: unknown; reason?: unknown; evidenceRefs?: unknown }) : undefined;
		if (!data || typeof data.achieved !== "boolean" || typeof data.reason !== "string") {
			return blockedVerdict(input.turn, input.model, evaluatedAt, `judge output not valid verdict JSON: ${truncate(finalText, 200)}`);
		}
		const evidenceRefs = Array.isArray(data.evidenceRefs) ? data.evidenceRefs.filter((r): r is string => typeof r === "string") : undefined;
		return {
			turn: input.turn,
			achieved: data.achieved,
			reason: data.reason,
			evidenceRefs,
			evaluatorModel: input.model,
			evaluatedAt,
		};
	} catch (error) {
		logInternalError("goal-evaluator.evaluateGoal", error, `turn=${input.turn}`);
		return blockedVerdict(input.turn, input.model, evaluatedAt, `judge threw: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function blockedVerdict(turn: number, model: string, evaluatedAt: string, reason: string): GoalVerdict {
	return { turn, achieved: false, reason: `BLOCKED: ${reason}`, evaluatorModel: model, evaluatedAt };
}

/**
 * Bundle evidence for a turn from its transcript file.
 * Reads the transcript JSONL (bounded tail ~8 KiB) + extracts tool calls.
 *
 * @param transcriptPath absolute path to the turn worker's transcript JSONL
 * @param verificationResults optional pre-computed verification results
 */
export function bundleEvidence(
	transcriptPath: string | undefined,
	verificationResults?: GoalEvidence["verificationResults"],
): GoalEvidence {
	const toolCalls: Array<{ tool: string; args?: unknown }> = [];
	let transcriptSlice = "";

	if (transcriptPath && existsSync(transcriptPath)) {
		try {
			const raw = readFileSync(transcriptPath, "utf-8");
			// Bounded tail: last ~8 KiB of the transcript.
			transcriptSlice = raw.length > 8192 ? raw.slice(raw.length - 8192) : raw;
			// Extract tool calls from each JSONL line (collectToolCallsFromEvent is per-event).
			for (const line of raw.split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					const event = JSON.parse(trimmed);
					toolCalls.push(...collectToolCallsFromEvent(event));
				} catch {
					// Skip non-JSON lines (e.g. compacted tails).
				}
			}
		} catch (error) {
			logInternalError("goal-evaluator.bundleEvidence", error, `transcriptPath=${transcriptPath}`);
		}
	}

	return { transcriptSlice, toolCalls: toolCalls.slice(-50), verificationResults };
}
