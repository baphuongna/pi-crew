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
 *
 * w3-dwf-trust (2026-10-29): the checkpoint path (<crewRoot>/state/runs/<runId>/) is
 * writable by every WRITE-role child worker of the run (same OS uid), so the "sole
 * writer is the runner" assumption is FALSE. load() therefore validates at the
 * hydration boundary: runId binding (expectedRunId), numeric clamps on spent/
 * agentCount, container-shape checks, and a producer-shape verdict allowlist over
 * completedAgentCalls entries — forged or schema-invalid state fails closed to
 * re-execution instead of replaying as trusted. See sanitizeCheckpoint below.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteJson } from "../state/atomic-write.ts";
import { logInternalError } from "../utils/internal-error.ts";
import type { AgentResult } from "./goal-workflow/dynamic-workflow-context.ts";

/** R6-12 (DR-03 round-6, 2026-10-16): current DWF checkpoint format version.
 *  Bumped whenever the persisted shape changes incompatibly — the loader
 *  rejects unknown FUTURE versions (see DwfStore.load) so a newer checkpoint
 *  is never silently mis-hydrated by an older binary. */
export const DWF_CHECKPOINT_VERSION = 1;

export interface DwfCheckpointState {
	/** R6-12: format version. Always DWF_CHECKPOINT_VERSION on write (save()
	 *  stamps it like updatedAt); load() tolerates a missing version (legacy
	 * pre-R6-12 checkpoints written by the version-less code — otherwise an
	 * in-flight run would lose its resume state across an upgrade) but rejects
	 * any other value. */
	version: typeof DWF_CHECKPOINT_VERSION;
	runId: string;
	vars: Record<string, unknown>;
	phases: string[];
	currentPhase: string | undefined;
	logs: string[]; // capped copy (≤1000); the events log (dwf.log) is the durable source of truth
	spent: number; // budget accumulator (round-14 P1-2)
	agentCount: number;
	/** PERS-1: per-agent-call idempotency cache. Maps a deterministic call ID to
	 *  the cached FULL AgentResult (R6-3: text + usage + structured + artifactPath
	 *  + actual durationMs — previously only {text,usage}, so replayed steps lost
	 *  structured output and artifact linkage) so a DWF resume skips
	 *  already-completed agent calls (avoids duplicating artifacts/mailbox/tokens).
	 *  Uses Record (not Map) for JSON serialization safety. Optional: legacy
	 *  checkpoints (and fresh states) omit it. */
	completedAgentCalls?: Record<string, AgentResult>;
	/** R14-C3 (wave 7, 2026-10-20): dispatch-time run context fingerprint. On
	 * save the runner stamps {modelOverride, team}; on resume a mismatch with
	 * the CURRENT dispatch context emits dwf.resume_context_mismatch — replayed
	 * agent results were produced under a different model/team and the operator
	 * should know (fail-open with visibility; the completed-call cache is still
	 * intentional work-skip). Absent on legacy checkpoints → check skipped. */
	dispatchContext?: { modelOverride?: string; team?: string };
	updatedAt: string;
}

// ─── w3-dwf-trust (2026-10-29): hydration-boundary validation ─────────────
// The checkpoint file lives under the shared repo where WRITE-role child
// workers can write it, so load() revalidates instead of blind-casting. These
// helpers narrow the parsed JSON (typed as `unknown` — no `any`) into a
// DwfCheckpointState, dropping or resetting anything the runner could not
// have produced. Fail-closed policy: schema-invalid containers reject the
// whole checkpoint (fresh run); invalid per-call entries are dropped (call
// re-executes); invalid numeric accumulators clamp to 0.

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** String[] narrowing: non-array → undefined (reject), non-string elements filtered out. */
const sanitizeStringArray = (value: unknown): string[] | undefined => {
	if (!Array.isArray(value)) return undefined;
	return value.filter((entry): entry is string => typeof entry === "string");
};

/** Numeric control accumulator clamp: finite non-negative numbers pass; anything else → 0
 *  (a forged negative `spent` inflated budget.remaining() past the dispatched cap, and a
 *  negative/reset `agentCount` re-armed the agent-call cap). */
const clampNonNegativeNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/** Optional finite non-negative number field (usage parts, durationMs): keep when valid, drop when not. */
const optionalNonNegativeNumber = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Validate one hydrated completedAgentCalls entry against the runner's producer shape.
 *  Verdict allowlist: the runner caches ONLY successful results (ok exactly boolean true,
 *  string text) — anything else was never produced by loadWorkflowModule's runner, so it
 *  is dropped (the call re-executes on resume) rather than replayed with ok forced true.
 *  Optional fields are kept only when correctly typed; `structured` is post-JSON-parse by
 *  construction and survives as-is (deep schema re-validation needs the call's schema,
 *  which the checkpoint format does not carry — the dispatch-side pin/runId binding is
 *  the load-bearing control for forged-but-well-formed entries). */
