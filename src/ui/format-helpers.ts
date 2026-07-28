/**
 * Shared formatting helpers extracted from the deprecated tool-render.ts
 * (F-21 Sprint 6 cleanup). Only the 3 utilities that are used by production
 * code live here; the deprecated render functions were removed with tool-render.ts.
 */
import { truncateToWidth } from "../utils/visual.ts";

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
	if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000),
		s = Math.floor((ms % 60_000) / 1000);
	return s > 0 ? `${m}m${s}s` : `${m}m`;
}

export function truncLine(text: string, maxWidth: number): string {
	if (text.includes("\n") || text.includes("\r")) text = text.replace(/\r?\n/g, "↵ ");
	// Round 23 (BUG 4): previously this loop counted 1 visual column per UTF-16
	// code unit and indexed text[i], so for CJK it emitted up to 2x the visual
	// width (frame overflow) and for emoji it split surrogate pairs (U+FFFD).
	// Delegate to the grapheme/ANSI-aware truncateToWidth (keeps ANSI codes,
	// respects double-wide CJK + surrogate pairs, adds the '…' ellipsis).
	return truncateToWidth(text, maxWidth);
}
