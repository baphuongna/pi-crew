/**
 * DP-04 (2026-09-22): small-goal routing hint.
 *
 * Measured: a trivial goal through the default team burns 7.6–9k tokens just on
 * the 3 context-setup steps (assess → execute → verify). The engine ALREADY
 * supports `singleAgent: true` (handlePlan → composeSingleAgentPrompt); nothing
 * suggested it for small goals.
 *
 * This module decides the hint. It is deliberately PURE and explainable — no
 * ML, no hidden state — so the routing decision can be asserted in tests and
 * audited from the plan output. Default mode is "suggest" (visible nudge, the
 * caller/agent still decides), NOT a silent switch: this project has been
 * burned by silent routing changes before (the auto-boomerang aliasing trap),
 * so the decision must be visible.
 */

export type SmallGoalRoutingMode = "off" | "suggest" | "auto";

/** Goals at or below this many whitespace tokens are considered "small". */
export const SMALL_GOAL_TOKEN_THRESHOLD = 40;

export interface RoutingHintInput {
	goal: string;
	/** True when the caller supplied an explicit team and/or workflow override. */
	explicitOverride: boolean;
	/** Configured mode; defaults to "suggest". */
	mode?: SmallGoalRoutingMode;
}

export interface RoutingHint {
	/** Whether a cheaper single-agent composition is advised. */
	suggested: boolean;
	/** Machine-readable reason (empty when not suggested). */
	reason?: string;
	/** Human-readable, shown in the plan output. */
	message?: string;
	/** Rough token saving estimate for the plan text (informational). */
	estimatedSavings?: string;
}

/** Cheap, deterministic token count (whitespace split) — no tokenizer dep. */
export function goalTokenCount(goal: string): number {
	const trimmed = goal.trim();
	if (trimmed.length === 0) return 0;
	return trimmed.split(/\s+/).length;
}

export function resolveRoutingHint(input: RoutingHintInput): RoutingHint {
	const mode = input.mode ?? "suggest";
	if (mode === "off") return { suggested: false };
	// Never second-guess an explicit team/workflow choice.
	if (input.explicitOverride) return { suggested: false };
	const tokens = goalTokenCount(input.goal);
	if (tokens === 0 || tokens > SMALL_GOAL_TOKEN_THRESHOLD) return { suggested: false };
	return {
		suggested: true,
		reason: `goal is small (${tokens} tokens ≤ ${SMALL_GOAL_TOKEN_THRESHOLD})`,
		message:
			`Hint: this goal is small (${tokens} tokens). The default team runs 3 context-setup phases ` +
			`(~8k tokens overhead) before real work — consider \`singleAgent: true\` (or a 2-step chain) to skip them.`,
		estimatedSavings: "~5-6k tokens",
	};
}
