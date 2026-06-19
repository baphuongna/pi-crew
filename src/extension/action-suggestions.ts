/**
 * action-suggestions.ts — "Did you mean?" suggestions for team actions (DX: F1).
 *
 * Round 16 DX audit found that a typo'd action (`action: 'stat'`,
 * `action: 'summery'`) hits a dead-end "Unknown action: stat" with no path
 * forward. pi-crew already ships a Levenshtein fuzzy-matcher
 * (`src/config/suggestions.ts → suggestConfigKey`); this module applies it to
 * the known set of team actions.
 *
 * The known-action list mirrors the `action` enum in
 * `src/schema/team-tool-schema.ts`. Kept as a hand-maintained constant (not
 * derived from the TypeBox schema at runtime) so it is trivially testable and
 * avoids pulling the schema into low-level error paths.
 */

import { findClosestKey } from "../config/suggestions.ts";

/**
 * The complete set of valid top-level `team` actions (mirrors the action enum
 * in `src/schema/team-tool-schema.ts`). Exported so callers and tests can use
 * the single source of truth.
 */
export const KNOWN_TEAM_ACTIONS = [
	"run", "parallel", "plan", "status", "wait", "list", "get",
	"cancel", "retry", "resume", "respond", "create", "update", "delete",
	"doctor", "cleanup", "events", "artifacts", "worktrees", "forget",
	"summary", "prune", "export", "import", "imports", "help", "validate",
	"config", "init", "recommend", "autonomy", "api", "settings", "steer",
	"invalidate", "health", "graph", "onboard", "explain", "cache",
	"checkpoint", "search", "orchestrate", "schedule", "scheduled", "anchor",
	"auto-summarize", "auto_boomerang", "goal",
	"workflow-create", "workflow-get", "workflow-list", "workflow-save", "workflow-delete",
] as const;

/**
 * Suggest the closest known team action for a (likely typo'd) input.
 * Returns `null` when no action is close enough — callers should then omit
 * the "Did you mean …?" hint rather than suggesting a poor match.
 *
 * Uses a tighter edit-distance budget than the generic config-key suggester
 * (2 instead of 3): team actions are short command words, so distance-3
 * matches against a short input (e.g. "" → "run") produce low-quality hints.
 * Empty/whitespace input always returns null.
 *
 * Exported for unit testing.
 */
export function suggestAction(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	// Defense-in-depth (Round 18 security F1): levenshtein is O(n×m). A hostile
	// very-long input would waste cycles. The action is enum-validated upstream
	// so this is unreachable in practice, but cap input length cheaply.
	if (trimmed.length > 64) return null;
	return findClosestKey(trimmed, KNOWN_TEAM_ACTIONS, 2);
}

/**
 * Build a "Did you mean?" suffix for an unknown-action error message.
 * Returns "" when there is no good suggestion (so the caller can just append
 * it unconditionally). Keeps error formatting centralized.
 *
 * Exported for unit testing + use in the dispatch default-case.
 *
 * Example:
 *   formatActionSuggestion("stat")    // "\n\nDid you mean 'status'? Use action='status'."
 *   formatActionSuggestion("xyzzy")   // ""
 */
export function formatActionSuggestion(input: string): string {
	const suggestion = suggestAction(input);
	if (!suggestion || suggestion === input) return "";
	return `\n\nDid you mean '${suggestion}'? Use action='${suggestion}'. Run action='help' to see all actions.`;
}
