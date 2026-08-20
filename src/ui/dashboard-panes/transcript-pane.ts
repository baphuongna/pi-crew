import type { RunUiSnapshot } from "../snapshot-types.ts";

/**
 * Transcript pane (pane 4). WP-8 (R8): per-attempt model transparency —
 * tasks that burned fallback attempts show which model each attempt used
 * (`requested ✓` / `failed ✗ → next`), newest first, capped to the pane
 * budget. Rendering stays uncolored (pane convention); status glyphs are
 * colorized by the shared colorizeStatusGlyphs pass.
 */

const ATTEMPT_SUMMARY_TASKS = 3;

function modelAttemptLines(snapshot: RunUiSnapshot): string[] {
	const withAttempts = snapshot.tasks
		.filter((task) => (task.modelAttempts?.length ?? 0) > 0)
		.slice(-ATTEMPT_SUMMARY_TASKS)
		.reverse();
	if (!withAttempts.length) return [];
	const lines = ["model attempts (newest first):"];
	for (const task of withAttempts) {
		const attempts = (task.modelAttempts ?? [])
			.map(
				(attempt) =>
					`${attempt.model} ${attempt.success ? "✓" : `✗${attempt.exitCode !== undefined ? `(${attempt.exitCode})` : ""}`}`,
			)
			.join(" → ");
		const resolved = task.modelRouting?.resolved ? ` · resolved ${task.modelRouting.resolved}` : "";
		lines.push(`  ${task.id} (${task.role})${resolved}: ${attempts}`);
	}
	return lines;
}

export function renderTranscriptPane(snapshot: RunUiSnapshot | undefined): string[] {
	if (!snapshot) return ["Output pane: snapshot unavailable"];
	return [
		`Output pane: ${snapshot.recentOutputLines.length} recent lines · press v for transcript viewer · o for raw output`,
		...modelAttemptLines(snapshot),
		...snapshot.recentOutputLines.slice(-12).map((line) => `⎿ ${line}`),
		...(snapshot.recentOutputLines.length ? [] : ["No recent output"]),
	];
}
