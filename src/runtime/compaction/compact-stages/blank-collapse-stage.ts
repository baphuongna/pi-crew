/**
 * BlankCollapseStage — collapse runs of 3+ consecutive newlines to a single
 * blank line (i.e., 2 newlines).
 *
 * Reduces whitespace noise in long command output (npm install, cargo build,
 * jest, etc. frequently emit blocks of blank lines between sections). Does
 * NOT touch 1 or 2 consecutive newlines — those are legitimate paragraph
 * breaks in prose.
 *
 * Idempotent (already-collapsed input → unchanged).
 */
import type { ICompactStage } from "../compact-pipeline.ts";

export class BlankCollapseStage implements ICompactStage {
	readonly id = "blank-collapse";
	// NOTE: deliberately NOT using parameter-property shorthand here because
	// Node's --experimental-strip-types does not support it. Field + ctor
	// assignment is the portable shape.
	private readonly minConsecutive: number;
	constructor(minConsecutive = 3) {
		this.minConsecutive = minConsecutive;
	}
	apply(text: string): string {
		if (this.minConsecutive < 2) return text;
		// {minConsecutive,} matches minConsecutive or more; replace with "\n\n" (one blank line).
		const pattern = new RegExp(`\\n{${this.minConsecutive},}`, "g");
		return text.replace(pattern, "\n\n");
	}
}

export const BLANK_COLLAPSE_STAGE = new BlankCollapseStage();
