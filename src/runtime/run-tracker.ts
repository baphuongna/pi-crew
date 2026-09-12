import * as fs from "node:fs";
import { createRunPaths, loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { isFinishedRunStatus } from "./process-status.ts";

export interface RunWaitResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	/** True when the waiter was released early by `detachRunPromise` while the
	 *  run itself keeps executing (see that function). */
	detached?: boolean;
	/** F1 (2026-09-12 live battery): set when the waiter was released early
	 * because a task PARKED on `ask` — the broker pushes this via
	 * `resolveRunPromise` so the sync caller's tool call returns with the
	 * question instead of blocking until the watchdog kills the worker. The
	 * run keeps executing; the leader answers via `team action='respond'`
	 * then re-blocks via `team action='wait'`. */
	waiting?: {
		taskId: string;
		questionId: string;
		question: string;
		deadline: number;
		options?: string[];
	};
}

export interface ActiveRunPromise {
	promise: Promise<RunWaitResult>;
	resolve: (value: RunWaitResult) => void;
	reject: (reason: unknown) => void;
}

const activeRunPromises = new Map<string, ActiveRunPromise>();

/**
 * Runs whose waiter should be released on its next opportunity.
 *
 * A detach request can arrive BEFORE `executeTeamRun` registers its foreground
 * promise (the tool starts the run and calls `waitForRun` immediately, so a
 * slow-starting run puts the waiter on the polling path with no promise to
 * resolve). The flag makes the request path-independent: the polling loop
 * consumes it just like `detachRunPromise` resolves a registered promise.
 */
const detachRequests = new Set<string>();

/** F1 tombstones (2026-09-12): resolveRunPromise deletes the live entry after
 *  resolving it, so a register+resolve landing BETWEEN two poll ticks of a
 *  slow-path waiter orphaned the payload (the waiter held no reference to the
 *  entry). A waiter on the polling path consumes the tombstone instead.
 *  Bounded — oldest evicted past the limit (detached runs never wait). */
const resolvedRunResults = new Map<string, RunWaitResult>();
const RESOLVED_TOMBSTONE_LIMIT = 32;

export function registerRunPromise(runId: string): ActiveRunPromise {
	// Idempotent (F1 live-probe fix, 2026-09-12): run.ts pre-registers BEFORE
	// startForegroundRun so the waitForRun that runs immediately after can hit
	// the medium path; executeTeamRunCore's later `void registerRunPromise(...)`
	// must NOT overwrite the entry (an overwrite strands waiters holding the
	// old promise — the waiting-push would resolve a promise nobody awaits).
	const existing = activeRunPromises.get(runId);
	if (existing) return existing;
	detachRequests.delete(runId);
	let resolve!: (value: RunWaitResult) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<RunWaitResult>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	const entry: ActiveRunPromise = { promise, resolve, reject };
	activeRunPromises.set(runId, entry);
	return entry;
}

/**
 * Release a foreground waiter WITHOUT stopping the run.
 *
 * A foreground `team run` keeps the parent pi turn streaming for the whole run,
 * and pi's `switchSession` tears the current session down via
 * `session.abort()` → `waitForIdle()`. Opening an agent view therefore hung
 * silently until the run finished. Detaching resolves the tool's `waitForRun`
 * with the run's current (still-running) state so the tool call returns, the
 * parent turn can settle, and the session switch lands — `executeTeamRun`
 * itself keeps going in this process and the async notifier reports completion.
 *
 * Returns false only when the run's state cannot be read at all. When no
 * foreground promise is registered yet (or the waiter is on the polling path),
 * the request is recorded and consumed by `waitForRun` on its next poll.
 */
export function detachRunPromise(runId: string, cwd: string): boolean {
	const loaded = loadRunManifestById(cwd, runId);
	if (!loaded) return false;
	const entry = activeRunPromises.get(runId);
	if (entry) {
		activeRunPromises.delete(runId);
		detachRequests.delete(runId);
		entry.resolve({ ...loaded, detached: true });
		return true;
	}
	detachRequests.add(runId);
	return true;
}

/** True while a detach was requested but no waiter has consumed it yet. */
export function hasPendingRunDetach(runId: string): boolean {
	return detachRequests.has(runId);
}

export function resolveRunPromise(runId: string, result: RunWaitResult): void {
	const entry = activeRunPromises.get(runId);
	if (entry) {
		entry.resolve(result);
		activeRunPromises.delete(runId);
	}
	// F1 tombstone: a slow-path waiter (register/await race, or register+resolve
	// between two ticks) must still see the push. Cheap Map.set; bounded above.
	resolvedRunResults.set(runId, result);
	if (resolvedRunResults.size > RESOLVED_TOMBSTONE_LIMIT) {
		const oldest = resolvedRunResults.keys().next().value;
		if (oldest !== undefined) resolvedRunResults.delete(oldest);
	}
}

