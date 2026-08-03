/**
 * DeduplicateStage — collapse CONSECUTIVE duplicate lines into one.
 *
 * Useful for log output where the same line repeats (retry attempts, poll
 * loops, etc.). Only collapses CONSECUTIVE duplicates — non-adjacent
 * repetitions are kept (they may be legitimately repeated later). Does NOT
 * touch whitespace-only differences.
 *
 * Idempotent.
 *
 * SAFETY: do NOT enable this stage on assistant prose. "I I I went to the
 * store" would lose emphasis. compactString's default pipeline does NOT
 * include this stage for that reason; it is opt-in only.
 */
import type { ICompactStage } from "../compact-pipeline.ts";

export class DeduplicateStage implements ICompactStage {
	readonly id = "deduplicate";
	apply(text: string): string {
		if (text.length === 0) return text;
		const lines = text.split(/\r?\n/);
		if (lines.length < 2) return text;
		const out: string[] = [lines[0]!];
		for (let i = 1; i < lines.length; i++) {
			const cur = lines[i]!;
			if (cur !== out[out.length - 1]) out.push(cur);
		}
		// Preserve original line ending style: if input used \r\n, restore that.
		const sep = text.includes("\r\n") ? "\r\n" : "\n";
		return out.join(sep);
	}
}

export const DEDUPLICATE_STAGE = new DeduplicateStage();
