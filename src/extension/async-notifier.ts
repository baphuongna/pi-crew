import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { appendEvent, readEvents, type TeamEvent } from "../state/event-log.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../runtime/process-status.ts";
import { updateRunStatus } from "../state/state-store.ts";
import type { TeamRunManifest } from "../state/types.ts";
import { listRuns } from "./run-index.ts";

export interface AsyncNotifierState {
	seenFinishedRunIds: Set<string>;
	interval?: ReturnType<typeof setInterval>;
	generation?: number;
	lastStoppedAtMs?: number;
}

export interface AsyncNotifierOptions {
	generation?: number;
	isCurrent?: (generation: number) => boolean;
}

function isFinished(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

function isAsyncTerminalEvent(event: TeamEvent): boolean {
	return event.type === "async.completed" || event.type === "async.failed" || event.type === "async.died";
}

function timeMs(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : undefined;
}

function latestEventAgeMs(events: TeamEvent[], now = Date.now()): number {
	const latest = events.at(-1);
	if (!latest) return Number.POSITIVE_INFINITY;
	const time = new Date(latest.time).getTime();
	return Number.isFinite(time) ? now - time : Number.POSITIVE_INFINITY;
}

export function markDeadAsyncRunIfNeeded(run: TeamRunManifest, now = Date.now(), quietMs = 30_000): TeamRunManifest | undefined {
	if (!run.async || !isActiveRunStatus(run.status)) return undefined;
	const liveness = checkProcessLiveness(run.async.pid);
	if (liveness.alive) return undefined;
	const events = readEvents(run.eventsPath);
	if (events.some(isAsyncTerminalEvent)) return undefined;
	if (latestEventAgeMs(events, now) < quietMs) return undefined;
	const message = `Background runner died unexpectedly; check background.log (${liveness.detail}).`;
	const failed = updateRunStatus(run, "failed", message);
	appendEvent(failed.eventsPath, { type: "async.died", runId: failed.runId, message, data: { pid: run.async.pid, detail: liveness.detail } });
	return failed;
}

export function startAsyncRunNotifier(ctx: ExtensionContext, state: AsyncNotifierState, intervalMs = 5000, options: AsyncNotifierOptions = {}): void {
	if (state.interval) clearInterval(state.interval);
	const generation = options.generation ?? ((state.generation ?? 0) + 1);
	state.generation = generation;
	const startedAtMs = Date.now();
	const staleBeforeMs = state.lastStoppedAtMs ?? startedAtMs;
	for (const run of listRuns(ctx.cwd)) {
		// Suppress only terminal runs that were already finished before this owner
		// session (or before the previous session switch). Active runs must remain
		// un-seen so completions during auto-compaction/session restart are delivered.
		const updatedAtMs = timeMs(run.updatedAt) ?? 0;
		if (isFinished(run.status) && updatedAtMs < staleBeforeMs) state.seenFinishedRunIds.add(run.runId);
	}
	state.interval = setInterval(() => {
		if (options.isCurrent && !options.isCurrent(generation)) return;
		try {
			for (const run of listRuns(ctx.cwd).slice(0, 20)) {
				const current = markDeadAsyncRunIfNeeded(run) ?? run;
				if (!isFinished(current.status) || state.seenFinishedRunIds.has(current.runId)) continue;
				state.seenFinishedRunIds.add(current.runId);
				const level = current.status === "completed" ? "info" : current.status === "cancelled" ? "warning" : "error";
				ctx.ui.notify(`pi-crew run ${current.status}: ${current.runId} (${current.team}/${current.workflow ?? "none"})`, level);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[pi-crew] async notifier error: ${message}`);
		}
	}, intervalMs);
}

export function stopAsyncRunNotifier(state: AsyncNotifierState): void {
	if (state.interval) clearInterval(state.interval);
	state.interval = undefined;
	state.generation = (state.generation ?? 0) + 1;
	state.lastStoppedAtMs = Date.now();
}
