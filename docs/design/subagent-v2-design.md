# pi-crew Subagent v2 — Design Proposal

**Status:** DRAFT — awaiting review · **Date:** 2026-08-16 · **Base:** main `fb3cad21` (v0.10.0)
**Foundation audit:** `docs/design/2026-08-16-subagent-v2-audit.md` (run `team_20260816163952_f89275501e2c9e87`, all claims file:line-anchored, negatives grep-verified ≥2×)

---

## 0. Vision

> A pi-crew where every subagent can **delegate further (governed)**, works from a **spec**, executes a **versioned plan**, can **ask questions mid-task**, and the user can **see and steer all of it from the UI** — with one unified identity model and one spawn-permission policy.

The audit's one-line verdict on today: *"v2 often **completes** rather than **creates**"* (pattern P2). Six consumer surfaces already exist for `waiting` with zero producers; plan-approval exists but is invisible to every UI; depth guards exist for nesting that has no tool seam. v2 = finish the scaffolding, then add the three missing objects (Plan, Spec, delegation contract).

## 1. Headline features (user-requested, audit-ranked)

| # | Feature | Audit limitation closed | Phase |
|---|---|---|---|
| H1 | **Subagent của subagent** — governed nesting | L1 (no delegation seam) + L6 (two agent worlds) | P1 |
| H2 | **Specs** — first-class spec system | L5 (no spec system) | P1 |
| H3 | **Plans** — first-class Plan object | L3 (no Plan entity) | P1 |
| H4 | **Plan UI** — plan/task-graph in TUI + text | L4 + L10 (approval invisible; no plan slice) | P2 |
| H5 | Ask mid-task (`waiting` producer) | L2 (dead plumbing) | **P0** |
| H6 | Unified agent identity + real subagent steer | L6 (steer stubs) | **P0** |

## 2. Design principles (from audit cross-cutting patterns)

1. **One gate, one place** (closes P1): all spawn permission moves to a single `spawn-policy.ts`; depth/role/budget/trust/concurrency checked once, enforced at `runChildPi` entry — no scattered checks.
2. **Broker is the spine** (reuses P7): nested delegation rides the existing heap-only per-child broker channel; no new IPC surface.
3. **Typed state, not text artifacts** (closes P3): Plan/Spec are versioned JSON records in run state, queryable by UI and validators — result-text parsing becomes a producer, never the storage.
4. **Untrusted fence everywhere**: any worker-produced text consumed by another worker stays inside the `<dependency-context>` fence pattern (audit S1) — including grandchild results.
5. **Complete scaffolding first** (closes P2): P0 ships producers/consumers for what contracts already promise (waiting, steer, approval UI) before new objects land.
6. **ADR-first for new objects**: Plan, Spec, and governed nesting each get an ADR in `docs/decisions/` before code (none exist today — audit S6).

---

## 3. H5 — Ask mid-task (`waiting` producer) · P0

**Problem:** `status:"waiting"` has 6 consumer surfaces (respond, crash-recovery, events, UI, contract docs) and **zero producers** — verified 3×. Workers cannot ask questions; final text is the only output channel.

**Design:** worker-side tool `ask`, symmetric with the existing scratchpad tool in `prompt-runtime.ts`:

```
ask({ question: string, options?: string[], timeoutSec?: number = 600 })
```

- prompt-runtime emits `task_wait_requested` event + sets `task.status = "waiting"` via broker push (fast path) or result-stream marker (fallback), writes `mailbox/<taskId>.json` question item.
- Parent scheduler parks the task (like plan-approval-pending — protected in stale-reconciler `recovery/stale-reconciler.ts:44-47` pattern).
- `team action='respond'` already re-queues: unpark → steer-delivered question answer at next turn boundary (same 500ms poll as steering).
- Timeout → auto-resume with `"[ask timed out — continue with best judgment]"` note; both outcomes appended to `events.jsonl`.
- Roles: read-only roles may ask; the ask tool is always available (unlike delegation).

**Acceptance:** E2E — worker asks → run parks → `respond` answers → worker resumes with answer in-context; kill -9 parent mid-question → crash-recovery restores task as `waiting`; timeout path resumes.

## 4. H6 — Unified agent identity · P0

**Problem:** two agent worlds (child-process `CrewAgentRecord`/`agents.json` vs live-session in-memory handles); `SubagentRecord` lacks `taskId` → `steer_subagent`/`crew_agent_steer` are registered stubs (ADR 2026-08-14).

**Design:**
- `SubagentRecord` gains `taskId?: string`, `runId?: string`, `depth: number` — set at spawn by the owning path (one-shot Agent tool or team-run child executor).
- One ownership map in run state: `task ⇄ subagent ⇄ pid ⇄ artifacts dir`. Both worlds write it; widget/status/steer read only it.
- `steer_subagent`/`crew_agent_steer` become real: resolve record → append `artifacts/steering/<taskId>.jsonl` (existing delivery path) — identical machinery to `team steer`, scoped to owned records.

**Acceptance:** steering a live one-shot subagent delivers at its next turn boundary; `team status` shows subagent token usage attributed to its task; ADR 2026-08-14 closed.

