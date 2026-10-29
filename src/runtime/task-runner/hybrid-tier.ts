/**
 * hybrid-tier.ts — U11 hybrid 2-tier worker model: tier orchestration layer.
 *
 * Spec (pi-crew-upgrade-spec-2026-10-09.md §U11, Tier 3): the embedded tier
 * (in-process live-session workers, the U4 stack) is DEFAULT-OFF — subprocess
 * stays the only tier unless a role explicitly opts in via
 * `runtime.embeddedWorkers.roles`. This module owns everything the embedded
 * tier adds AROUND the existing live-session executor:
 *
 *   - planEmbeddedTier — the per-task routing decision (role opt-in, sticky
 *     fault-threshold downgrade, depth/isolation guards via
 *     resolveTaskRuntimeKind). Emits `tier.decision` when the policy actually
 *     affects a task; silent for every task it does not route.
 *   - runEmbeddedTier — the execution wrapper: SHARED global worker-slot
 *     budget (the same acquireWorkerSlot semaphore the subprocess tier uses —
 *     no budget bypass for the embedded path), a fail-fast embedded-session
 *     ceiling (blast-radius bound, spec U11 risk #2), the per-task fault
 *     ledger (persisted in task.diagnostics via persistSingleTaskUpdate), and
 *     the automatic 2-fault fallback decision (`tier.fault` / `tier.fallback`).
 *
 * This module is LAZY-imported by task-runner.ts ONLY when
 * `runtime.embeddedWorkers.enabled === true` — the default-off path never
 * loads it (no imports, no events, no budget reads, zero behavior change).
 *
 * Phase-1 interface contract (explorer adaptive-01, lane A↔B seam): the fault
 * discriminator crosses the live-session boundary as
 * `RunLiveTaskOutput.fault` (LiveSessionFault, lane-B taxonomy; classified in
 * live-executor.ts with a seam-level fallback); this layer
 * consumes it and never reaches into src/runtime/live-session/**.
 *
 * Sink-exclusivity invariant (crew-agent-records.ts:1032 — a task's sinks
 * have exactly one writer at a time): the subprocess fallback is strictly
 * SEQUENTIAL — `runLive` must fully resolve (its forced `attempt_finished`
 * flush ran) before the caller dispatches the child tier to the same task id.
 * runEmbeddedTier therefore returns the fallback DECISION; task-runner.ts
 * performs the child dispatch after this call resolves.
 *
 * Steer/abort parity: this layer is transparent to both control channels —
 * the embedded attempt keeps the live-session steer/abort surface
 * (live-agent-control) and the fallback subprocess attempt keeps the broker
 * steering-file surface. The caller's AbortSignal is threaded into the slot
 * WAIT (same contract as the subprocess tier's withWorkerSlot: abort while
 * queued → acquire rejects, no slot taken, fn never runs) and an aborted
 * attempt is NEVER counted as a fault (a cancelled task must not respawn on
 * the other tier).
 */

import type { CrewRuntimeConfig } from "../../config/config.ts";
import { embeddedTierRefusedBySandbox, embeddedTierSandboxRefusalReason } from "../../config/sanitize-project-config.ts";
import { flushPendingAtomicWrites } from "../../state/atomic-write.ts";
import { appendEventFireAndForget } from "../../state/event-log/event-log.ts";
import { loadRunManifestById } from "../../state/stores/state-store.ts";
import type { ArtifactDescriptor, TeamRunManifest, TeamTaskState } from "../../state/types.ts";
import type { CrewRuntimeKind } from "../crew-agent-runtime.ts";
import type { WorkerStartupEvidence } from "../heartbeat/worker-startup.ts";
// Type-only (erased): lane-B U11 contract type — the fault taxonomy crossing
// the live-session boundary (Phase-1 interface contract).
import type { LiveSessionFault } from "../live-session/embedded-tier.ts";
import { resolveEmbeddedFaultThreshold, resolveTaskRuntimeKind } from "../model/runtime-policy.ts";
import type { ParsedPiJsonOutput } from "../output/pi-json-output.ts";
import { acquireWorkerSlot, getWorkerCapCapacity, releaseWorkerSlot } from "../scheduling/global-worker-cap.ts";
import { createEmbeddedSlotBudget, defaultEmbeddedSlotCeiling, type NestedSlotBudget } from "../scheduling/nested-slots.ts";
import { persistSingleTaskUpdate } from "./state-helpers.ts";