export function rejectRunPromise(runId: string, reason: unknown): void {
	const entry = activeRunPromises.get(runId);
	if (entry) {
		entry.reject(reason);
		activeRunPromises.delete(runId);
	}
}

function raceRunPromise(
	entry: ActiveRunPromise,
	timeoutMs: number,
	deadline: number,
): Promise<RunWaitResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const remaining = Math.max(0, deadline - Date.now());
	const timeoutPromise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`waitForRun timed out after ${timeoutMs}ms`)), remaining);
	});
	return Promise.race([entry.promise, timeoutPromise]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Wait for a team run to reach a terminal status.
 * - If the run is already finished on disk, returns immediately.
 * - If a foreground promise is registered for this runId, awaits it.
 * - Otherwise falls back to lightweight fs.watchFile-based waiting.
 */
export async function waitForRun(
	runId: string,
	cwd: string,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<RunWaitResult> {
	const { timeoutMs = 300_000, pollIntervalMs = 500 } = options;
	const deadline = Date.now() + timeoutMs;

	// A detach requested before this waiter existed applies to it (and is
	// consumed here, so it can never leak onto a later waiter for the same run).
	const detachPending = detachRequests.delete(runId);

	// Fast path: already terminal on disk
	const loaded = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
	if (loaded && isFinishedRunStatus(loaded.manifest.status)) {
		return loaded;
	}
	if (detachPending && loaded) {
		return { ...loaded, detached: true };
	}

	// Medium path: foreground promise registered in this process
	const entry = activeRunPromises.get(runId);
	if (entry) return await raceRunPromise(entry, timeoutMs, deadline);

	// Slow path: background run — poll with exponential backoff capped at pollIntervalMs.
	// This path is ALSO taken by a foreground run whose executeTeamRun has not
	// registered its promise yet (the tool calls waitForRun immediately after
	// starting the run), so it must honour a pending detach request too —
	// otherwise opening an agent view can never release the parent turn.
	let attempt = 0;
	while (Date.now() < deadline) {
		if (detachRequests.delete(runId)) {
			const current = loadRunManifestById(cwd, runId);
			if (current) return { ...current, detached: true };
		}
		// F1 live-probe fix (2026-09-12): a foreground promise may appear AFTER
		// this waiter started (register/await race — the waiting-push from the
		// broker resolves the ENTRY, which the polling loop would otherwise
		// never observe). Re-check each tick and switch to the promise path with
		// the REMAINING budget; evidence team_20260912053049 (parked 05:31:14,
		// push no-op'd, waiter polled until the watchdog killed the worker).
		const entryNow = activeRunPromises.get(runId);
		if (entryNow) return await raceRunPromise(entryNow, timeoutMs, deadline);
		if (attempt === 0) {
			// Early exit: if the run directory doesn't exist, don't waste time polling.
			// Resolve through createRunPaths (scopeBaseRoot) so the probe matches where
			// runs are CREATED: project scope — incl. the .pi/teams/ fallback for
			// .pi-based projects (issue #29) — for cwds under a repo root, and USER
			// scope for markerless cwds (issue #54). The previous projectCrewRoot(cwd)
			// join always looked at <cwd>/.crew/state/runs for a markerless cwd, so
			// RUN/WAIT instantly threw "Run not found" while the user-scope crew kept
			// running. createRunPaths is pure path math (no mkdir), so it is safe here.
			const runDir = createRunPaths(cwd, runId).stateRoot;
			if (!fs.existsSync(runDir)) {
				throw new Error(`Run ${runId} not found. No run directory at ${runDir}`);
			}
		}
		const fresh = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
		if (fresh && isFinishedRunStatus(fresh.manifest.status)) {
			return fresh;
		}
		// F1 tombstone: a push that resolved (and evicted) the live entry between
		// ticks lands here — consume it so the leader sees the question, not a
		// 600s block. Terminal-on-disk above still wins (a finished run outranks
		// a stale waiting payload).
		const tombstone = resolvedRunResults.get(runId);
		if (tombstone) {
			resolvedRunResults.delete(runId);
			return tombstone;
		}
		const delay = Math.min(pollIntervalMs, 50 * 2 ** Math.min(attempt, 6)); // max ~3.2s
		await new Promise((r) => setTimeout(r, delay));
		attempt++;
	}

	throw new Error(`waitForRun timed out after ${timeoutMs}ms`);
}

export function hasActiveRunPromise(runId: string): boolean {
	return activeRunPromises.has(runId);
}

export function clearRunPromisesForTest(): void {
	detachRequests.clear();
	resolvedRunResults.clear();
	for (const entry of activeRunPromises.values()) {
		entry.reject(new Error("Cleared by test"));
	}
	activeRunPromises.clear();
}