function sanitizeAgentResult(value: unknown): AgentResult | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.ok !== true) return undefined;
	if (typeof value.text !== "string") return undefined;
	const result: AgentResult = { ok: true, text: value.text };
	if (value.structured !== undefined) result.structured = value.structured;
	if (isPlainObject(value.usage)) {
		const usage: AgentResult["usage"] = {};
		const input = optionalNonNegativeNumber(value.usage.input);
		const output = optionalNonNegativeNumber(value.usage.output);
		const cost = optionalNonNegativeNumber(value.usage.cost);
		const turns = optionalNonNegativeNumber(value.usage.turns);
		if (input !== undefined) usage.input = input;
		if (output !== undefined) usage.output = output;
		if (cost !== undefined) usage.cost = cost;
		if (turns !== undefined) usage.turns = turns;
		if (Object.keys(usage).length > 0) result.usage = usage;
	}
	if (typeof value.runId === "string") result.runId = value.runId;
	if (typeof value.taskId === "string") result.taskId = value.taskId;
	if (typeof value.artifactPath === "string") result.artifactPath = value.artifactPath;
	if (typeof value.error === "string") result.error = value.error;
	const durationMs = optionalNonNegativeNumber(value.durationMs);
	if (durationMs !== undefined) result.durationMs = durationMs;
	return result;
}

/** Bind + revalidate a version-guarded checkpoint record into a DwfCheckpointState.
 *  Returns undefined when the record is schema-invalid or bound to another run
 *  (fail closed to re-execution, never trusted replay). */