## 5. H3 — First-class Plan object · P1 (ADR required)

**Problem:** three ephemeral plan representations (orchestrate `planPath` markdown parse; `planApproval` = read-only task's result text; adaptive assess JSON flattened, cap 12). No versioning, item↔task linkage, progress, re-plan, or UI query. `plan-execute` workflow exists only in docs.

**Schema** (`state/runs/<id>/plans/plans.json` — revision list, atomic write, run-locked):

```ts
PlanRecord {
  id: string; runId: string;
  version: number; revisionOf?: number;        // re-plan = new revision
  title: string;
  phases: [{ id, title, itemIds[], status }];  // status: pending|active|done|dropped
  items:  [{ id, ref, title, taskIds[], specIds[], acceptance[], status, progress? }];
  approval?: { status: pending|approved|rejected, by?, at };  // replaces manifest.planApproval pointer
  createdAt: string; authorTaskId: string;     // planner/assess task that produced it
}
```

**Producers (unify the three):**
1. `orchestrate planPath` parser → PlanRecord (keeps tagged-chain format as the *authoring* format).
2. Adaptive `assess` → creates phases/items instead of flattening into 12 injected tasks; scheduler expands items → tasks (cap moves to per-phase).
3. Planner-role task output → same tagged format contract.

**Semantics:**
- Scheduler reads **current revision only**; `plan.items[].taskIds` maintained by the task scheduler on dispatch/terminal (single writer, inside run lock).
- Re-plan: planner emits new revision + `revisionOf`; UI diffs; in-flight tasks referenced by dropped items get soft-cancel (wrap-up steer, existing `child-pi-steering.ts:25-75` grace pattern).
- `manifest.planApproval` migrates to `approval` on the plan record; approve op gains plan-aware context.
- New `team action='plan'`: `get [--rev n]`, `list`, `diff <a> <b>`, `approve|reject` — also the non-TUI plan UI.

**Acceptance:** revision diff queryable; per-item progress = derived from linked task statuses; approval gate references plan id+version; adaptive runs keep working via items; ADR `2026-XX-plan-object.md` merged first.

## 6. H2 — Minimal spec system · P1 (ADR required)

**Problem:** "spec" exists only as skill vocabulary; TaskPacket is static hand-authored text; acceptance evidence is free text nobody validates.

**Schema** — two tiers:

```ts
SpecRecord {              // workspace-level, reusable: state/specs/<id>.json
  id, version, revisionOf?, title,
  requirements: [{ id, text, priority: must|should|could }],
  acceptance:  [{ id, requirementId, check }],          // check = concrete verifiable statement
  source: { kind: manual|generated, by?, from? }
}
SpecSnapshot {            // immutable copy embedded in run at dispatch
  specId, version, frozenAt, items[]                     // byte-stable for verifiers
}
```

**Wiring:**
- TaskPacket gains `specRefs[]`; dispatch freezes SpecSnapshot into the task record.
- Executor contract: result must end with a `SPEC-EVIDENCE:` footer citing `{acceptanceId → evidence}` lines. Write-gate validator (extends `empty-or-stderr-only-result` classifier, bug-026 Sub-A machinery) parses the footer; missing must-priority coverage → task fails validation (configurable strictness per workflow).
- Verifier role receives the snapshot and independently checks cited evidence (its read-only posture is exactly right).
- `requirements-to-task-packet` skill upgraded to author SpecRecord + TaskPacket pair.

**Acceptance:** a task with a spec cannot pass write-gate without must-coverage evidence; verifier rejects fabricated evidence citing snapshot ids; specs versioned and diffable like plans (shared revision machinery with H3).

## 7. H1 — Governed nesting: subagent của subagent · P1 (ADR required)

**Problem:** workers load only `prompt-runtime.ts` (`pi-args.ts:306-331`) → zero crew tools → no delegation seam; the depth cap (default 2, clamp 10) is permissive but unreachable; gates are scattered across 4 layers (P1); one untested hole (user-sourced agent `extensions:[pi-crew]`).

**Design — slim worker-SDK delegation, broker-relayed (chosen over loading the full extension in children):**

Worker-side (new tool in prompt-runtime, role-gated to executor-class roles):
```
delegate({ description, prompt, role?: "explorer"|"analyst"|"executor",
           model?, maxTurns?, budgetTokens? })
   → broker request "delegate" → parent spawns grandchild
   → grandchild result text returns fenced (untrusted) into worker's next turn
```

Parent-side:
- Broker `delegate` handler validates against the **single spawn-policy** (`spawn-policy.ts`):
  `depth < maxDepth(2 default) ∧ role is executor-class ∧ parent task budget remaining > request ∧ global sem has slots ∧ trust tier allows`.
- Grandchild spawn = existing `runChildPi` with `DEPTH=parent+1`; artifacts namespaced `artifacts/<runId>/<parentTaskId>/nested/<subId>/`; **no broker creds** passed below depth 1 unless policy allows (heap-only tokens never written to disk — keep it that way); model chain inherits with parent-task override precedence.
- Budget: delegation cost deducted from the **parent task's** remaining budget (fair-share, `budget-enforcement.ts:47-110` pattern); grandchild `budgetTokens ≤ parent remaining`.
- Depth visible: task records carry `depth`; UI badges nested tasks (see H4).

**Security posture:** the audit's untested hole (agent-declared `extensions:[pi-crew]` inside a worker) is closed by deny-listing `pi-crew` in `--extension` args for depth > 0 regardless of trust tier; bash-escape (`pi -p` by hand) stays depth-unaccounted — documented accepted risk, zombie scanner still catches orphans via `PI_CREW_KIND`/`PARENT_PID`.

**Why not full extension in children:** broker root-gate, run-lock contention, state-root conflicts, and the 54-action team tool inside a worker are all blast-radius multipliers; a 1-action `delegate` gives 80% of the value at ~5% of the surface. Revisit after v2 ships (ADR records the alternative).

**Acceptance:** depth-1 worker spawns depth-2 grandchild (namespaced artifacts, budget deducted, no broker creds at depth 2); depth-3 blocked by default with a clear policy message; read-only roles' `delegate` rejected; `PI_CREW_MAX_DEPTH` config raise → depth-3 works; ADR `2026-XX-governed-nesting.md` merged first.

## 8. H4 — Plan UI · P2

**Problem:** `manifest.planApproval` has 0 readers in `src/ui`; task graph renders flat; powerbar steps are workflow-static; widget caps 3 agents; three cache TTLs (500/1500/100ms).

**Design (three surfaces, one data slice):**
- **Data:** new `RunUiSnapshot` slice `plans` + `sliceSignatures.plans` (stays inside existing cache + render-coalescer design — no new cache layer). Slice = current PlanRecord revision + linked task statuses.
- **Dashboard pane 7 "Plan":** tree `phase → item → tasks(live status, depth badge for nested)`; keys: `A`pprove / `D`eny when `approval.status === pending` (visible + decidable in ≤2 keystrokes — audit R3 AC); `V` diff on multi-revision.
- **Powerbar:** steps segment consumes plan phases when a plan exists (fallback: workflow steps — today's behavior).
- **Widget:** pending-approval badge `⚠ plan:RUNID`; plan progress % replaces active-run spinner when parked on approval.
- **Text UI:** `team plan get` renders ASCII tree + per-item progress bars (works over SSH/no-TUI).

**Acceptance:** approval pending visible in widget+dashboard and approvable ≤2 keystrokes without reading event log; pane reflects item→task status live (snapshot TTL budget); no new cache layer added.

## 9. Supporting upgrades (audit R8–R10, condensed)

- **Model-routing transparency:** pre-run summary of resolved chain + worst-case spawn budget; loud warning on unvalidated `provider/model` pass-through (`model-fallback.ts:282` — the 429 cascade root); per-attempt model in transcripts.
- **Worker self-reporting:** bounded worker→`PI_CREW_EVENTS_PATH` append channel for progress/liveness/questions; heartbeats become corroboration not sole signal (closes L8).
- **Docs hygiene:** commands-reference phantom list, widget TTL doc (500→1500ms), phantom `plan-execute` workflow refs.

## 10. Roadmap

```
P0 (completes scaffolding; no ADRs needed)     ── ~1 week
  R1 unified identity + real steer_subagent    (H6)
  R2 waiting producer + ask tool               (H5)
  R3 approval surfaces in existing UI          (subset of H4)

P1 (new objects; 3 ADRs land BEFORE code)      ── ~2-3 weeks
  R4 Plan object + team plan action            (H3)
  R5 governed nesting + spawn-policy.ts        (H1)
  R6 spec system + write-gate validator        (H2)

P2 (UI + transparency)                         ── ~1-2 weeks
  R7 plan/task-graph UI slice + pane 7         (H4)
  R8 model-routing transparency
  R9 worker self-reporting channel
  R10 docs hygiene
```

Dependencies: R4→R7 (UI needs the object) · R5→R4 (grandchild tasks link to plan items) · R1→R2/R5 (identity map is the substrate) · R6 shares revision machinery with R4.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Nested spawn recursion / fork bombs | spawn-policy single gate; global sem; depth default 2; budget floor; zombie scanner backstop |
| Broker token leakage at depth ≥2 | tokens stay heap-only; depth>0 children get no creds unless policy allows |
| Plan/spec schema churn | ADR-first; revision machinery shared; snapshots frozen at dispatch |
| Write-gate spec strictness breaking valid runs | strictness configurable per workflow; `should/could` never block; rollout default warn-only |
| UI slice adds coherence cost | one new slice only; reuses coalescer; no new cache layer |
| Bundle staleness in live sessions | rebuild + restart discipline (knowledge.md 2026-07-13 lesson) |

## 12. Decision checklist (what needs your call)

1. Approve P0 now (no ADRs, pure completion of promised scaffolding)?
2. ADR order for P1: Plan → Nesting → Spec (recommended), or Spec first?
3. Nesting default `maxDepth`: keep 2 (recommended) or raise to 3?
4. Spec write-gate: strict from day 1 or warn-only first release?
5. Ship H4 pane 7 behind a feature flag (`PI_CREW_PLAN_UI=1`) or default-on?