// ─── Fault ledger (persisted per task in task.diagnostics) ──────────────────

/** Shape stored under `task.diagnostics.embeddedTier` (durable via tasks.json). */
export interface EmbeddedTierLedger {
	faultCount: number;
	lastFaultKind?: LiveSessionFault["kind"];
	lastFaultAt?: string;
}

const LEDGER_KEY = "embeddedTier";

/** Read the persisted embedded-fault count for a task (0 when never faulted). */
export function readEmbeddedFaultCount(task: TeamTaskState): number {
	const ledger = task.diagnostics?.[LEDGER_KEY] as Partial<EmbeddedTierLedger> | undefined;
	return typeof ledger?.faultCount === "number" && Number.isFinite(ledger.faultCount) && ledger.faultCount > 0
		? Math.floor(ledger.faultCount)
		: 0;
}

/**
 * Freshest fault count for a task: max(in-memory record, durable store).
 *
 * WHY THE DISK MERGE: the caller's retry loop (executeWithRetry) re-invokes
 * runTeamTask with the SAME in-memory task object it captured at dispatch —
 * it does NOT reload tasks.json between attempts. A fault persisted during
 * attempt 1 is therefore invisible in attempt 2's in-memory record. Reading
 * the durable store (best-effort, same pattern as live-executor's isCurrent)
 * makes the sticky downgrade actually sticky across retries/recovery, and
 * the max() merge keeps a fresher in-memory count winning when the store
 * read fails.
 */
function freshestEmbeddedFaultCount(manifest: TeamRunManifest, task: TeamTaskState): number {
	const fromMemory = readEmbeddedFaultCount(task);
	let fromDisk = 0;
	try {
		const loaded = loadRunManifestById(manifest.cwd, manifest.runId);
		const stored = loaded?.tasks.find((t) => t.id === task.id);
		if (stored) fromDisk = readEmbeddedFaultCount(stored);
	} catch {
		// Best-effort merge — a store read failure keeps the in-memory count.
	}
	return Math.max(fromMemory, fromDisk);
}

/**
 * Persist one counted embedded fault for the task (CAS merge via
 * persistSingleTaskUpdate — the sanctioned single-task writer). Returns the
 * updated task/tasks pair; the count is sticky for every future attempt of
 * this task, which is what makes the downgrade survive retries/recovery.
 */
export function persistEmbeddedFault(
	manifest: TeamRunManifest,
	tasks: TeamTaskState[],
	task: TeamTaskState,
	fault: LiveSessionFault,
): { tasks: TeamTaskState[]; task: TeamTaskState; faultCount: number } {
	// Merge from the durable store — see freshestEmbeddedFaultCount for why the
	// in-memory record alone under-counts across retry attempts.
	const faultCount = freshestEmbeddedFaultCount(manifest, task) + 1;
	const ledger: EmbeddedTierLedger = {
		faultCount,
		lastFaultKind: fault.kind,
		lastFaultAt: new Date().toISOString(),
	};
	const faulted: TeamTaskState = {
		...task,
		diagnostics: { ...(task.diagnostics ?? {}), [LEDGER_KEY]: ledger },
	};
	const updatedTasks = persistSingleTaskUpdate(manifest, tasks, faulted);
	// The fault ledger is CROSS-ATTEMPT coordination state: drain the 50ms
	// coalesce buffer so the next attempt's freshest-count read (or a
	// concurrent recovery re-dispatch) sees the count immediately. Faults are
	// rare; a synchronous drain here is the price of a deterministic 2-fault
	// downgrade across retry attempts.
	flushPendingAtomicWrites();
	return { tasks: updatedTasks, task: faulted, faultCount };
}

// ─── Tier plan (routing decision) ────────────────────────────────────────────

export type EmbeddedWorkersPolicy = NonNullable<CrewRuntimeConfig["embeddedWorkers"]>;

export interface PlanEmbeddedTierInput {
	/** What the task would run as WITHOUT the embedded tier (taskRuntimeOverride ?? runtimeKind). */
	baseRuntimeKind: CrewRuntimeKind;
	role: string;
	isolationPolicy?: CrewRuntimeConfig["isolationPolicy"];
	runtimeConfig?: CrewRuntimeConfig;
	task: TeamTaskState;
	/** Run manifest — source of the durable fault ledger + structured events. */
	manifest: TeamRunManifest;
	env?: NodeJS.ProcessEnv;
}

