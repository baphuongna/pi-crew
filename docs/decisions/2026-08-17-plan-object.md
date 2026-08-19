# First-class Plan object: PlanRecord, plan-store, revisions, re-plan (R4)

**Date:** 2026-08-17 (drafted) / 2026-08-19 (accepted, review round 1 fixes)
**Status:** Accepted — T2 of the subagent v2 plan (`0.10.1` internal phase); prerequisite ADR for WP-4
**Relates to:** `src/state/types.ts` (`:230` manifest pointer), `src/runtime/plan-approval.ts`, `src/extension/plan-orchestrate.ts`, `src/runtime/goal-workflow/adaptive-plan.ts` (`:43` cap), `src/runtime/team-runner.ts` (`:808,:1055` readers), `src/runtime/stale-reconciler.ts` (`:46` reader), `src/extension/team-tool/api/plan-approval.ts`, `src/runtime/child-pi/child-pi-steering.ts` (`:25-75` wrap-up grace), `src/extension/team-tool/dispatch/index.ts` (`domainForAction :93`), `docs/design/subagent-v2-design.md` §5, `docs/design/subagent-v2-implementation-plan.md` (T2/WP-4)

## Context

Three plan representations exist today and none is queryable, versioned, or linked to task state:

1. **`manifest.planApproval`** (`src/state/types.ts:230`) — a *gate state*, not a plan. It says "approval pending/approved" but holds no phases, items, or tasks. Five reader families pin it: `team-runner.ts:808,1055` (cancel-on-deny), `stale-reconciler.ts:46` (`isPlanApprovalPending` protection), `plan-approval.ts:30-34` (predicate family) + `ensurePlanApprovalRequested`, `api/plan-approval.ts` (×6), plus every WP-3 UI surface.
2. **Adaptive assess** (`goal-workflow/adaptive-plan.ts`) — a throwaway in-memory `AdaptivePlan {phases}` that is immediately flattened into ≤ 12 injected tasks (`MAX_ADAPTIVE_TASKS = 12`, `:43`). The phase structure is lost at injection; there is no per-phase gating.
3. **`orchestrate planPath`** (`extension/plan-orchestrate.ts`) — parses tagged sections and *directly emits agent-chain commands*; nothing is persisted, nothing is diffable.

Consequences of the status quo: no revision history, no diff between plan versions, no per-item progress (tasks carry no link back to the plan item that spawned them), no re-plan without losing the old plan, `plan-execute` workflow exists only as docs prose, and approval gates a *state flag* rather than a plan artifact (design §5 problem statement).

## Decision

### 1. Schema — one revision-list file per run

`PlanRecord` (types in `src/state/types.ts`; store in NEW `src/state/stores/plan-store.ts`) persisted at
`<stateRoot>/plans/plans.json` (i.e. `.crew/state/runs/<runId>/plans/plans.json`) as a **revision list** — append-only array of PlanRecord snapshots; history is never mutated or compacted in place:

```ts
PlanRecord {
  id: string;            // uuid v4 — stable across the lineage (same id for every revision)
  runId: string;
  version: number;       // 1, 2, 3 … — increments per revision
  revisionOf?: { id: string; version: number };   // set for version ≥ 2
  title: string;
  phases: [{ id: string; title: string; itemIds: string[]; status: "pending"|"active"|"done"|"dropped" }];
  items:  [{ id: string; ref?: string; title: string; taskIds: string[]; specIds: string[];
             acceptance: string[]; status: "pending"|"active"|"done"|"dropped" }];
  approval?: { status: "pending"|"approved"|"rejected"; by?: string; at: string; planVersion: number };
  createdAt: string;     // ISO
  authorTaskId?: string; // planner-role producer provenance
}
```

Progress (`items[].progress`) is **derived at read time** from the linked `taskIds` statuses — it is never written by the scheduler (only `taskIds` is; see §3). `specIds` is the forward hook for R6 (T4); T2 writes it empty.

**Store discipline:** atomic write (tmp file + `rename`, same pattern as the other state stores) and **every write under `withRunLockSync`** (`state/coordination/locks.ts`). Reads are lock-free (single-file atomic rename makes readers see old-or-new, never torn).

### 2. Migration — dual-read, manifest field never dropped

New runs write **both**: the PlanRecord (new) and `manifest.planApproval` (legacy pointer, unchanged shape at `types.ts:230`) — plus a new manifest pointer `manifest.plan?: { id: string; version: number }` to the *current* revision.

