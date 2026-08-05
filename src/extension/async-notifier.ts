import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readCrewAgents, saveCrewAgents } from "../runtime/crew-agent-records.ts";
import { checkProcessLiveness, isActiveRunStatus } from "../runtime/process-status.ts";
import { withRunLockSync } from "../state/coordination/locks.ts";
import { appendEvent, readEventsCursor, type TeamEvent } from "../state/event-log/event-log.ts";
import { loadRunManifestById, saveRunTasks, updateRunStatus } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { extractSessionId } from "../utils/session-utils.ts";
import { listRuns } from "./run-index.ts";

export interface AsyncNotifierState {
	seenFinishedRunIds: Set<string>;
	interval?: ReturnType<typeof setInterval>;
	generation?: number;
	lastStoppedAtMs?: number;
	lastListRunsMs?: number;
}

export interface AsyncNotifierOptions {
	generation?: number;
	isCurrent?: (generation: number) => boolean;
}

function isFinished(status: string): boolean {
	return status === "completed" || status === "failed" || status === "cancelled" || status === "blocked";
}

export function isAsyncTerminalEvent(event: TeamEvent): boolean {
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

function isTaskActive(task: TeamTaskState): boolean {
	return task.status === "running" || task.status === "queued" || task.status === "waiting";
}

function markActiveTasksAndAgentsFailed(run: TeamRunManifest, message: string): void {
	const loaded = loadRunManifestById(run.cwd, run.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
	const tasks = loaded?.tasks ?? [];
	const failedAt = new Date().toISOString();
	if (tasks.some(isTaskActive)) {
		saveRunTasks(
			run,
			tasks.map((task) =>
				isTaskActive(task)
					? {
							...task,
							status: "failed",
							finishedAt: failedAt,
							error: message,
						}
					: task,
			),
		);
	}
	const agents = readCrewAgents(run);
	if (agents.some((agent) => agent.status === "running" || agent.status === "queued" || agent.status === "waiting")) {
		saveCrewAgents(
			run,
			agents.map((agent) =>
				agent.status === "running" || agent.status === "queued" || agent.status === "waiting"
					? {
							...agent,
							status: "failed",
							completedAt: failedAt,
							error: message,
						}
					: agent,
			),
		);
	}
}

export function markDeadAsyncRunIfNeeded(run: TeamRunManifest, now = Date.now(), quietMs = 30_000): TeamRunManifest | undefined {
	if (!run.async || !isActiveRunStatus(run.status)) return undefined;
	const liveness = checkProcessLiveness(run.async.pid);
	if (liveness.alive) return undefined;
	const events = readEventsCursor(run.eventsPath).events;
	if (events.some(isAsyncTerminalEvent)) return undefined;
	if (latestEventAgeMs(events, now) < quietMs) return undefined;
	const asyncPid = run.async.pid;
	const message = `Background runner died unexpectedly; check background.log (${liveness.detail}).`;
	return withRunLockSync(run, () => {
		const fresh = loadRunManifestById(run.cwd, run.runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
		if (!fresh || !isActiveRunStatus(fresh.manifest.status)) return undefined;
		const failed = updateRunStatus(fresh.manifest, "failed", message);
		markActiveTasksAndAgentsFailed(failed, message);
		appendEvent(failed.eventsPath, {
			type: "async.died",
			runId: failed.runId,
			message,
			data: { pid: asyncPid, detail: liveness.detail },
		});
		return failed;
	});
}

const LIST_RUNS_DEBOUNCE_MS = 30_000;

export function startAsyncRunNotifier(
	ctx: ExtensionContext,
	state: AsyncNotifierState,
	intervalMs = 5000,
	options: AsyncNotifierOptions = {},
): void {
	if (state.interval) clearInterval(state.interval);
	const generation = options.generation ?? (state.generation ?? 0) + 1;
	state.generation = generation;
	const startedAtMs = Date.now();
	const staleBeforeMs = state.lastStoppedAtMs ?? startedAtMs;
	// Vector #11: only observe runs owned by THIS pi session (plus
	// ownerless/legacy runs). Runs owned by a different pi session must never be
	// toasted here — otherwise session B notifies about session A's completions
	// (cross-session information leak). When the session id is unavailable (older
	// Pi / test mocks without a sessionManager), nothing is filtered (back-compat).
	const sid = extractSessionId(ctx);
	const ownsRun = (run: TeamRunManifest): boolean => !sid || !run.ownerSessionId || run.ownerSessionId === sid;
	for (const run of listRuns(ctx.cwd).filter(ownsRun)) {
		// Suppress only terminal runs that were already finished before this owner
		// session (or before the previous session switch). Active runs must remain
		// un-seen so completions during auto-compaction/session restart are delivered.
		const updatedAtMs = timeMs(run.updatedAt) ?? 0;
		if (isFinished(run.status) && updatedAtMs < staleBeforeMs) state.seenFinishedRunIds.add(run.runId);
	}
	let cachedRuns: TeamRunManifest[] | undefined;
	state.interval = setInterval(() => {
		try {
			if (options.isCurrent && !options.isCurrent(generation)) return;
			const nowMs = Date.now();
			if (cachedRuns === undefined || nowMs - (state.lastListRunsMs ?? 0) > LIST_RUNS_DEBOUNCE_MS) {
				cachedRuns = listRuns(ctx.cwd).filter(ownsRun).slice(0, 20);
				state.lastListRunsMs = nowMs;
			}
			for (const run of cachedRuns) {
				const current = markDeadAsyncRunIfNeeded(run) ?? run;
				if (!isFinished(current.status) || state.seenFinishedRunIds.has(current.runId)) continue;
				state.seenFinishedRunIds.add(current.runId);
				// Suppress notifications for INTERNAL goal-loop sub-runs.
				// The outer goal-loop creates a synthetic 'goal-turn' workflow per turn
				// (see buildTurnWorkflow in goal-loop-runner.ts). These runs are
				// implementation details of the autonomous loop — the user only cares
				// about the OUTER goal-loop's status (runKind:'goal-loop'), which has
				// its own event stream + status command. Without this filter, every
				// turn that hits e.g. a transient model rate limit triggers an
				// alarming 'Error: pi-crew run failed' toast for an internal sub-run
				// the user never started directly.
				if (current.workflow === "goal-turn" && current.team.startsWith("goal-")) continue;
				const level = current.status === "completed" ? "info" : current.status === "cancelled" ? "warning" : "error";
				ctx.ui.notify(`pi-crew run ${current.status}: ${current.runId} (${current.team}/${current.workflow ?? "none"})`, level);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("stale") || message.includes("session replacement") || message.includes("old ctx")) {
				// Don't stop the interval — session_start will create a new notifier
				// with the refreshed ctx. The isCurrent guard will make this old
				// notifier dormant once sessionGeneration increments.
				// Stopping here creates a race: old notifier dies before new one starts.
				return;
			}
			logInternalError("async-notifier", error, `interval=${intervalMs}`);
		}
	}, intervalMs);
	// Defense-in-depth: never let the notifier timer keep the event loop alive.
	// If stopAsyncRunNotifier is missed (session switch race), the next run of
	// this interval is harmless, but the timer must not block process exit.
	if (typeof state.interval.unref === "function") state.interval.unref();
}

export function stopAsyncRunNotifier(state: AsyncNotifierState): void {
	if (state.interval) clearInterval(state.interval);
	state.interval = undefined;
	state.generation = (state.generation ?? 0) + 1;
	state.lastStoppedAtMs = Date.now();
}
