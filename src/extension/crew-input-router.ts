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

/** Rules: phrase prefix (lowercased) → slash-command rewrite. */
const ROUTING_RULES: ReadonlyArray<{ match: RegExp; command: string; needsArg?: boolean }> = [
	// Inspection — no runId needed (lists all runs).
	{ match: /^(crew|team)\s+status\b/i, command: "/team-status" },
	{ match: /^(crew|team)\s+list\b/i, command: "/team-status" },
	{ match: /^(crew|team)\s+(dashboard|board|panel)\b/i, command: "/team-dashboard" },
	{ match: /^(crew|team)\s+(help|commands)\b/i, command: "/team-help" },
	{ match: /^teams\b/i, command: "/teams" },
	{ match: /^(crew|team)\s+(doctor|diagnos\w*)/i, command: "/team-doctor" },
];

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
	for (const rule of ROUTING_RULES) {
		const match = trimmed.match(rule.match);
		if (!match) continue;
		// Carry any remaining args after the matched phrase forward.
		const rest = trimmed.slice(match[0].length).trim();
		return rest ? `${rule.command} ${rest}` : rule.command;
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
