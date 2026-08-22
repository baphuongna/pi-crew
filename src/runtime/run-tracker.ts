import * as fs from "node:fs";
import * as path from "node:path";
import { loadRunManifestById } from "../state/stores/state-store.ts";
import type { TeamRunManifest, TeamTaskState } from "../state/types.ts";
import { projectCrewRoot } from "../utils/paths.ts";
import { isFinishedRunStatus } from "./process-status.ts";

export interface RunWaitResult {
	manifest: TeamRunManifest;
	tasks: TeamTaskState[];
	/** True when the waiter was released early by `detachRunPromise` while the
	 *  run itself keeps executing (see that function). */
	detached?: boolean;
}

export interface ActiveRunPromise {
	promise: Promise<RunWaitResult>;
	resolve: (value: RunWaitResult) => void;
	reject: (reason: unknown) => void;
}

const activeRunPromises = new Map<string, ActiveRunPromise>();

export function registerRunPromise(runId: string): ActiveRunPromise {
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
 * Returns false when the run has no foreground waiter in this process (already
 * background/finished) or its state cannot be read.
 */
export function detachRunPromise(runId: string, cwd: string): boolean {
	const entry = activeRunPromises.get(runId);
	if (!entry) return false;
	const loaded = loadRunManifestById(cwd, runId);
	if (!loaded) return false;
	activeRunPromises.delete(runId);
	entry.resolve({ ...loaded, detached: true });
	return true;
}

export function resolveRunPromise(runId: string, result: RunWaitResult): void {
	const entry = activeRunPromises.get(runId);
	if (entry) {
		entry.resolve(result);
		activeRunPromises.delete(runId);
	}
}

export function rejectRunPromise(runId: string, reason: unknown): void {
	const entry = activeRunPromises.get(runId);
	if (entry) {
		entry.reject(reason);
		activeRunPromises.delete(runId);
	}
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

	// Fast path: already terminal on disk
	const loaded = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
	if (loaded && isFinishedRunStatus(loaded.manifest.status)) {
		return loaded;
	}

	// Medium path: foreground promise registered in this process
	const entry = activeRunPromises.get(runId);
	if (entry) {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`waitForRun timed out after ${timeoutMs}ms`)), timeoutMs);
		});
		try {
			return await Promise.race([entry.promise, timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	// Slow path: background run — poll with exponential backoff capped at pollIntervalMs
	let attempt = 0;
	while (Date.now() < deadline) {
		if (attempt === 0) {
			// Early exit: if the run directory doesn't exist, don't waste time polling.
			// Use projectCrewRoot() to honour the .pi/teams/ fallback for .pi-based
			// projects (see issue #29). Without this, the hardcoded `.crew/state/runs/`
			// path never resolves in projects that use the `.pi/` layout, the throw
			// escapes via subagent-manager.ts:281, and pi crashes with uncaughtException.
			const runDir = path.join(projectCrewRoot(cwd), "state", "runs", runId);
			if (!fs.existsSync(runDir)) {
				throw new Error(`Run ${runId} not found. No run directory at ${runDir}`);
			}
		}
		const fresh = loadRunManifestById(cwd, runId); // NOTE: no withRunLock - best-effort only; concurrent writes may cause inconsistency;
		if (fresh && isFinishedRunStatus(fresh.manifest.status)) {
			return fresh;
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
	for (const entry of activeRunPromises.values()) {
		entry.reject(new Error("Cleared by test"));
	}
	activeRunPromises.clear();
}
