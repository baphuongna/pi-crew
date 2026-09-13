/**
 * Natural-language crew input routing (Round 13 UX).
 *
 * Pi fires the `input` event before skill/template expansion and before
 * before_agent_start. A handler can transform the text (e.g. rewrite
 * "crew status" → "/team-status"), or fully handle it.
 *
 * This module matches a small set of natural-language crew phrases and
 * rewrites them to the equivalent slash command, so users do not need to
 * memorize command names. Slash-command input (text starting with "/") is
 * always passed through unchanged — we never shadow explicit commands.
 */
import type { InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

/**
 * Natural-language crew phrases → slash-command mapping.
 *
 * Single source of truth shared by:
 *  - the `input`-event router (rewrites submitted text), and
 *  - the editor autocomplete provider (suggests phrases as you type).
 *
 * Each entry maps a phrase (what the user types) to a slash command.
 * The router matches when submitted text STARTS WITH a phrase (word boundary);
 * the autocomplete matches when the line starts with `crew `/`team ` and the
 * partial word is a prefix of a phrase's keyword.
 */
export const CREW_PHRASES: ReadonlyArray<{ phrase: string; command: string }> = [
	{ phrase: "crew status", command: "/team-status" },
	{ phrase: "crew list", command: "/team-status" },
	{ phrase: "crew dashboard", command: "/team-dashboard" },
	{ phrase: "crew board", command: "/team-dashboard" },
	{ phrase: "crew panel", command: "/team-dashboard" },
	{ phrase: "crew help", command: "/team-help" },
	{ phrase: "crew commands", command: "/team-help" },
	{ phrase: "crew doctor", command: "/team-doctor" },
	{ phrase: "crew diagnose", command: "/team-doctor" },
	{ phrase: "crew schedule", command: "/schedules" },
	{ phrase: "scheduled jobs", command: "/schedules" },
	{ phrase: "teams", command: "/teams" },
];

/**
 * Build a case-insensitive anchored regex from a phrase. The leading `crew `
 * keyword is treated as interchangeable with `team ` (so "crew status" matches
 * both "crew status" and "team status"). Bare phrases like "teams" match
 * verbatim.
 */
function phraseToRegex(phrase: string): RegExp {
	const kw = phrase.match(/^(crew|team)\s+(.*)$/i);
	if (kw) {
		const rest = kw[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return new RegExp(`^(?:crew|team)\\s+${rest}\\b`, "i");
	}
	const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}\\b`, "i");
}

/**
 * Try to rewrite a natural-language crew phrase into a slash command.
 * Returns the rewritten command string, or `null` if no rule matches.
 *
 * Rules intentionally only match at the START of the input and require a
 * word boundary, so ordinary sentences mentioning "crew" are untouched.
 */
export function rewriteCrewInput(text: string): string | null {
	const trimmed = text.trim();
	// Never transform explicit slash commands or inputs that don't start with
	// a crew/team keyword phrase.
	if (trimmed.startsWith("/")) return null;
	for (const entry of CREW_PHRASES) {
		const match = trimmed.match(phraseToRegex(entry.phrase));
		if (!match) continue;
		// Carry any remaining args after the matched phrase forward.
		const rest = trimmed.slice(match[0].length).trim();
		return rest ? `${entry.command} ${rest}` : entry.command;
	}
	return null;
}

/**
 * Pi `input` event handler. Transforms matching crew phrases; passes
 * everything else through unchanged.
 */
export function handleCrewInput(event: InputEvent): InputEventResult {
	// Only transform interactive user input — never programmatic/scripted input.
	if (event.source !== "interactive") return { action: "continue" };
	const rewritten = rewriteCrewInput(event.text);
	if (!rewritten) return { action: "continue" };
	return { action: "transform", text: rewritten, images: event.images };
}

/** Register the crew input router on a Pi instance. Safe to call once. */
export function registerCrewInputRouter(pi: { on?: (event: "input", handler: (e: InputEvent) => InputEventResult) => void }): void {
	pi.on?.("input", handleCrewInput);
}
