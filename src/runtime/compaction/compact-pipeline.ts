/**
 * Stage-chain compression pipeline (P0-A).
 *
 * Composable, monotonic-shrink-safe text compression. Each stage declares an
 * `id` and an `apply(text): string` method. The pipeline runs stages in
 * order, applying each stage's output ONLY if it is no longer than the
 * stage's input. This is the safety property that prevents the family of
 * bugs the old L4 caveman-shrink refactor surfaced (24/27 artifacts corrupted
 * with null bytes because a regex-based shrink expanded its input in some
 * cases — knowledge.md "L4 output-handling"). With the monotonic-shrink gate,
 * a buggy stage implementation can NEVER cause output growth, and therefore
 * cannot corrupt downstream structure.
 *
 * Ported from Hypa's `src/Hypa.Infrastructure/Compression/GenericOutputCompressor.cs`
 * (stage loop with `if (next.Length <= text.Length)` gate).
 */

export interface ICompactStage {
	/** Stable identifier; surfaced in `PipelineResult.applied` for observability. */
	readonly id: string;
	/**
	 * Transform `text`. MUST be pure (no side effects, deterministic for a
	 * given input). MAY return the input unchanged when nothing to do — the
	 * pipeline will skip it via the monotonic-shrink gate regardless, but
	 * returning the same string keeps `applied` honest.
	 */
	apply(text: string): string;
}

export interface PipelineResult {
	text: string;
	/** ids of stages whose output was accepted (shorter-or-equal than their input). */
	applied: readonly string[];
}

/**
 * Run `stages` in order. Each stage is applied only if its output is no
 * longer than its current input. The pipeline NEVER expands text — if a
 * stage would expand, it is silently skipped (its id is not added to
 * `applied`).
 */
export function applyCompactPipeline(text: string, stages: readonly ICompactStage[]): PipelineResult {
	let current = text;
	const applied: string[] = [];
	for (const stage of stages) {
		if (!stage || typeof stage.apply !== "function") continue; // defensive: skip malformed entries
		const next = stage.apply(current);
		if (typeof next !== "string") continue; // defensive: skip non-string output
		if (next.length <= current.length) {
			current = next;
			applied.push(stage.id);
		}
		// else: stage attempted to expand input — silently drop (monotonic-shrink gate).
	}
	return { text: current, applied };
}
