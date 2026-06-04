/**
 * Iterative retrieval loop — workers progressively discover needed context.
 *
 * Pattern origin: ECC/skills/iterative-retrieval/SKILL.md — 4-phase loop:
 * Dispatch → Evaluate → Refine → Loop. Max 3 cycles. Convergence when
 * ≥3 high-relevance files found AND no critical gaps.
 *
 * This module provides the scoring and convergence logic.
 * The actual file discovery is delegated to the caller (prompt-builder or task-runner).
 */

// ── Types ────────────────────────────────────────────────────────────────

export interface RetrievalQuery {
	patterns: string[];
	keywords: string[];
	excludes: string[];
	focusAreas?: string[];
}

export interface RelevanceEvaluation {
	path: string;
	relevance: number;     // 0.0–1.0
	reason: string;
	missingContext: string[];
}

export interface RetrievalResult {
	query: RetrievalQuery;
	evaluations: RelevanceEvaluation[];
	cycle: number;
	converged: boolean;
}

// ── Scoring ──────────────────────────────────────────────────────────────

/**
 * Score relevance of a file to a task description.
 *
 * Uses keyword matching as a heuristic. In production, this would be
 * replaced by embedding-based similarity or BM25 scoring.
 *
 * @param filePath - Path to the file
 * @param fileContent - Content of the file (or excerpt)
 * @param keywords - Task-relevant keywords
 * @returns Relevance score 0.0–1.0
 */
export function scoreRelevance(
	filePath: string,
	fileContent: string,
	keywords: string[],
): number {
	if (keywords.length === 0) return 0;

	const pathLower = filePath.toLowerCase();
	const contentLower = fileContent.toLowerCase();
	let matchCount = 0;
	let weightedScore = 0;

	for (const keyword of keywords) {
		const kw = keyword.toLowerCase();
		// Path match is worth more (file naming is intentional)
		if (pathLower.includes(kw)) {
			matchCount++;
			weightedScore += 0.3;
		}
		// Content match
		const contentMatches = contentLower.split(kw).length - 1;
		if (contentMatches > 0) {
			matchCount++;
			// Diminishing returns for repeated matches
			weightedScore += Math.min(0.2, 0.05 * Math.log2(contentMatches + 1));
		}
	}

	// Normalize: if all keywords matched, score is high
	const keywordCoverage = matchCount / keywords.length;
	const rawScore = keywordCoverage * 0.6 + Math.min(weightedScore, 0.4);

	return Math.min(1.0, Math.max(0.0, rawScore));
}

// ── Convergence ──────────────────────────────────────────────────────────

const CONVERGENCE_MIN_HIGH_RELEVANCE = 3;
const HIGH_RELEVANCE_THRESHOLD = 0.7;

/**
 * Check if retrieval has converged — enough high-relevance files found.
 *
 * @param evaluations - Current relevance evaluations
 * @returns true if converged
 */
export function hasConverged(evaluations: RelevanceEvaluation[]): boolean {
	const highRelevance = evaluations.filter((e) => e.relevance >= HIGH_RELEVANCE_THRESHOLD);
	if (highRelevance.length < CONVERGENCE_MIN_HIGH_RELEVANCE) return false;

	// Check for critical gaps — any evaluation with empty missingContext
	const criticalGaps = evaluations.some(
		(e) => e.relevance < 0.3 && e.missingContext.length > 0,
	);

	return !criticalGaps;
}

// ── Refinement ───────────────────────────────────────────────────────────

/**
 * Refine a retrieval query based on evaluation results.
 *
 * Extracts new keywords from high-relevance files, adds discovered
 * terminology, and excludes confirmed-irrelevant paths.
 *
 * @param query - Original query
 * @param evaluations - Results from the current cycle
 * @returns Refined query for the next cycle
 */
export function refineQuery(
	query: RetrievalQuery,
	evaluations: RelevanceEvaluation[],
): RetrievalQuery {
	const newKeywords = new Set(query.keywords);
	const newExcludes = new Set(query.excludes);
	const newFocusAreas = new Set(query.focusAreas ?? []);

	for (const eval_ of evaluations) {
		if (eval_.relevance >= HIGH_RELEVANCE_THRESHOLD) {
			// Extract potential keywords from the file path
			const parts = eval_.path.replace(/[\\/]/g, "/").split("/");
			for (const part of parts) {
				// Skip common non-informative segments
				if (part.length > 2 && !["src", "lib", "test", "dist", "node_modules"].includes(part)) {
					// Use the filename stem as a keyword hint
					const stem = part.replace(/\.[^.]+$/, "").replace(/[.-]/g, " ");
					for (const word of stem.split(/\s+/)) {
						if (word.length > 3) newKeywords.add(word);
					}
				}
			}
		}

		if (eval_.relevance < 0.2) {
			// Exclude confirmed-irrelevant paths
			newExcludes.add(eval_.path);
		}

		// Track missing context as focus areas
		for (const gap of eval_.missingContext) {
			newFocusAreas.add(gap);
		}
	}

	return {
		patterns: query.patterns, // patterns don't change
		keywords: [...newKeywords],
		excludes: [...newExcludes],
		focusAreas: newFocusAreas.size > 0 ? [...newFocusAreas] : undefined,
	};
}

// ── Loop Control ─────────────────────────────────────────────────────────

const MAX_CYCLES = 3;

/**
 * Determine if another retrieval cycle should run.
 */
export function shouldContinue(evaluations: RelevanceEvaluation[], cycle: number): boolean {
	if (cycle >= MAX_CYCLES) return false;
	if (hasConverged(evaluations)) return false;
	return true;
}
