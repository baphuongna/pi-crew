/**
 * goal-state-store.ts — Persistent outer state for the autonomous goal loop (P0/P1).
 *
 * Spec: research-findings/goal-workflow/00-SPEC.md §2.3
 * Plan: research-findings/goal-workflow/07-PLAN.md v3 §0b G2 (one manifest per turn,
 * goal loop owns OUTER state) + §0c C10 (hardening: assertSafePathId + UUID goalId).
 *
 * Stores GoalLoopState as atomic JSON at <crewRoot>/state/goals/<goalId>.json.
 * Modeled on ScheduleStore (state/schedule.ts:86) but with atomicWriteJson +
 * path-traversal defense (assertSafePathId on every public method).
 *
 * Per §0c C2: budget lives here (budgetUsed accumulates collectRunMetrics across turns);
 * per-turn usage stays on each turn's TeamRunManifest/tasks.json.
 */

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { appendEvent } from "../state/event-log.ts";
import type { GoalLoopState, GoalLoopStatus } from "../state/types.ts";
import { createRunId } from "../utils/ids.ts";
import { logInternalError } from "../utils/internal-error.ts";
import { projectCrewRoot, userCrewRoot } from "../utils/paths.ts";
import { assertSafePathId } from "../utils/safe-paths.ts";

/** Default state-root resolver: project scope if a project crew-root exists, else user scope. */
function resolveGoalsRoot(cwd: string): string {
	const crewRoot = projectCrewRoot(cwd) ?? userCrewRoot();
	return `${crewRoot}/state/goals`;
}

/** Goal file path for a goalId. Asserts the id is path-safe (§0c C10). */
function goalFilePath(cwd: string, goalId: string): string {
	assertSafePathId("goalId", goalId);
	return `${resolveGoalsRoot(cwd)}/${goalId}.json`;
}

/**
 * GoalStore — CRUD for GoalLoopState files.
 *
 * Concurrency: writes are atomic (temp+rename+fsync via atomicWriteJson). For
 * read-modify-write sequences under contention, callers should coordinate via
 * GoalLoopState.state transitions (cooperative, the goal loop is single-writer
 * between turns). There is no file-lock here because the loop is the sole writer
 * during its lifetime; `goal stop`/`pause`/`resume` from another session flip
 * state fields that the loop checks between turns (cooperative, §0c C11).
 */
export class GoalStore {
	private readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	/** Generate a fresh, path-safe goalId (never user-derived — §0c C10). */
	createGoalId(): string {
		return createRunId("goal");
	}

	/** Load a goal by id. Returns undefined if missing/corrupt. Throws on unsafe goalId (§0c C10). */
	load(goalId: string): GoalLoopState | undefined {
		// Path-safety check runs BEFORE the try/catch so traversal attempts throw (not silently return undefined).
		const path = goalFilePath(this.cwd, goalId);
		try {
			if (!existsSync(path)) return undefined;
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			if (!parsed || typeof parsed !== "object" || typeof parsed.goalId !== "string") return undefined;
			return parsed as GoalLoopState;
		} catch {
			return undefined;
		}
	}

	/** Atomically persist a goal state. Emits a goal.state_changed event if eventsPath given. */
	save(state: GoalLoopState, eventsPath?: string): void {
		assertSafePathId("goalId", state.goalId);
		const path = goalFilePath(this.cwd, state.goalId);
		const next = { ...state, updatedAt: new Date().toISOString() };
		try {
			mkdirSync(dirname(path), { recursive: true });
			atomicWriteJson(path, next);
			if (eventsPath) {
				appendEvent(eventsPath, {
					type: "goal.state_changed",
					runId: state.goalId,
					data: { goalId: state.goalId, state: state.state },
				});
			}
		} catch (error) {
			logInternalError("goal-state-store.save", error, `goalId=${state.goalId}`);
			throw error;
		}
	}

	/** Patch a goal's top-level fields (e.g. state, turnsUsed, budgetUsed, currentRunId). */
	patch(goalId: string, patch: Partial<GoalLoopState>, eventsPath?: string): GoalLoopState | undefined {
		const current = this.load(goalId);
		if (!current) return undefined;
		const next: GoalLoopState = {
			...current,
			...patch,
			goalId: current.goalId,
			createdAt: current.createdAt,
		};
		this.save(next, eventsPath);
		return next;
	}