/** An embedded-tier routing plan. `undefined` = policy does not affect this task. */
export type EmbeddedTierPlan =
	| { route: "embedded"; policy: EmbeddedWorkersPolicy; faultCount: number; threshold: number }
	| { route: "subprocess"; reason: "fault-threshold"; policy: EmbeddedWorkersPolicy; faultCount: number; threshold: number };

/**
 * Decide the tier for one task. Pure decision + event emission; no budgets,
 * no execution. Every guard lives in resolveTaskRuntimeKind so the routing
 * rule has exactly one home:
 *
 *   resolved == "live-session" && base == "child-process" → embedded route
 *
 * A base of "live-session" (legacy runtime.mode=live-session) is deliberately
 * NOT a hybrid route — that path is frozen (ADR 2026-08-15 decision (a)) and
 * keeps its pre-U11 semantics (no slot budget, no fault ledger). Operators
 * who want the mitigated embedded tier opt roles into `embeddedWorkers` with
 * the default child-process mode.
 */
export function planEmbeddedTier(input: PlanEmbeddedTierInput): EmbeddedTierPlan | undefined {
	const policy = input.runtimeConfig?.embeddedWorkers;
	if (policy?.enabled !== true) return undefined;
	const faultCount = freshestEmbeddedFaultCount(input.manifest, input.task);
	const threshold = resolveEmbeddedFaultThreshold(policy);
	const env = input.env ?? process.env;
	const { manifest } = input;
	// w4b defense-in-depth wiring (SEC-2026-11 embeddedWorkers.project-tier-routing):
	// a live sandbox posture (PI_CREW_SANDBOX=bwrap) means the user opted into an
	// OS boundary around workers. The embedded tier runs IN-PROCESS with neither
	// the bwrap boundary nor the child-env secret scrub, so routing would void
	// that opt-in. Fail closed: refuse embedded routing (subprocess tier keeps
	// the sandbox), with a visible tier.decision warning.
	if (embeddedTierRefusedBySandbox(env)) {
		appendEventFireAndForget(manifest.eventsPath, {
			type: "tier.decision",
			runId: manifest.runId,
			taskId: input.task.id,
			message: embeddedTierSandboxRefusalReason(env),
			data: { route: "subprocess", to: input.baseRuntimeKind, reason: "sandbox-opt-in" },
		});
		return undefined;
	}
	const resolved = resolveTaskRuntimeKind(input.baseRuntimeKind, input.role, input.isolationPolicy, env, {
		policy,
		faultCount,
	});
	if (resolved !== "live-session" || input.baseRuntimeKind === "live-session" || input.baseRuntimeKind === "scaffold") {
		// Not routed to embedded. Emit the downgrade decision ONLY when the
		// role opted in but the sticky fault threshold rerouted it —
		// isolated/non-opted roles stay silent (they are unaffected).
		if ((policy.roles ?? []).includes(input.role) && faultCount >= threshold && input.baseRuntimeKind === "child-process") {
			appendEventFireAndForget(manifest.eventsPath, {
				type: "tier.decision",
				runId: manifest.runId,
				taskId: input.task.id,
				message: `Embedded tier opted in but fault budget exhausted (${faultCount}/${threshold}) — routing subprocess`,
				data: { route: "subprocess", to: "child-process", reason: "fault-threshold", faultCount, threshold },
			});
			return { route: "subprocess", reason: "fault-threshold", policy, faultCount, threshold };
		}
		return undefined;
	}
	appendEventFireAndForget(manifest.eventsPath, {
		type: "tier.decision",
		runId: manifest.runId,
		taskId: input.task.id,
		message: `Role '${input.role}' opted into embedded tier — routing in-process live-session (faults ${faultCount}/${threshold})`,
		data: {
			route: "embedded",
			from: input.baseRuntimeKind,
			to: "live-session",
			reason: "role-opt-in",
			faultCount,
			threshold,
		},
	});
	return { route: "embedded", policy, faultCount, threshold };
}

// ─── Embedded-session ceiling (fail-fast blast-radius bound) ────────────────

let embeddedCeiling: { key: string; budget: NestedSlotBudget } | undefined;

function embeddedCeilingFor(policy: EmbeddedWorkersPolicy): NestedSlotBudget {
	const cap = getWorkerCapCapacity();
	const max = Math.max(1, policy.maxConcurrent ?? defaultEmbeddedSlotCeiling(cap));
	const key = `${cap}:${max}`;
	if (embeddedCeiling?.key !== key) embeddedCeiling = { key, budget: createEmbeddedSlotBudget(cap, max) };
	return embeddedCeiling.budget;
}