The five reader families migrate to **plan-record-first, manifest-fallback** in WP-4:
`team-runner.ts:808,1055` · `stale-reconciler.ts:46` · `plan-approval.ts:30-35,42-73` · `api/plan-approval.ts` · UI snapshot assembly (WP-3 surfaces).

The `stale-reconciler` invariant (`blocked + planApproval.pending` → protected) keeps working **throughout** because the manifest field is never dropped: a pre-v2 run with no PlanRecord falls back to the manifest read and behaves exactly as before. The manifest field is *deprecated* (not removed) next minor. **Negative AC (test-pinned): a run created pre-v2 with `planApproval` pending is still protected by stale-reconciler after upgrade.**

### 3. Single-writer rule — the scheduler owns `items[].taskIds`

Producers create phases/items but **never** taskIds. The scheduler maintains `items[].taskIds` (append on dispatch, no-op on terminal) **inside the run lock**; per-item progress is a pure derivation over those taskIds.

**Item ids are stable across revisions** (producer contract: a carried-over item keeps its `id`). At revision switch the scheduler **copies forward** the known `taskIds` of carried-over items into the new revision (under the run lock, before the new revision becomes current) — linkage and progress survive re-plans; items the new revision omits are `dropped` (§4). The scheduler reads the **current revision only** (design §5): superseded revisions are inert history, so an item present in both revisions is never double-dispatched. This keeps one writer for linkage and makes "which task implements item X" mechanically answerable (`team plans get` shows it; `team status` can attribute).

### 4. Re-plan = new revision + soft-cancel dropped work

`team action='plan'`… **correction — erratum D-1 below**: re-plan lands as a **new revision** (`version+1`, `revisionOf` set) appended to `plans.json`. Items absent from the new revision are `dropped` in it; their **in-flight tasks are soft-cancelled**: the scheduler appends a wrap-up advisory to the worker's steering JSONL (the existing `ChildPiSteeringController` soft-limit mechanism, `child-pi-steering.ts:25-75` — advisory "wrap up now", hard abort only after grace turns). The task's terminal result is marked cancelled-by-replan in the event log (`plan.item.dropped`). No hard kill by default — the worker gets the grace window to checkpoint.

### 5. Per-phase cap replaces the global flatten cap

`MAX_ADAPTIVE_TASKS = 12` (global, `adaptive-plan.ts:43`) becomes a **per-phase** cap — a module constant `ADAPTIVE_MAX_TASKS_PER_PHASE = 12` in `adaptive-plan.ts` (deliberately NOT a config key in T2: the `adaptive` config section belongs to T3/WP-5's config surface, keeping WP-4's file ownership intact). Adaptive `assess` now emits a PlanRecord (phases/items) instead of flattening into ≤ 12 injected tasks; the scheduler expands **item → tasks** as phases activate. Old adaptive runs (no PlanRecord) keep working — they simply take the manifest-fallback read path (§2) and behave as before.

### 6. Three producers, one contract

1. `orchestrate planPath` parser → PlanRecord. The **tagged-chain markdown stays the authoring format**; parsing now persists a PlanRecord before emitting chain commands.
2. Adaptive `assess` → phases/items (§5).
3. Planner-role task output → same tagged contract (`<plan>…</plan>` blocks parsed into a PlanRecord; `authorTaskId` records provenance).

### 7. Erratum D-1 — action name is `plans`, not `plan`

Design §5 says `team action='plan'`, but `plan` **already exists with different semantics** (team/workflow plan preview (+ optional singleAgent composition); `RUN_ACTIONS` includes it — `schema/team-tool-schema.ts:385`, `dispatch/run.ts:30,41-42` routes to `handlePlan`). Overloading it would break singleAgent mode. The new action is **`team action='plans'`**:

- `get [--rev <n>]` — current (or pinned) revision, with derived per-item progress
- `list` — revision list (version, createdAt, title, revisionOf)
- `diff <a> <b>` — item/phase-level diff between two revisions
- `approve | reject` — approval write (§8)

