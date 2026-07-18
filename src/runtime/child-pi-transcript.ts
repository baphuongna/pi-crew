/**
 * child-pi-transcript.ts — Transcript batching module for child Pi worker output.
 *
 * Extracted from child-pi.ts (H-7 decomposition, step 1). Zero behavior change.
 *
 * Architecture:
 *   appendTranscript() validates the transcriptPath against the artifactsRoot
 *   containment boundary, redacts the line, and pushes it to a module-scoped
 *   batch buffer keyed by safePath. A debounced 50ms timer flushes the buffer
 *   in one open/write/close per path (O_NOFOLLOW | O_CREAT | O_APPEND).
 *
 * Lifecycle boundaries (ChildPiLineObserver.flush, runChildPi settle) must
 * call flushPendingTranscriptWrites() so callers that immediately read the
 * transcript file see complete content.
 *
 * Ordering: lines are appended in call order. The flush writes the joined
 * array preserving intra-batch order. Inter-batch order is not guaranteed
 * but transcript is append-only telemetry.
 */

import * as fs from "node:fs";
import { DEFAULT_CHILD_PI } from "../config/defaults.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { redactJsonLine } from "../utils/redaction.ts";
import { resolveRealContainedPath } from "../utils/safe-paths.ts";
import type { ChildPiRunInput } from "./child-pi.ts";
import { applyCompactPipeline } from "./compact-pipeline.ts";
import { TruncationStage } from "./compact-stages/truncation-stage.ts";

// ── Transcript batch buffer (OPT-PHASE3) ────────────────────────────────
// Instead of open/write/close per line (3 syscalls × N), accumulate lines
// in a module-scoped buffer and flush them in one open/write/close per path
// every TRANSCRIPT_FLUSH_MS. Lifecycle boundaries (observer.flush, settle)
// force-flush the buffer before returning so transcript reads are complete.
const transcriptBatches = new Map<string, string[]>();
let transcriptFlushTimer: ReturnType<typeof setTimeout> | undefined;
const TRANSCRIPT_FLUSH_MS = 50;

export function appendTranscript(input: ChildPiRunInput, line: string): void {
	if (!input.transcriptPath) return;
	// SECURITY FIX (Issue #1): Validate transcriptPath against artifactsRoot to prevent
	// arbitrary file writes and symlink traversal attacks. An attacker who can influence
	// the task graph could set transcriptPath to /etc/passwd or similar, and mkdirSync
	// with recursive:true would create parent directories. Additionally, appendFileSync
	// follows symlinks, potentially writing to sensitive files.
	let safePath: string;
	try {
		const artifactsRoot = input.artifactsRoot ?? input.cwd;
		safePath = resolveRealContainedPath(artifactsRoot, input.transcriptPath);
	} catch (error) {
		logInternalError("child-pi.transcript-path-rejected", error as Error, `transcriptPath=${input.transcriptPath}`);
		return;
	}
	trackTranscriptWrite(safePath, line);
}

function scheduleTranscriptFlush(): void {
	if (transcriptFlushTimer) return;
	transcriptFlushTimer = setTimeout(() => {
		transcriptFlushTimer = undefined;
		void flushTranscriptBatches();
	}, TRANSCRIPT_FLUSH_MS);
	transcriptFlushTimer.unref?.();
}

async function flushTranscriptBatches(): Promise<void> {
	const entries = [...transcriptBatches.entries()];
	transcriptBatches.clear();
	await Promise.allSettled(
		entries.map(async ([safePath, lines]) => {
			if (lines.length === 0) return;
			const content = lines.join("");
			try {
				const fd = await fs.promises.open(
					safePath,
					fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CREAT | fs.constants.O_APPEND,
					0o600,
				);
				try {
					await fd.write(content, undefined, "utf-8");
				} finally {
					await fd.close();
				}
			} catch (error) {
				logInternalError("child-pi.transcript-write-failed", error as Error, `path=${safePath}`);
			}
		}),
	);
}

function trackTranscriptWrite(safePath: string, line: string): void {
	const content = `${redactJsonLine(line)}\n`;
	let batch = transcriptBatches.get(safePath);
	if (!batch) {
		batch = [];
		transcriptBatches.set(safePath, batch);
	}
	batch.push(content);
	scheduleTranscriptFlush();
}

/**
 * Drain the transcript batch buffer and await any remaining in-flight writes.
 * Called by lifecycle boundaries (ChildPiLineObserver.flush, runChildPi settle)
 * so that transcript files are complete before callers read them.
 *
 * Uses a while loop to re-check the buffer after each flush — new lines may
 * arrive during the async I/O window (trackTranscriptWrite → scheduleTranscriptFlush).
 */
export async function flushPendingTranscriptWrites(): Promise<void> {
	if (transcriptFlushTimer) {
		clearTimeout(transcriptFlushTimer);
		transcriptFlushTimer = undefined;
	}
	while (transcriptBatches.size > 0) {
		await flushTranscriptBatches();
	}
}

/**
 * Reset the module-scoped transcript batch state. Exported for test isolation
 * only — production code should never call this.
 */
export function resetTranscriptBatchState(): void {
	if (transcriptFlushTimer) {
		clearTimeout(transcriptFlushTimer);
		transcriptFlushTimer = undefined;
	}
	transcriptBatches.clear();
}

// ── Compaction helpers (moved from child-pi.ts; these don't need batching) ──

export function compactString(
	value: string,
	maxChars = DEFAULT_CHILD_PI.maxCompactContentChars,
	opts: { preserveImportant?: boolean } = {},
): string {
	if (value.length <= maxChars) return value;
	const result = applyCompactPipeline(value, [
		new TruncationStage(maxChars, {
			preserveImportant: opts.preserveImportant,
		}),
	]);
	return result.text;
}

export function compactValue(value: unknown): unknown {
	if (typeof value === "string") return compactString(value);
	if (Array.isArray(value)) {
		// BUG-4: silent .slice(0, 20) lost items 21-50 with no marker.
		if (value.length > 20) {
			return [...value.slice(0, 20).map(compactValue), `[pi-crew truncated ${value.length - 20} entries]`];
		}
		return value.map(compactValue);
	}
	const record = asRecord(value);
	if (!record) return value;
	const entries = Object.entries(record);
	const compacted: Record<string, unknown> = {};
	for (const [key, entry] of entries.slice(0, 20)) compacted[key] = compactValue(entry);
	if (entries.length > 20) compacted["[truncated]"] = `${entries.length - 20} entries`;
	return compacted;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}