	/** Convenience: transition state with optional event emission. */
	setStatus(goalId: string, state: GoalLoopStatus, eventsPath?: string): GoalLoopState | undefined {
		return this.patch(goalId, { state }, eventsPath);
	}

	/**
	 * Compare-And-Set status for atomic stuck↔resume transitions (P1b, RFC v0.5 §P1b).
	 *
	 * Loads current state; if `current.state === expected`, sets it to `next`,
	 * persists, and emits a `goal.state_changed` event (reusing the save()
	 * emission pattern). Otherwise returns undefined (CAS failed — no mutation,
	 * no event). This prevents lost updates when the background loop and a
	 * `goal resume`/idle-sweeper session race to flip `state`.
	 *
	 * Legal P1b transitions enforced by callers (not by this method):
	 *   running → stuck,  stuck → running,  stuck → cancelled.
	 */
	/**
	 * Cross-process-safe compare-and-set (cold-review #2 HIGH #2 fix).
	 *
	 * The synchronous read-check-write is only atomic within one event loop. `goal resume` runs
	 * in a DIFFERENT process than the (exited) loop, so two concurrent resumes both see
	 * `stuck`, both pass the CAS, both spawn → double background loops, double budget burn.
	 *
	 * Fix: wrap the read-modify-write in an O_EXCL lockfile per goalId. O_EXCL is atomic at the
	 * OS level — only one process can create the lockfile. The operation is fast (ms), so stale
	 * lockfiles are rare; a 5s age guard force-clears them (crash recovery).
	 */
	compareAndSetStatus(goalId: string, expected: GoalLoopStatus, next: GoalLoopStatus, eventsPath?: string): GoalLoopState | undefined {
		const lockPath = `${goalFilePath(this.cwd, goalId)}.cas.lock`;
		if (!this.acquireCasLock(lockPath)) {
			return undefined; // Another process holds the CAS lock — caller treats as CAS-failed.
		}
		try {
			const current = this.load(goalId);
			if (!current) return undefined;
			if (current.state !== expected) return undefined; // CAS failed — state moved underneath us.
			const updated: GoalLoopState = { ...current, state: next };
			this.save(updated, eventsPath);
			return updated;
		} finally {
			try {
				unlinkSync(lockPath);
			} catch {
				/* best-effort; may already be gone */
			}
		}
	}

	/** Acquire an O_EXCL lockfile for CAS, with stale-lock recovery (5s age guard). */
	private acquireCasLock(lockPath: string): boolean {
		try {
			const fd = openSync(lockPath, "wx"); // O_EXCL — throws EEXIST if already exists.
			closeSync(fd);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") return false;
			// Stale recovery: if the lockfile is older than 5s, force-delete and retry once.
			try {
				const stat = statSync(lockPath);
				if (Date.now() - stat.mtimeMs > 5000) {
					unlinkSync(lockPath);
					const fd = openSync(lockPath, "wx");
					closeSync(fd);
					return true;
				}
			} catch {
				/* fall through */
			}
			return false;
		}
	}

	/** Remove a goal file (used by `goal clear`). Returns true if deleted. */
	remove(goalId: string): boolean {
		try {
			const path = goalFilePath(this.cwd, goalId);
			if (!existsSync(path)) return false;
			unlinkSync(path);
			return true;
		} catch (error) {
			logInternalError("goal-state-store.remove", error, `goalId=${goalId}`);
			return false;
		}
	}

	/** List all known goals (newest first by updatedAt). */
	list(): GoalLoopState[] {
		try {
			const root = resolveGoalsRoot(this.cwd);
			if (!existsSync(root)) return [];
			const entries = readdirSync(root) as string[];
			const goals: GoalLoopState[] = [];
			for (const entry of entries) {
				if (!entry.endsWith(".json")) continue;
				const goalId = entry.slice(0, -".json".length);
				// Skip entries that fail the safe-id check (defensive; createGoalId always produces safe ids).
				if (!/^[A-Za-z0-9_-]+$/.test(goalId)) continue;
				const g = this.load(goalId);
				if (g) goals.push(g);
			}
			goals.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
			return goals;
		} catch (error) {
			logInternalError("goal-state-store.list", error, `cwd=${this.cwd}`);
			return [];
		}
	}
}
