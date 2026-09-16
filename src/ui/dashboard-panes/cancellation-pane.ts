import type { TeamRunManifest, TeamTaskState } from "../../state/types.ts";

/**
 * D-1 / L-2 — a one-line terminal-run reason for the dashboard detail row.
 *
 * Surfaces *why* a failed/cancelled/stopped run ended without forcing the
 * user to switch panes. This also gives this module a real consumer (it was
 * previously zero-importer dead code per the UI/UX review), wiring it in as
 * the natural home for cancellation/failure reason display.
 *
 * Resolution order: structured `run.cancelled` event reason → first failed
 * task's error → first policy-decision message.
 */
export function summarizeTerminalReason(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	cancellationReason?: string,
): string | undefined {
	if (cancellationReason) return cancellationReason;
	const failed = tasks.find((task) => task.status === "failed" && task.error);
	if (failed?.error) return failed.error;
	if (manifest.policyDecisions?.length) return manifest.policyDecisions[0]?.message;
	return undefined;
}
