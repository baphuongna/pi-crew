/**
 * Phase 4 (caveman): Output format validation for live-session workers.
 *
 * Validates that worker output conforms to the structured output contract
 * for the given role. If validation fails, returns structured error info
 * that can be used for retry or fallback.
 *
 * Inspired by caveman's validate.py — check structural preservation
 * (headings, code blocks, URLs) after compression.
 */

/** Role-specific output format patterns — constructed fresh per call to avoid /g lastIndex leak */
const ROLE_PATTERN_DEFS: Record<string, () => RegExp> = {
	explorer: () => /^(\S+:\d+|Defs:|Refs:|Callers:|Tests:|Sites:|No match\.|totals:)/m,
	executor: () => /^(\S+:\d+(-\d+)? — .{1,80}\.|verified:|too-big\.|needs-confirm\.|ambiguous\.|regressed\.)/m,
	reviewer: () => /^([^:\s]+:\d+:\s+\p{Emoji_Presentation}|No issues\.|totals:)/mu,
	"security-reviewer": () => /^([^:\s]+:\d+:\s+\p{Emoji_Presentation}|No issues\.|totals:)/mu,
	verifier: () => /^(PASS:|FAIL:)/m,
};

/** Fresh RegExp factories for structural preservation checks (avoids /g lastIndex leak) */
const makeUrlRe = () => /\bhttps?:\/\/[^\s<>)\]"',;]+/gi;
const makeFencedCodeRe = () => /```[\s\S]*?```/g;
const makeInlineCodeRe = () => /`[^`\n]+`/g;
const makeHeadingRe = () => /^#{1,6}\s+.+/gm;

export interface OutputValidationResult {
	/** Whether the output passes validation */
	valid: boolean;
	/** Whether the output follows the role's contract format */
	formatMatch: boolean;
	/** Whether structural elements (code, URLs, headings) are preserved */
	structurePreserved: boolean;
	/** Specific issues found */
	issues: string[];
}

/**
 * Validate worker output against role-specific contract + structural preservation.
 */
export function validateWorkerOutput(role: string, output: string): OutputValidationResult {
	const issues: string[] = [];

	// Empty output always fails
	if (!output || !output.trim()) {
		return { valid: false, formatMatch: false, structurePreserved: false, issues: ["Empty output"] };
	}

	// Check role-specific format
	const patternFactory = ROLE_PATTERN_DEFS[role];
	const pattern = patternFactory ? patternFactory() : undefined;
	const formatMatch = !pattern || pattern.test(output);
	if (!formatMatch) {
		issues.push(`Output does not match expected ${role} contract format`);
	}

	// Check structural preservation (code blocks, URLs, headings)
	let structurePreserved = true;
	const trimmedOutput = output.trim();

	// Detect if output was truncated mid-code-block
	const opens = (trimmedOutput.match(/```/g) ?? []).length;
	if (opens % 2 !== 0) {
		structurePreserved = false;
		issues.push("Unclosed code block — output may be truncated");
	}

	// Check for malformed URLs
	const urls = trimmedOutput.match(makeUrlRe()) ?? [];
	for (const url of urls) {
		if (url.endsWith(".") || url.endsWith(",")) {
			structurePreserved = false;
			issues.push(`URL with trailing punctuation: ${url.slice(-20)}`);
		}
	}

	return {
		valid: formatMatch && structurePreserved,
		formatMatch,
		structurePreserved,
		issues,
	};
}

/**
 * Extract structured findings from reviewer output.
 * Returns array of { file, line, severity, message } objects.
 */
export function parseReviewerFindings(output: string): Array<{ file: string; line: number; severity: string; message: string }> {
	const findings: Array<{ file: string; line: number; severity: string; message: string }> = [];
	const lines = output.split("\n");

	const SEVERITY_MAP: Record<string, string> = {
		"🔴": "bug",
		"🟡": "risk",
		"🔵": "nit",
		"❓": "question",
	};

	for (const line of lines) {
		// Match: path/to/file.ts:42: 🔴 bug: problem. fix.
		const match = line.match(/^([^:\s]+):(\d+):\s+(\p{Emoji_Presentation}) (\w+):\s+(.+)/u);
		if (match) {
			findings.push({
				file: match[1],
				line: Number(match[2]),
				severity: SEVERITY_MAP[match[3]] ?? match[3],
				message: match[5].trim(),
			});
		}
	}

	return findings;
}

/**
 * Extract explorer results from structured output.
 * Returns array of { file, line, symbol, note } objects.
 */
export function parseExplorerResults(output: string): Array<{ file: string; line: number; symbol: string; note: string }> {
	const results: Array<{ file: string; line: number; symbol: string; note: string }> = [];
	const lines = output.split("\n");

	for (const line of lines) {
		// Match: path/to/file.ts:42 — `symbol` — note
		const match = line.match(/^[- ]*(\S+):(\d+)\s*[—–-]\s*`([^`]+)`\s*[—–-]\s*(.+)/);
		if (match) {
			results.push({
				file: match[1],
				line: Number(match[2]),
				symbol: match[3],
				note: match[4].trim(),
			});
		}
	}

	return results;
}

/**
 * Validate that compressed prose preserves structural elements from original.
 * Returns list of specific issues (empty = valid).
 */
export function validateCompressionPreservation(original: string, compressed: string): string[] {
	const issues: string[] = [];

	// Check code blocks preserved
	const origBlocks = original.match(makeFencedCodeRe()) ?? [];
	const compBlocks = compressed.match(makeFencedCodeRe()) ?? [];
	if (origBlocks.length !== compBlocks.length) {
		issues.push(`Code block count: ${origBlocks.length} → ${compBlocks.length}`);
	}
	for (let i = 0; i < Math.min(origBlocks.length, compBlocks.length); i++) {
		if (origBlocks[i] !== compBlocks[i]) {
			issues.push(`Code block ${i + 1} content changed`);
		}
	}

	// Check URLs preserved
	const origUrls = new Set(original.match(makeUrlRe()) ?? []);
	const compUrls = new Set(compressed.match(makeUrlRe()) ?? []);
	for (const url of origUrls) {
		if (!compUrls.has(url)) {
			issues.push(`URL lost: ${url.slice(0, 60)}...`);
		}
	}

	// Check inline code preserved
	const origInline = original.match(makeInlineCodeRe()) ?? [];
	const compInline = compressed.match(makeInlineCodeRe()) ?? [];
	const origInlineSet = new Set(origInline);
	const compInlineSet = new Set(compInline);
	for (const code of origInlineSet) {
		if (!compInlineSet.has(code)) {
			issues.push(`Inline code lost: ${code}`);
		}
	}

	// Check headings preserved
	const origHeadings = original.match(makeHeadingRe()) ?? [];
	const compHeadings = compressed.match(makeHeadingRe()) ?? [];
	if (origHeadings.length !== compHeadings.length) {
		issues.push(`Heading count: ${origHeadings.length} → ${compHeadings.length}`);
	}

	return issues;
}