/** @internal Test-only: drop the ceiling singleton so tests can vary config/capacity. */
export function __test_resetEmbeddedCeiling(): void {
	embeddedCeiling = undefined;
}

// ─── Embedded-tier execution wrapper ─────────────────────────────────────────

/** What the live branch produces for one embedded attempt (structural subset of RunLiveTaskOutput). */
export interface EmbeddedLiveOutcome {
	task: TeamTaskState;
	tasks: TeamTaskState[];
	startupEvidence: WorkerStartupEvidence;
	exitCode: number | null;
	error?: string;
	fault?: LiveSessionFault;
	parsedOutput?: ParsedPiJsonOutput;
	resultArtifact: ArtifactDescriptor;
	logArtifact?: ArtifactDescriptor;
	transcriptArtifact?: ArtifactDescriptor;
}

export interface RunEmbeddedTierInput {
	plan: EmbeddedTierPlan & { route: "embedded" };
	manifest: TeamRunManifest;
	/** Pre-attempt task state (used for the ledger write if `runLive` throws). */
	task: TeamTaskState;
	tasks: TeamTaskState[];
	signal?: AbortSignal;
	runLive: () => Promise<EmbeddedLiveOutcome>;
}

export type EmbeddedTierRunOutcome =
	| { kind: "live"; live: EmbeddedLiveOutcome; faultCounted?: { faultCount: number; fault: LiveSessionFault } }
	| {
			kind: "fallback";
			reason: "fault-threshold" | "embedded-ceiling-exhausted" | "embedded-capacity-rejected" | "embedded-fault-thrown";
			task: TeamTaskState;
			tasks: TeamTaskState[];
			faultCount: number;
			fault?: LiveSessionFault;
			message?: string;
	  };

/**
 * Run ONE embedded attempt under the tier contracts:
 *
 *  1. fail-fast embedded ceiling — exhausted → immediate subprocess reroute
 *     (never queues; the rerouted child queues on the SHARED global budget
 *     like any subprocess task);
 *  2. SHARED global worker slot (acquireWorkerSlot — the exact semaphore the
 *     subprocess tier uses; abort while queued rejects the acquire and never
 *     takes a slot);
 *  3. on a counted fault (fault.countAsFault true): ledger++,
 *     `tier.fault` event, and — at the threshold — `tier.fallback` + a
 *     fallback decision for the caller (which then dispatches the child tier
 *     sequentially; sinks are quiescent once `runLive` resolved).
 *
 * An aborted attempt (caller signal, or fault.countAsFault false non-capacity)
 * is returned as-is: NOT counted, NEVER rerouted (a cancelled task must not
 * respawn).
 * A THROWN `runLive` counts as a "session-error" fault: below threshold the
 * error is rethrown (pre-U11 behavior for a throwing live attempt — the
 * caller's retry loop owns the next attempt); at/above threshold the caller
 * gets the fallback decision instead.
 */
