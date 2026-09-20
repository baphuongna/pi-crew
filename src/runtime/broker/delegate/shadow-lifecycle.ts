/**
 * shadow-lifecycle.ts — broker-owned lifecycle for delegate grandchild SHADOW
 * task records (RR-012, findings F03/F16; ADR-5 §1/§3 S1#1).
 *
 * The `delegate.request` handler (crew-broker.ts) mints a `gc-*` shadow task
 * (agent "delegate", NO stepId) so the subId identity gets a real depth/role
 * entry. The record is NOT a workflow task: it is managed by the EXTERNAL
 * grandchild spawner (the broker), never by the workflow scheduler.
 * isDelegateShadowTask() is the single discriminator the scheduler uses to
 * keep shadow records out of DAG/batch selection — they carry no stepId, and
 * dispatching one would throw ResourceNotFound in findStep()/findAgent()
 * (dispatch-batch.ts; RR-012 §3 reachability proof in
 * test/unit/runtime/broker/shadow-task-dag-readiness.test.ts).
 *
 * BR-09 (discriminator correctness): the marker is STRUCTURAL — the absence of
 * `stepId` — NOT the agent name. Every scheduler-managed task sets
 * `stepId: step.id` (state-store.ts materializeTasks), so "no stepId" means
 * "not a workflow task". The previous test (`agent === "delegate"`) filtered
 * out any LEGITIMATE workflow task whose resolved agent happens to be named
 * `delegate` — such a task never entered a batch, was never dispatched, and
 * finalize-run then marked the whole run `blocked`. (`delegate` is deliberately
 * NOT in PROTECTED_AGENT_NAMES, so the name itself carries no reserved
 * meaning.) Backward compatible both ways: legacy persisted shadows also lack
 * `stepId` (still excluded) and legacy workflow tasks carry one (still
 * dispatched); no schema change.
 *
 * KNOWN overlap (cold-verify): `reconstructTasksFromEventLog`
 * (manifest-io.ts, ST-4 corruption recovery) also emits tasks WITHOUT `stepId`
 * — those are classified as shadows and excluded from dispatch selection.
 * That is fail-closed, and strictly better than the pre-guard behavior
 * (findStep would throw ResourceNotFound and kill the batch): reconstructed
 * tasks carry agent "unknown" and no step, so they cannot be dispatched
 * anyway. Do NOT reuse this predicate to mean "broker shadow" outside
 * scheduler selection.
 *
 * F16 lifecycle contract (broker-owned; every write under the run lock):
 *   queued    → saved by the admission write (crew-broker.ts handleDelegateRequest)
 *   running   → promoteShadowToRunning() from the spawner's onSpawn hook the
 *               moment the grandchild process exists (pid !== null). Idempotent:
 *               only a record still "queued" is promoted — a terminal flip or a
 *               stale-reconciler cancel always wins over a late promote.
 *   completed | failed → the unconditional terminal flip when the spawner
 *               settles (success, failure, error, timeout — every path).
 */

import { withRunLockSync } from "../../../state/coordination/locks.ts";
import { loadRunManifestById, saveRunTasks } from "../../../state/stores/state-store.ts";
import type { TeamTaskState } from "../../../state/types.ts";
import { logInternalError } from "../../../utils/internal-error.ts";

/** Shadow-task discriminator (RR-012 + BR-09): a task record managed by the
 *  external delegate-broker spawner rather than the workflow scheduler.
 *
 *  The marker is STRUCTURAL: shadow records are persisted with NO `stepId`
 *  (the broker's shadow literal in crew-broker.ts sets none), while every
 *  scheduler-materialized task sets `stepId: step.id`. A record without a
 *  stepId cannot be dispatched anyway — `findStep()` matches on `stepId` and
 *  throws ResourceNotFound — so "no stepId" is exactly the set the scheduler
 *  must skip. The agent name is NOT part of the predicate (BR-09: a real
 *  workflow task may legitimately resolve to an agent named `delegate`). */
export function isDelegateShadowTask(task: Pick<TeamTaskState, "id" | "agent" | "stepId">): boolean {
	return task.stepId === undefined;
}

/** F16: queued→running promote, called from the spawner's onSpawn hook when
 *  the grandchild process exists. Best-effort by design: a failure logs and
 *  leaves the record as-is — the unconditional terminal flip on settle still
 *  runs, so a promote failure can never strand a record in "queued" past the
 *  settle (and depth-3 admission merely stays blocked until then, which is
 *  the fail-closed direction). */
export function promoteShadowToRunning(brokerCwd: string, runId: string, subId: string): void {
	try {
		const fresh = loadRunManifestById(brokerCwd, runId);
		if (!fresh) return;
		withRunLockSync(fresh.manifest, () => {
			const latest = loadRunManifestById(brokerCwd, runId);
			if (!latest) return;
			const shadow = latest.tasks.find((t) => t.id === subId);
			if (shadow?.status !== "queued") return;
			saveRunTasks(
				latest.manifest,
				latest.tasks.map((t) => (t.id === subId ? { ...t, status: "running" as const } : t)),
			);
		});
	} catch (err) {
		logInternalError(
			"crew-broker.delegate.promote-shadow",
			err instanceof Error ? err : new Error(String(err)),
			`runId=${runId} subId=${subId}`,
		);
	}
}
