/**
 * Important-Line Classifier (P0-B) — scan middle slice of a truncated value
 * for diagnostic lines worth preserving between head and tail.
 *
 * Ported from Hypa's `ImportantLineClassifier.cs` (5 regexes) and the
 * middle-scanning portion of `Stages/TruncationStage.cs:24-46`, adapted to TS
 * (no `[GeneratedRegex]` AOT) and to pi-crew's head(75%)/tail(25%) split.
 *
 * Design rationale:
 * - Patterns are intentionally OVER-INCLUSIVE. False positives preserve
 *   harmless lines; false negatives drop critical diagnostics, which is
 *   unacceptable (the whole point of this module). Hypa uses the same
 *   over-inclusive design.
 * - Patterns are evaluated against a WHOLE line, not against the raw
 *   truncated slice, so a match at a line boundary is reliable.
 * - The `splitWithImportantLines` helper performs the head/tail split AND
 *   greedily picks whole important lines from the middle that fit inside
 *   `slackFactor * maxChars` (default 15% slack). Callers compose their own
 *   marker using the returned parts — keeping `compactString` (marker
 *   "compacted ... chars, head+tail preserved") and `readIfSmall` (marker
 *   "truncated ... bytes, head+tail preserved") backward-compatible when no
 *   important lines are present.
 */

/** Diagnostic patterns. Anchored where safe to avoid matching noise. */
export const IMPORTANT_LINE_PATTERNS: readonly RegExp[] = [
	// error keywords — NOTE: "warning" is intentionally excluded here; it has
	// its own case-sensitive pattern below so that the common prose word
	// "warning" does not over-match. (Hypa does the same split.)
	/\b(error|failed|exception|fatal|panic)\b/i,
	// file:line diagnostic — `child-pi.ts:383:`, `App.tsx:42:`
	/\w+\.\w+:\d+:/,
	// HTTP 4xx / 5xx — bounded so it does not match phone numbers etc.
	/\b[45]\d{2}\b/,
	// k8s / linter "Warning" event (case-sensitive so prose is not matched)
	/\bWarning\b/,
	// compiler / linter diagnostic id — `TS2304`, `CS0246`, `ES1234`
	/\b[A-Z]{2,4}\d{3,5}\b/,
];

/** True iff `line` matches at least one important-line pattern. */
export function isImportantLine(line: string): boolean {
	if (!line) return false;
	for (const pattern of IMPORTANT_LINE_PATTERNS) {
		if (pattern.test(line)) return true;
	}
	return false;
}

/**
 * Extract up to `maxLines` important lines from `text`. Lines are split on
 * `\n` (also handles `\r\n`). Order preserved; duplicates kept (callers may
 * want to see the same diagnostic twice if it appears twice — that often
 * signals a recurring failure).
 */
export function extractImportantLines(text: string, maxLines = 30): string[] {
	if (!text || maxLines <= 0) return [];
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (out.length >= maxLines) break;
		if (isImportantLine(line)) out.push(line);
	}
	return out;
}

export interface TruncationSplit {
	/** The first 75% of the value (by char count), verbatim. */
	head: string;
	/** The last 25% of the value (by char count), verbatim. */
	tail: string;
	/**
	 * Important lines from the middle slice, greedily picked (whole lines) so
	 * the joined length fits inside `slackFactor * maxChars`. Empty when
	 * `preserveImportant` is false OR no important lines are present OR none
	 * fit the slack budget.
	 */
	importantLines: string[];
	/** `value.length - maxChars` — chars dropped if no important lines preserved. */
	baseDropped: number;
}

export interface SplitOptions {
	/** When false, important-line scanning is skipped (assistant-text mode). */
	preserveImportant?: boolean;
	/** Hard cap on candidate lines before slack-budget selection. Default 30. */
	maxImportantLines?: number;
	/** Fraction of `maxChars` available for important-line content. Default 0.15. */
	slackFactor?: number;
}

/**
 * Split `value` into head + important-middle + tail, returning the parts.
 * The caller is responsible for composing the final result (marker + glue)
 * because the marker wording differs between `compactString` and
 * `readIfSmall`.
 *
 * When no important lines are picked, the returned `importantLines` is `[]`
 * and the marker wording stays bit-identical to the pre-P0-B format.
 */
export function splitWithImportantLines(value: string, maxChars: number, opts: SplitOptions = {}): TruncationSplit {
	if (value.length <= maxChars) {
		return { head: value, tail: "", importantLines: [], baseDropped: 0 };
	}
	const headLen = Math.floor(maxChars * 0.75);
	const tailLen = maxChars - headLen;
	const head = value.slice(0, headLen);
	const tail = value.slice(value.length - tailLen);

	if (opts.preserveImportant === false) {
		return {
			head,
			tail,
			importantLines: [],
			baseDropped: value.length - maxChars,
		};
	}

	const slackFactor = opts.slackFactor ?? 0.15;
	const slackChars = Math.max(0, Math.floor(maxChars * slackFactor));
	const maxCandidates = opts.maxImportantLines ?? 30;
	const middle = value.slice(headLen, value.length - tailLen);
	const candidates = extractImportantLines(middle, maxCandidates);

	// Greedily pick whole lines that fit in the slack budget.
	const chosen: string[] = [];
	let used = 0;
	for (const line of candidates) {
		const addLen = (chosen.length > 0 ? 1 : 0) + line.length; // '\n' separator
		if (used + addLen > slackChars) break;
		chosen.push(line);
		used += addLen;
	}

	return {
		head,
		tail,
		importantLines: chosen,
		baseDropped: value.length - maxChars,
	};
}