function sanitizeCheckpoint(record: Record<string, unknown>, expectedRunId: string | undefined): DwfCheckpointState | undefined {
	// (1) RunId binding: the runner passes manifest.runId, so a checkpoint for a
	// different (stale/planted/enumerated) run never hydrates as this run's state.
	if (expectedRunId !== undefined && record.runId !== expectedRunId) {
		logInternalError(
			"dwf-state-store.load",
			new Error("checkpoint runId mismatch — rejecting checkpoint, run restarts fresh"),
			`expectedRunId=${expectedRunId}, checkpointRunId=${record.runId}`,
		);
		return undefined;
	}
	if (typeof record.runId !== "string") return undefined;
	const runId = record.runId;

	// (2) Required-shape containers. Non-conforming shape → reject the whole
	// checkpoint (schema-invalid state must never hydrate partially).
	if (record.vars !== undefined && !isPlainObject(record.vars)) return undefined;
	const phases = sanitizeStringArray(record.phases);
	if (phases === undefined) return undefined;
	const logs = sanitizeStringArray(record.logs);
	if (logs === undefined) return undefined;
	if (record.currentPhase !== undefined && typeof record.currentPhase !== "string") return undefined;
	const currentPhase: string | undefined = record.currentPhase;

	// (3) Numeric control accumulators clamp (never trust worker-writable arithmetic).
	const spent = clampNonNegativeNumber(record.spent);
	const agentCount = clampNonNegativeNumber(record.agentCount);

	// (4) Per-call replay cache: drop schema-invalid / non-producer-reachable entries.
	let completedAgentCalls: Record<string, AgentResult> | undefined;
	if (record.completedAgentCalls !== undefined) {
		if (!isPlainObject(record.completedAgentCalls)) {
			logInternalError(
				"dwf-state-store.load",
				new Error("checkpoint completedAgentCalls is not an object — dropping the replay cache (calls re-execute on resume)"),
				`runId=${runId}`,
			);
		} else {
			completedAgentCalls = {};
			let dropped = 0;
			for (const [callId, entry] of Object.entries(record.completedAgentCalls)) {
				const sanitized = sanitizeAgentResult(entry);
				if (sanitized !== undefined) {
					completedAgentCalls[callId] = sanitized;
				} else {
					dropped++;
				}
			}
			if (dropped > 0) {
				logInternalError(
					"dwf-state-store.load",
					new Error(
						`${dropped} checkpoint agent-call entr${dropped === 1 ? "y" : "ies"} failed hydration validation and ${dropped === 1 ? "was" : "were"} dropped (the call${dropped === 1 ? " re-executes" : "s re-execute"} on resume)`,
					),
					`runId=${runId}`,
				);
			}
		}
	}

	// (5) dispatchContext fingerprint: keep only correctly typed fields (the runner
	// compares it against the current dispatch and emits a mismatch event).
	let dispatchContext: DwfCheckpointState["dispatchContext"];
	if (isPlainObject(record.dispatchContext)) {
		dispatchContext = {};
		if (typeof record.dispatchContext.modelOverride === "string") dispatchContext.modelOverride = record.dispatchContext.modelOverride;
		if (typeof record.dispatchContext.team === "string") dispatchContext.team = record.dispatchContext.team;
	}

	// vars was shape-checked above (undefined or plain object); default {} for legacy absence.
	const vars: Record<string, unknown> = isPlainObject(record.vars) ? record.vars : {};
	return {
		version: DWF_CHECKPOINT_VERSION,
		runId,
		vars,
		phases,
		currentPhase,
		logs,
		spent,
		agentCount,
		...(completedAgentCalls !== undefined ? { completedAgentCalls } : {}),
		...(dispatchContext !== undefined ? { dispatchContext } : {}),
		updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : new Date().toISOString(),
	};
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

	/** Load the checkpoint for this stateRoot.
	 *
	 *  w3-dwf-trust (2026-10-29): the checkpoint file lives under the shared repo
	 *  (<crewRoot>/state/runs/<runId>/dwf-checkpoint.json) where every WRITE-role
	 *  child worker of the run can also write (same OS uid), so the file can no
	 *  longer be treated as runner-only ground truth. Hydration now validates at
	 *  this boundary instead of blind-casting:
	 *
	 *  - `expectedRunId` (passed by dynamic-workflow-runner.ts as manifest.runId)
	 *    binds the checkpoint to the resuming run — a foreign/stale runId is
	 *    rejected (→ undefined → fresh run) instead of replayed.
	 *  - Control accumulators are clamped: `spent`/`agentCount` must be finite
	 *    non-negative numbers, else reset to 0 (a forged negative `spent` used to
	 *    inflate budget.remaining() past the dispatched cap and a negative
	 *    `agentCount` re-armed the SDD-3 G13 agent-call cap).
	 *  - Schema-invalid containers (non-array phases/logs, non-object vars, a
	 *    non-string currentPhase) reject the WHOLE checkpoint (fail closed to
	 *    re-execution).
	 *  - Hydrated `completedAgentCalls` entries are re-validated against the
	 *    producer's shape: the runner caches ONLY successful results
	 *    (`ok === true`, string `text`), so entries failing that verdict
	 *    allowlist/shape are DROPPED (the call re-executes on resume) and
	 *    optional fields are stripped when mistyped. Anomalies are logged via
	 *    logInternalError so quarantines are observable (not silently swallowed).
	 *
	 *  Returns undefined if missing/corrupt/tampered (fresh run). */
	load(expectedRunId?: string): DwfCheckpointState | undefined {
		const path = this.path;
		try {
			if (!existsSync(path)) return undefined;
			const raw = readFileSync(path, "utf-8");
			const parsed: unknown = JSON.parse(raw);
			// Corrupt-guard: a valid checkpoint must be a plain JSON object with a
			// string runId (mirrors GoalStore.load's typeof parsed.goalId !== "string"
			// check). Arrays and primitives are rejected outright.
			if (!isPlainObject(parsed) || typeof parsed.runId !== "string") return undefined;
			// R6-12: version guard, mirroring the recovery/checkpoint.ts runId-guard
			// style (typed mismatch → treat as not-loadable). A checkpoint from an
			// unknown FUTURE version is REJECTED (→ undefined → fresh run) rather than
			// mis-hydrated — a newer format's fields mean nothing to this binary.
			// A MISSING version is accepted as legacy (written by the pre-R6-12 code,
			// shape-identical otherwise) so an in-flight run survives an upgrade.
			// Logged (not silent) so the quarantine is observable in diagnostics.
			if (parsed.version !== undefined && parsed.version !== DWF_CHECKPOINT_VERSION) {
				logInternalError(
					"dwf-state-store.load",
					new Error(
						`unknown dwf-checkpoint version ${String(parsed.version)} (expected ${DWF_CHECKPOINT_VERSION}) — rejecting checkpoint, run restarts fresh`,
					),
					`runId=${parsed.runId}`,
				);
				return undefined;
			}
			// w3-dwf-trust: bind + revalidate at the hydration boundary (never blind-cast).
			return sanitizeCheckpoint(parsed, expectedRunId);
		} catch {
			return undefined;
		}
	}

	/** Atomically persist a checkpoint state. Stamps `version` (R6-12) and
	 *  `updatedAt` (callers need not set either). */
	save(state: DwfCheckpointState): void {
		const path = this.path;
		const next = { ...state, version: DWF_CHECKPOINT_VERSION, updatedAt: new Date().toISOString() };
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
