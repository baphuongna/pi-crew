/**
 * dwf-state-store.ts — Persistent checkpoint state for dynamic-workflow runs (P2-3, round-18).
 *
 * Modeled on GoalStore (goal-state-store.ts) and FileCheckpointStore (checkpoint.ts),
 * but scoped to a single run's stateRoot (which is already <crewRoot>/state/runs/<runId>).
 *
 * Stores DwfCheckpointState as atomic JSON at <stateRoot>/dwf-checkpoint.json.
 * atomicWriteJson (temp + rename + fsync) guarantees either the old or the new file,
 * never a partial write — safe across crashes.
 *
 * Resume semantics (round-18): the runner loads a checkpoint on run start and hydrates
 * ctx.vars/phases/logs from it; on clean completion the runner deletes it. A missing or
 * corrupt checkpoint is treated as a fresh run (load() returns undefined). If a crash
 * happens mid-agent, that agent simply re-runs from scratch on resume — agent results
 * are expected to be idempotent-ish.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { logInternalError } from "../utils/internal-error.ts";

export interface DwfCheckpointState {
	runId: string;
	vars: Record<string, unknown>;
	phases: string[];
	currentPhase: string | undefined;
	logs: string[]; // capped copy (≤1000); the events log (dwf.log) is the durable source of truth
	spent: number; // budget accumulator (round-14 P1-2)
	agentCount: number;
	/** PERS-1: per-agent-call idempotency cache. Maps a deterministic call ID to the
	 *  cached result so a DWF resume skips already-completed agent calls (avoids
	 *  duplicating artifacts/mailbox/tokens). Uses Record (not Map) for JSON
	 *  serialization safety. */
	completedAgentCalls?: Record<string, { text: string; usage?: { input: number; output: number } }>;
	updatedAt: string;
}

/**
 * DwfStore — atomic CRUD for a single run's DWF checkpoint.
 *
 * Concurrency: writes are atomic (atomicWriteJson). The DWF runner is the sole
 * writer during a run; `team resume` loads the checkpoint read-only before the
 * script re-executes. No file-lock is needed here because only one runner owns a
 * run's stateRoot at a time (run locks protect manifest transitions elsewhere).
 *
 * Note: the constructor takes the run's stateRoot directly (NOT cwd + runId) to
 * avoid a double-nesting bug — stateRoot is already <crewRoot>/state/runs/<runId>,
 * so the checkpoint lands at <crewRoot>/state/runs/<runId>/dwf-checkpoint.json.
 * This mirrors FileCheckpointStore (checkpoint.ts: constructor(stateRoot)).
 */
export class DwfStore {
	private readonly stateRoot: string;

	constructor(stateRoot: string) {
		this.stateRoot = stateRoot;
	}

	private get path(): string {
		return `${this.stateRoot}/dwf-checkpoint.json`;
	}

	/** Load the checkpoint for this run's stateRoot. Returns undefined if missing or corrupt (fresh run). */
	load(): DwfCheckpointState | undefined {
		const path = this.path;
		try {
			if (!existsSync(path)) return undefined;
			const raw = readFileSync(path, "utf-8");
			const parsed = JSON.parse(raw);
			// Corrupt-guard: a valid checkpoint must be an object with a string runId
			// (mirrors GoalStore.load's typeof parsed.goalId !== "string" check).
			if (!parsed || typeof parsed !== "object" || typeof parsed.runId !== "string") return undefined;
			return parsed as DwfCheckpointState;
		} catch {
			return undefined;
		}
	}

	/** Atomically persist a checkpoint state. Stamps `updatedAt` (callers need not set it). */
	save(state: DwfCheckpointState): void {
		const path = this.path;
		const next = { ...state, updatedAt: new Date().toISOString() };
		try {
			mkdirSync(dirname(path), { recursive: true });
			atomicWriteJson(path, next);
		} catch (error) {
			logInternalError("dwf-state-store.save", error, `runId=${state.runId}`);
			throw error;
		}
	}

	/** Remove the checkpoint file (after a clean completion). Best-effort; never throws. */
	delete(): void {
		const path = this.path;
		try {
			if (!existsSync(path)) return;
			unlinkSync(path);
		} catch (error) {
			logInternalError("dwf-state-store.delete", error);
		}
	}
}