New handler `src/extension/team-tool/plans.ts`; registration in `schema/team-tool-schema.ts` (`RUN_ACTIONS` + action count), `dispatch/index.ts` `domainForAction:93`, `dispatch/run.ts` (`RUN_DOMAIN_ACTIONS` + switch). Action-count / `dispatch-exhaustive` / `action-list-single-source` gate tests are updated in the same PR (anticipated by the plan's gate-test note).

### 8. Approval — dual-write, one predicate family

`plans approve|reject` (and the existing `team api op=approve-plan|cancel-plan`, and the WP-3 dashboard `A`/`n` keys) write **both**: `manifest.planApproval` (legacy) and `PlanRecord.approval = { status, by, at, planVersion }` — approval always names the plan id + version it approved. **Vocabulary mapping:** the manifest side keeps its existing enum (`PlanApprovalState.status: "pending"|"approved"|"cancelled"`, `types.ts:158`) — `plans reject` writes `cancelled` there and `rejected` in the PlanRecord. The gate predicate family (`isPlanApprovalStatePending`, `plan-approval.ts`) gains a plan-record-first variant with manifest fallback so every surface (scheduler, reconciler, UI) stays byte-identical.

### 9. Events

Event kinds registered in `TEAM_EVENT_TYPES` (`src/state/contracts.ts`): `plan.created`, `plan.revised`, `plan.rejected`, `plan.item.dropped` (new) — plus formalizing `plan.approved` and `plan.cancelled`, which `api/plan-approval.ts:66-67,144-145` already emits unregistered (pre-existing gap this ADR closes). **Every revision/approval mutation appends one event**; the scheduler's `taskIds` linkage writes (§3) append none (task dispatch already logs its own `worker.*` events).

### 10. Security & trust boundary

No new cross-run surface: `plans.json` lives under the run's state root (same trust domain as `tasks.json`/`events.jsonl`, single writer under the run lock). `plans approve|reject` ride the existing RUN-domain action auth (same ownership checks as `resume`/`steer`). `plans get/list/diff` are read-only. Plans can contain untrusted task-output prose (producer 3) — rendered with the same escaping discipline as other task text in CLI output.

## Consequences

- Revision history + diff become queryable (`team plans diff 1 2`); per-item progress is mechanically derived, not hand-maintained.
- Re-plan no longer discards the prior plan and no longer hard-kills in-flight work (soft-cancel with grace).
- Adaptive runs gain phase structure; the ≤ 12 global cap becomes per-phase (a plan with 3 phases may now schedule 36 tasks across its life — bounded per phase, visible in the plan).
- Migration cost: five reader sites move to plan-record-first + manifest-fallback in WP-4; dual-write for one minor version; negative AC pinned by test (`plan-migration.test.ts`).
- `plan-execute` workflow (docs-only today) becomes implementable on top of PlanRecord in a later train without schema churn (specIds hook lands empty in T2, filled by T4).

## Appendix — B2 battery case list (committed with the ADR, per plan §8)

Standard 9 tiers (skill `real-test-pi-crew`) plus the T2 extra cases:

- (a) `team plans get/list/diff` live on a real seeded run — correct revision rendering, derived progress.
- (b) **Re-plan mid-run**: run with in-flight task on an item that revision 2 drops → wrap-up steer advisory observed in the steering file, task terminal = soft-cancelled, event `plan.item.dropped`, diff 1↔2 shows the drop. Negative: item NOT dropped in-flight → untouched.
- (c) Approval dual-write live: `team plans approve` flips BOTH `PlanRecord.approval` (with planVersion) and `manifest.planApproval`; WP-3 dashboard `A` key still works on a record-backed run (dual-read).
- (d) **Migration negative AC live**: pre-v2-style run dir (manifest-only `planApproval` pending, no `plans.json`) → startup scan still protects it (no orphan-cancel, no stale-repair); `team plans get` degrades gracefully (fallback notice, no throw).
- (e) Adaptive goal run end-to-end: assess → PlanRecord phases/items, per-phase cap, run completes; re-run an OLD adaptive run (no record) → manifest-fallback path still executes.
- (f) `orchestrate planPath` producer: tagged-chain doc → PlanRecord persisted (title/phases/items) + chain commands still emitted.
- (g) plans.json atomicity under crash (unit-proven; live spot-check that a mid-write kill leaves either full old or full new file readable).
- (h) Planner-role producer: live seeded run whose planner task emits a tagged `<plan>…</plan>` output → PlanRecord persisted with `authorTaskId` provenance rendered by `plans get` (parse contract itself unit-covered by `plan-producers.test.ts`).
