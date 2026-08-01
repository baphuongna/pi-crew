/**
 * action-suggestions.ts — "Did you mean?" suggestions for team actions (DX: F1).
 *
 * Round 16 DX audit found that a typo'd action (`action: 'stat'`,
 * `action: 'summery'`) hits a dead-end "Unknown action: stat" with no path
 * forward. pi-crew already ships a Levenshtein fuzzy-matcher
 * (`src/config/suggestions.ts → suggestConfigKey`); this module applies it to
 * the known set of team actions.
 *
 * EXT-4/EXT-8: the known-action list is now derived from the single source of
 * truth — `allActionLiterals` in `src/schema/team-tool-schema.ts` — so it can
 * never drift from the schema's action enum. A drift test
 * (`test/unit/action-list-single-source.test.ts`) guards against regression.
 */

import { findClosestKey } from "../config/suggestions.ts";
import { allActionLiterals } from "../schema/team-tool-schema.ts";

/**
 * The complete set of valid top-level `team` actions. EXT-4/EXT-8: derived from
 * `allActionLiterals` (the schema's single source of truth), not hand-maintained.
 * Each `allActionLiterals` entry is a `{ const: string }` produced by the domain
 * `stringEnum` schemas; we map to the raw string for use with the fuzzy matcher.
 *
 * Sorted by (length desc, then alphabetical) so `findClosestKey` tie-breaking
 * is deterministic and prefers longer (more specific) matches on equal
 * Levenshtein distance — e.g. "cancle" → "cancel" over "cache".
 */
export const KNOWN_TEAM_ACTIONS: readonly string[] = allActionLiterals
	.map((l) => (l as { const: string }).const)
	.sort((a, b) => b.length - a.length || a.localeCompare(b));

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
