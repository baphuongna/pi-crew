/**
 * Result delivery for runs detached by an agent-view switch.
 *
 * Opening an agent view mid-run releases the foreground waiter (see
 * `detachRunPromise`), so the parent turn settles with a "detached" tool
 * result and the run keeps executing. Without this module the run's FINAL
 * result would never reach the conversation: the async notifier only toasts,
 * and its toast is suppressed while a view session is active (different
 * session id) or when the run finished before the operator returned to main.
 *
 * The registry is in-process; a pending result is parked while an agent view is
 * open so the worker's own view session never receives the parent's report.
 */
import { loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { isFinishedRunStatus } from "./process-status.ts";

interface DetachedRun {
	runId: string;
	cwd: string;
}

const detachedRuns = new Map<string, DetachedRun>();

/** Record a run whose foreground waiter was released by a view switch. */
export function markRunDetached(runId: string, cwd: string): void {
	if (!runId || !cwd) return;
	detachedRuns.set(runId, { runId, cwd });
}

/** Cheap guard for hot paths (render tick): nothing to do when empty. */
export function hasDetachedRuns(): boolean {
	return detachedRuns.size > 0;
}

export function forgetDetachedRun(runId: string): void {
	detachedRuns.delete(runId);
}

export function clearDetachedRunsForTest(): void {
	detachedRuns.clear();
}

/** Human-readable completion summary for a detached run. */
export function formatDetachedRunResult(manifest: TeamRunManifest, tasks: TeamTaskState[]): string {
	const lines = [
		`pi-crew run ${manifest.status}: ${manifest.runId} (${manifest.team}/${manifest.workflow ?? "none"})`,
		`Goal: ${manifest.goal}`,
		"",
		"This run was detached when you opened an agent view; it finished in the background.",
	];
	if (tasks.length > 0) {
		lines.push("", "Tasks:");
		for (const task of tasks) {
			const detail = task.error ? ` — ${task.error}` : "";
			lines.push(`  • ${task.id} (${task.role ?? "?"}): ${task.status}${detail}`);
		}
	}
	if (manifest.artifactsRoot) lines.push("", `Artifacts: ${manifest.artifactsRoot}`);
	lines.push(`State: ${manifest.stateRoot}`);
	return lines.join("\n");
}

/**
 * Results of finished detached runs that may be shown in the CURRENT session.
 * Entries are NOT removed: the caller drops each one with `forgetDetachedRun`
 * only after the delivery actually succeeded, so a failed send retries on the
 * next tick instead of losing the run's outcome.
 *
 * Gating is by "am I inside an agent view", not by session id: the report must
 * never land inside a worker's view session, but matching the owner's id is too
 * brittle (the main session can be replaced/renamed while the view is open, and
 * the registry is per pi process anyway, so any non-view session here IS the
 * operator's own).
 */
export function peekFinishedDetachedRunResults(options: { inViewSession?: boolean } = {}): { runId: string; text: string }[] {
	if (detachedRuns.size === 0 || options.inViewSession) return [];
	const ready: { runId: string; text: string }[] = [];
	for (const entry of [...detachedRuns.values()]) {
		const loaded = loadRunManifestById(entry.cwd, entry.runId);
		if (!loaded) {
			// Run state vanished (pruned/deleted) — nothing left to report.
			detachedRuns.delete(entry.runId);
			continue;
		}
		if (!isFinishedRunStatus(loaded.manifest.status)) continue;
		ready.push({ runId: entry.runId, text: formatDetachedRunResult(loaded.manifest, loaded.tasks) });
	}
	return ready;
}