export async function runEmbeddedTier(input: RunEmbeddedTierInput): Promise<EmbeddedTierRunOutcome> {
	const { plan, manifest, signal } = input;
	const taskId = input.task.id;
	const ceiling = embeddedCeilingFor(plan.policy);
	if (!ceiling.tryAcquire(taskId)) {
		appendEventFireAndForget(manifest.eventsPath, {
			type: "tier.decision",
			runId: manifest.runId,
			taskId,
			message: `Embedded ceiling exhausted (${ceiling.statusLine}) — rerouting subprocess immediately`,
			data: { route: "subprocess", to: "child-process", reason: "embedded-ceiling-exhausted", statusLine: ceiling.statusLine },
		});
		return {
			kind: "fallback",
			reason: "embedded-ceiling-exhausted",
			task: input.task,
			tasks: input.tasks,
			faultCount: readEmbeddedFaultCount(input.task),
		};
	}
	try {
		// SHARED budget: identical acquire/release contract as the subprocess
		// tier (run-worker.ts withWorkerSlot). An abort while queued rejects
		// here without consuming a slot — SemaphoreAbortedError propagates.
		await acquireWorkerSlot(signal);
		try {
			const live = await input.runLive();
			// Abort parity: an aborted attempt is NEVER counted and NEVER rerouted
			// (a cancelled task must not respawn on the other tier).
			if (signal?.aborted) return { kind: "live", live };
			const fault = live.fault;
			if (fault === undefined) return { kind: "live", live };
			if (fault.countAsFault === false) {
				// Routing signals, not worker faults (lane-B contract): aborted
				// family → return as-is (the caller's cancellation path owns the
				// task); capacity-rejected → immediate subprocess reroute WITHOUT
				// counting (the embedded tier was full — same semantics as the
				// routing-side ceiling above, just detected session-side).
				if (fault.kind === "capacity-rejected") {
					appendEventFireAndForget(manifest.eventsPath, {
						type: "tier.decision",
						runId: manifest.runId,
						taskId,
						message: "Embedded tier at capacity (session-side cap) — rerouting subprocess immediately",
						data: { route: "subprocess", to: "child-process", reason: "embedded-capacity-rejected", faultKind: fault.kind },
					});
					return {
						kind: "fallback",
						reason: "embedded-capacity-rejected",
						task: live.task,
						tasks: live.tasks,
						faultCount: readEmbeddedFaultCount(live.task),
						fault,
					};
				}
				return { kind: "live", live };
			}
			const counted = persistEmbeddedFault(manifest, live.tasks, live.task, fault);
			appendEventFireAndForget(manifest.eventsPath, {
				type: "tier.fault",
				runId: manifest.runId,
				taskId,
				message: `Embedded tier fault #${counted.faultCount}/${plan.threshold} (${fault.kind})`,
				data: { tier: "embedded", faultKind: fault.kind, faultCount: counted.faultCount, threshold: plan.threshold },
			});
			if (counted.faultCount < plan.threshold) {
				return {
					kind: "live",
					live: { ...live, task: counted.task, tasks: counted.tasks },
					faultCounted: { faultCount: counted.faultCount, fault },
				};
			}
			appendEventFireAndForget(manifest.eventsPath, {
				type: "tier.fallback",
				runId: manifest.runId,
				taskId,
				message: `Embedded fault budget exhausted (${counted.faultCount}/${plan.threshold}, last=${fault.kind}) — falling back to subprocess for this task`,
				data: {
					from: "live-session",
					to: "child-process",
					reason: "fault-threshold",
					faultKind: fault.kind,
					faultCount: counted.faultCount,
					threshold: plan.threshold,
				},
			});
			return {
				kind: "fallback",
				reason: "fault-threshold",
				task: counted.task,
				tasks: counted.tasks,
				faultCount: counted.faultCount,
				fault,
			};
		} finally {
			releaseWorkerSlot();
		}
	} catch (error) {
		// A THROWN live attempt: classify + count, then either rethrow (below
		// threshold — the caller's retry loop owns the next attempt, exactly
		// the pre-U11 contract for a throwing live attempt) or hand back the
		// fallback decision. The throw means no live writer remains, so a
		// sequential child dispatch keeps the single-writer invariant.
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		const fault: LiveSessionFault = { kind: "session-error", detail: message, countAsFault: true };
		const current = input.tasks.find((t) => t.id === taskId) ?? input.task;
		const counted = persistEmbeddedFault(manifest, input.tasks, current, fault);
		appendEventFireAndForget(manifest.eventsPath, {
			type: "tier.fault",
			runId: manifest.runId,
			taskId,
			message: `Embedded tier fault #${counted.faultCount}/${plan.threshold} (${fault.kind}, thrown: ${message.slice(0, 200)})`,
			data: { tier: "embedded", faultKind: fault.kind, faultCount: counted.faultCount, threshold: plan.threshold, thrown: true },
		});
		if (counted.faultCount < plan.threshold) throw error;
		appendEventFireAndForget(manifest.eventsPath, {
			type: "tier.fallback",
			runId: manifest.runId,
			taskId,
			message: `Embedded fault budget exhausted (${counted.faultCount}/${plan.threshold}, thrown) — falling back to subprocess for this task`,
			data: {
				from: "live-session",
				to: "child-process",
				reason: "fault-threshold",
				faultKind: fault.kind,
				faultCount: counted.faultCount,
				threshold: plan.threshold,
			},
		});
		return {
			kind: "fallback",
			reason: "fault-threshold",
			task: counted.task,
			tasks: counted.tasks,
			faultCount: counted.faultCount,
			fault,
			message,
		};
	} finally {
		ceiling.release(taskId);
	}
}
