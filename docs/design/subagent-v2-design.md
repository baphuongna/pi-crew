# pi-crew Subagent v2 — Design Proposal (rev 2.1)

**Status:** REV 2.1 — post review rounds 1+2 (20 + 6 findings addressed; awaiting round-3 doc-diff verification)
**Date:** 2026-08-16 · **Base:** main `fb3cad21` (v0.10.0); review verified @ `c033e21d` (docs-only, no source drift)
**Foundation audit:** `docs/design/2026-08-16-subagent-v2-audit.md` (erratum: several paths corrected — see that file's header)
**Rev-2 change log:** §3 rewritten (park/unpark semantics — waiting protection was WRONG in rev 1; respond live-path split), §7 rewritten (nested-slot budget fixes deadlock P0-1; depthOverride fixes P0-2; durable result delivery replaces long-lived RPC), §2 principle 2 reworded (new authz surface + threat model), §5 migration section, §6 strict-mode machine-checkable evidence, §9 model validation pulled into P1 admission, §10 edge flip + mini-ADR for R2, §11 two added risks, §12 updated decision list, path anchors fixed throughout.

---

## 0. Vision

> A pi-crew where every subagent can **delegate further (governed)**, works from a **spec**, executes a **versioned plan**, can **ask questions mid-task**, and the user can **see and steer all of it from the UI** — with one unified identity model and one spawn-permission policy.

Audit one-liner: *"v2 often **completes** rather than **creates**"* (pattern P2). Six consumer surfaces already exist for `waiting` with zero producers; plan-approval exists but is invisible to every UI; depth guards exist for nesting that has no tool seam. v2 = finish the scaffolding, then add the three missing objects (Plan, Spec, delegation contract).

## 1. Headline features

| # | Feature | Audit limitation closed | Phase |
|---|---|---|---|
| H1 | **Subagent của subagent** — governed nesting | L1 + L6 | P1 |
| H2 | **Specs** — first-class spec system | L5 | P1 |
| H3 | **Plans** — first-class Plan object | L3 | P1 |
| H4 | **Plan UI** — plan/task-graph in TUI + text | L4 + L10 | P2 |
| H5 | Ask mid-task (`waiting` producer) | L2 | **P0** |
| H6 | Unified agent identity + real subagent steer | L6 | **P0** |

## 2. Design principles (from audit cross-cutting patterns)

1. **One gate, one place** (closes P1): all spawn permission moves to a single `spawn-policy.ts`; depth/role/budget/trust/concurrency/model-validity checked once, enforced at the spawn entry point — no scattered checks.
2. **The broker is the transport, and `delegate`/`ask` are NEW authorized broker methods — not "no new IPC surface"** *(rev 2: reworded — reviewer P1-8; rev 2.1: NEW-4 token hardening)*. Today's method set is fixed (9 methods, `crew-broker.ts:539-568`) and no worker-callable method mutates task state; v2 adds two that do. **Threat model:** a worker connection is authenticated by its task-scoped token (role derived from token type at hello, `crew-broker.ts:599-603` — keep); **the new methods additionally REQUIRE task-scoped (compound-key) token matches — the legacy bare-`runId` token fallback in `tokenRole()`/`get()` (`crew-broker-tokens.ts`) must NOT authenticate them** (a legacy-token worker could otherwise claim any taskId); new methods MUST enforce `to === conn.taskId` at the handler (never trust a worker-supplied `to` — the existing `escalate` method's unvalidated `to` (`crew-broker.ts:1178`) is the recorded anti-pattern, do not replicate); admission is decided root-side by spawn-policy, the handler only *executes* admitted requests; unauthenticated/unauthorized → reject with policy message, logged to `events.jsonl`.
3. **Typed state, not text artifacts** (closes P3): Plan/Spec are versioned JSON records in run state, queryable by UI and validators.
4. **Untrusted fence everywhere**: worker-produced text consumed by another worker stays inside the `<dependency-context>` fence pattern — including grandchild results.
5. **Complete scaffolding first** (closes P2): P0 ships producers/consumers for what contracts already promise. *(Rev 2: R2 (ask/waiting) introduces a new cross-process park contract → gets a mini-ADR even though it "completes" scaffolding — reviewer P2-18. R1/R3 stay ADR-less.)*
6. **ADR-first for new objects**: Plan, Spec, governed nesting each get an ADR before code (none exist today — audit S6).
7. **Durable over RPC** *(new, rev 2 — reviewer P1-6)*: long-lived broker RPC does not survive socket close (`crew-broker-client.ts:580-585` rejects all pending requests on close, sticky fallback). Any worker-waiting-on-future-result interaction returns a handle immediately and delivers the result over a durable channel (mailbox / task record / steering file), never by holding a request open.

## 3. H5 — Ask mid-task (`waiting` producer) · P0 · mini-ADR required

**Problem:** `status:"waiting"` has 6 consumer surfaces and **zero producers** (grep-verified 3×). Workers cannot ask questions; final text is the only output channel.

**Worker-side tool** (in `prompt-runtime.ts`, pattern: scratchpad's dormant-until-env `pi.registerTool` — `scratchpad-lifecycle.ts:642-647`, reviewer-verified feasible):

```
ask({ question: string, options?: string[], timeoutSec?: number = 600 })
```

**Park/unpark semantics** *(rev 2.1 — rewritten again; round-2 NEW-1/NEW-3: rev-2's `manifest.status → blocked` flip created a state combination that never occurs today (all blocked writes co-occur with run-loop exit — `dispatch-batch.ts:318,324`, `team-runner.ts:767,796,1041`; registry sweep unregisters blocked runs — `active-run-registry.ts:277`), and rev-2's steer-seam delivery contradicted the seam it cited (steer delivers at turn boundaries, `child-pi/child-pi-steering.ts:20-27` — a model blocked inside a tool call cannot receive it))*:

1. **Park = `waitState` alone — no manifest-status flip** *(NEW-3 fix)*: `task.waiting = { questionId, askedAt, deadline, options? }` (NEW schema field — NEW-5, listed in the mini-ADR) + `manifest.waitState = { taskId, questionId, askedAt }` (also new); `manifest.status` stays `running`. Reconciler change: `isIntentionalWait` = plan-approval-pending **OR** `waitState` present with `askedAt` within `waitingTtl` (default 24h). Waiting tasks older than TTL are still cancelled (leak guard). This keeps the run registered, live-sidebar visible, and `live-executor.isCurrent()` true throughout the wait.
2. **The ask tool polls its own mailbox and returns the answer as its tool result** *(rev 2.1 NEW-1 fix — option (b); removes the steer-seam contradiction and the mutual-wait entirely)*. The worker's turn stays inside the `ask` tool call, bounded by `timeoutSec`; the tool polls the on-disk mailbox (the run's mailbox directory — `<stateRoot>/mailbox`, per-task message streams inside, `state/coordination/mailbox.ts:105`) for an entry `kind:"response", questionId` at a short interval (reuse the 500ms cadence); the answer is returned **as the tool result**, the turn continues — no steer delivery, no turn-boundary dependency, no RPC held open (principle 7 satisfied: mailbox is durable on-disk state). Timeout expiry → tool returns `"[ask timed out — continue with best judgment]"` as its result. Both outcomes appended to `events.jsonl`.
   - **Liveness discriminator (who decides live vs durable):** `respond` inspects the target task's worker liveness — parent-side heartbeat record (alive if last beat within gradient `stale` window, i.e. <60s) and, for live-session agents, the in-memory handle. **Worker alive** → `respond` writes the mailbox response under `withRunLockSync` + fresh-reload (the exact write discipline `respond.ts:42-43` already uses — NEW-6 pin), leaves the task `waiting`; the parked tool picks it up and flips `waiting→running` via its own terminal report. **Worker dead / crashed** → `respond` re-queues the task AND injects the answer into the next dispatch's prompt (mailbox history). **Negative AC: never both — no double-dispatch.**
   - Broker method additions: `wait.request` / `wait.resolve` with `to === conn.taskId` (principle 2) **required to authenticate via task-scoped (compound-key) tokens — the legacy bare-`runId` token fallback (`crew-broker-tokens.ts`) must NOT authenticate the new methods** *(NEW-4 fix)*: the token registry gains an API distinguishing compound-key vs fallback matches, and fallback matches are rejected for `wait.*`/`delegate` with a migrate-hint. `"waiting"` added to `waitStatus.validStatuses`.
3. **Timeout owner = scheduler loop, persisted** *(rev 2 — reviewer P2-19)*: nothing schedules timers today (plan-approval blocks indefinitely). The scheduler's tick checks `task.waiting.deadline` (persisted in the task record, survives crash-recovery); expiry → if the worker is alive it is surfaced as the tool's timeout result; if dead, the task is re-queued with the `"[ask timed out]"` note injected on next dispatch. Both outcomes appended to `events.jsonl`.
4. Read-only roles may ask (ask is always available, unlike delegate). Scaffold mode (`executeWorkers=false`): `ask` returns a structured notice telling the worker no parent is listening (no hang) — **negative AC**.

**Acceptance:** E2E — worker asks → `waitState` present, manifest stays `running`, run stays registered/visible → `respond` answers → the SAME worker process's ask tool returns the answer as its tool result, task flips `waiting→running`; kill -9 parent mid-question → crash-recovery keeps the task waiting → next session_start stale-reconciler does NOT cancel (within TTL) → respond detects dead worker → re-queue + injected answer, exactly one dispatch; timeout path returns the notice in-tool; scaffold mode no-hang. **Mini-ADR** `2026-XX-waiting-producer.md` records: the park contract (waitState, no status flip), reconciler TTL extension, **the new schema fields as schema additions (NEW-5: `task.waiting`, `manifest.waitState`)**, the respond write discipline (`withRunLockSync` + fresh-reload — NEW-6), and the task-scoped-token requirement for `wait.*`.

## 4. H6 — Unified agent identity · P0

**Problem:** two agent worlds; `steer_subagent`/`crew_agent_steer` are registered stubs (ADR 2026-08-14).

**Rev-2 corrections** *(reviewer P2-17)*: `CrewAgentRecord` **already has required `taskId` + `runId`** (`crew-agent-runtime.ts:30-41`); the record missing linkage is `SubagentRecord` (`subagent-manager.ts:28+`), which already has `runId?` (`:31`) but lacks `taskId`/`depth`. And the one-shot Agent tool already routes through `handleTeamTool(action:"run")` team-run machinery (`registration/subagent-tools.ts:143-163`) — so its tasks already have the steering-file delivery path; real `steer_subagent` is closer than rev 1 implied.

**Design:**
- `SubagentRecord` gains `taskId?: string`, `depth: number`; `runId?` already exists. Set at spawn by the owning path. **Back-compat:** old records without the new fields render as today (unknown task/depth), steer returns the existing "not linked" message until records migrate naturally.
- One ownership map in run state: `task ⇄ subagent ⇄ pid ⇄ artifacts dir`; both worlds write it; widget/status/steer read only it.
- `steer_subagent`/`crew_agent_steer` become real: resolve record → append `artifacts/steering/<taskId>.jsonl` — identical machinery to `team steer`, scoped to owned records.

**Acceptance:** steering a live one-shot subagent delivers at its next turn boundary; `team status` attributes subagent token usage to its task; ADR 2026-08-14 closed.

## 5. H3 — First-class Plan object · P1 · ADR required

**Problem:** three ephemeral plan representations; no versioning, linkage, progress, re-plan, or UI query; `plan-execute` workflow exists only in docs.

**Schema** (`state/runs/<id>/plans/plans.json` — revision list, atomic write, run-locked):

```ts
PlanRecord {
  id; runId; version; revisionOf?;
  title;
  phases: [{ id, title, itemIds[], status }];   // pending|active|done|dropped
  items:  [{ id, ref, title, taskIds[], specIds[], acceptance[], status, progress? }];
  approval?: { status: pending|approved|rejected, by?, at, planVersion };
  createdAt; authorTaskId;
}
```

**Migration** *(rev 2 — reviewer P1-3; 5 verified readers of `manifest.planApproval`: `state/types.ts:230`, `team-runner.ts:808,1055`, `stale-reconciler.ts:46`, `plan-approval.ts:26,34,43`, `api/plan-approval.ts` ×6)*: dual-read compat — `planApproval` on the manifest remains authoritative when no PlanRecord exists; new runs write both (manifest pointer + plan record) for one minor version; readers migrate to plan-record-first, manifest-fallback; then manifest field is deprecated (not removed) next minor. The stale-reconciler invariant (`blocked + planApproval.pending` → protected) keeps working throughout because the manifest field is never dropped. **Negative AC: a run created pre-v2 with planApproval pending is still protected by stale-reconciler after upgrade.**

**Producers:** (1) `orchestrate planPath` parser → PlanRecord (tagged-chain format stays the *authoring* format); (2) adaptive `assess` → phases/items instead of flattening into ≤12 injected tasks (`goal-workflow/adaptive-plan.ts:43` cap moves to per-phase); (3) planner-role task output → same tagged contract.

**Semantics:** scheduler reads current revision only; `items[].taskIds` maintained by the scheduler on dispatch/terminal (single writer, inside run lock). Re-plan = new revision + `revisionOf`; in-flight tasks referenced by dropped items get soft-cancel (wrap-up steer grace, `child-pi/child-pi-steering.ts:25-75`). New `team action='plan'`: `get [--rev]`, `list`, `diff <a> <b>`, `approve|reject`.

**Acceptance:** revision diff queryable; per-item progress derived from linked task statuses; approval gate references plan id+version; adaptive runs keep working via items; old-manifest protection AC above; ADR first.

## 6. H2 — Minimal spec system · P1 · ADR required

**Problem:** "spec" is skill vocabulary only; TaskPacket static; acceptance evidence free text.

**Schema:**

```ts
SpecRecord  { id, version, revisionOf?, title,
              requirements: [{ id, text, priority: must|should|could }],
              acceptance:  [{ id, requirementId, check }],
              source: { kind: manual|generated, by?, from? } }   // workspace-level: state/specs/<id>.json
SpecSnapshot{ specId, version, frozenAt, items[] }                // immutable, frozen into the task at dispatch
```

**Wiring:** TaskPacket gains `specRefs[]`; executor contract: result ends with `SPEC-EVIDENCE:` footer citing `{acceptanceId → evidence}`. Write-gate validator (extends the `empty-or-stderr-only-result` classifier machinery, `task-runner/post-execution.ts:289+`) parses the footer.

**Fabrication defense** *(rev 2 — reviewer P1-9; rev-1 "verifier independently checks" was not airtight)*:
- Write-gate = **mechanical coverage only** (every must-acceptance id cited ≥1) — never claims to verify truth.
- **Strict mode** (per workflow): every must-acceptance must carry **machine-checkable evidence** — `command` + `expectedDigest` (or exit code) recorded in the SpecRecord's acceptance check; the validator may re-run the command at write-gate time and compares digest. Footer lines citing non-existent ids or unrunnable commands fail the gate.
  - **Re-run sandbox** *(rev 2.1 — NEW-2 fix; "sandboxed" was a named-but-nonexistent mechanism, and `SpecRecord.source.kind: generated` makes root-side re-execution a privilege-escalation vector)*: acceptance-command re-runs execute in a **hardened subprocess** spawned root-side with: env stripped to a minimal allowlist (NO provider keys, NO broker tokens — reuse the `BASE_ALLOWLIST` minus credentials pattern from `child-pi-spawn.ts:35-58`); `cwd` pinned to the run's workspace root; resource limits via a `sh -c 'ulimit -v …; ulimit -t …; exec …'` wrapper (memory + CPU seconds, config-capped); wall-clock timeout with SIGKILL escalation (the existing SIGTERM→SIGKILL pattern); network disabled where the platform supports it (`unshare -n` on Linux; documented best-effort on macOS); output captured to a run-scoped digest file. Non-idempotent commands are the spec author's responsibility — `SpecRecord` carries an `idempotent: boolean` per acceptance, default false; non-idempotent musts cannot enable strict re-run (gate falls back to coverage-only + `unverified` badge). The concrete parameter values (limits, timeout) are pinned in the spec ADR.
- A strict-mode workflow without a verifier-role task **fails at start** (reject-start) — no silent self-certification.
- Verifier role (read-only) receives the SpecSnapshot + evidence footer and checks cited evidence against the frozen snapshot ids; its judgment is advisory signal, not the security boundary — the boundary is the machine-check.
- **Negative ACs:** fabricated footer with plausible-but-wrong file:line evidence → machine-check fails (digest mismatch); footer citing every id with fabricated evidence in non-strict mode passes write-gate but is flagged `unverified` in task status (visible in UI).
- `should/could` never block. Non-strict default for first release (warn-only), strict opt-in per workflow — **open decision §12.4**.

## 7. H1 — Governed nesting · P1 · ADR required

**Problem:** workers load only `prompt-runtime.ts` (`model/pi-args.ts:306-331`) → no delegation seam; gates scattered across 4 layers; one untested extension hole.

**Worker-side tool** (role-gated to executor-class; prompt-runtime registration):

```
delegate({ description, prompt, role?: "explorer"|"analyst"|"executor",
           model?, maxTurns?, budgetTokens?, timeoutSec? = 900 })
  → returns IMMEDIATELY { grandchildTaskRef }           // never blocks on RPC — principle 7
```

**Delivery** *(rev 2 — reviewer P1-6; replaces rev-1 synchronous RPC which dies on broker socket close)*: the worker's result comes back over the durable channel — grandchild's terminal state + fenced result text land in the parent task's mailbox + task record; **the `delegate` tool itself polls the parent task's mailbox stream (same option-(b) self-poll pattern as `ask`, §3 — consistent with principle 7) and returns the grandchild's fenced result as its tool result**. Parent task stays `running` (not parked) while waiting; `timeoutSec` expiry → the tool returns a `"[delegate timed out]"` result and the worker continues (grandchild soft-cancelled by the spawn-policy owner).

**Spawn path & anti-deadlock** *(rev 2 — reviewer P0-1; rev-1 "existing `runChildPi` rides the global semaphore" would deadlock — the repo itself records this exact shape at `scheduling/global-worker-cap.ts:14-19` MAJ#3: judge bypasses the cap because workers-holding-slots-waiting-on-spawn = permanent deadlock)*:
- Grandchildren are spawned **by the root-side delegate handler** from a **separate nested-slot budget** (default `max(1, floor(globalSem/2))`, cap-configurable), NOT from the global worker semaphore — a waiting parent worker keeps holding its own slot without risk of self-starvation.
- **Fail-fast, never queue:** nested budget exhausted → `delegate` rejects immediately with a policy message ("nested spawn budget exhausted; N/M in flight") — no silent queueing, no waiting. **Negative AC.**
- `delegate({timeoutSec})` mandatory default 900s (rev-1 H1 lacked it).

**Depth representation** *(rev 2 — reviewer P0-2; today `PI_CREW_DEPTH` comes from the spawning process's env (`model/pi-args.ts:369-371`, `currentCrewDepth` `:71-75`), so a root-spawned grandchild would wrongly get DEPTH=1 and `checkCrewDepth` (`child-pi/child-pi.ts:253-257`) never sees depth>0)*:
- **`depthOverride`**: spawn-policy computes the grandchild's depth from the **parent task's record in run state** (`task.depth` — NEW schema field, listed in the nesting ADR additions; `TeamTaskState` has no such field today), never from the requesting worker's env or self-report; sets `PI_CREW_DEPTH` explicitly on the grandchild spawn; clamps against `PI_CREW_MAX_DEPTH` (default 2, config-raisable). The existing env-derived guard remains for worker-initiated spawns (bash-escape backstop); the authoritative check is spawn-policy's.

**Broker credential containment** *(rev 2 — reviewer P1-7; today `runChildPi` auto-issues creds when `runId` present (`child-pi/child-pi.ts:277-285`) and `issueForChild` checks runId/root/enabled/sessionId but NOT child depth (`registration/lifecycle-handlers.ts:1024-1036`) → grandchildren would get creds by default)*: depth gate added to `issueForChild` (or the delegate call-site): tokens minted **only for depth ≤ 1**; depth-2 grandchildren get `PI_CREW_KIND=subagent`, steering file, and mailbox, but no broker socket/token (they cannot `delegate` further anyway at default maxDepth=2 — consistent). **AC: depth-2 env contains no `PI_CREW_BROKER_*`.**

**Budget attribution** *(rev 2 — reviewer P1-11; rev-1 "deducted from parent task's remaining budget" cited a mechanism that doesn't exist — `budget-enforcement.ts:47-83` is a threshold detector, not per-task allocation)*:
- **Per-task allocation accounting** *(rev 2 — reviewer P1-11; NEW schema field `allocation { tokensGranted, tokensSpent }` — NEW-5, listed in the nesting ADR)*: the delegate handler reserves `budgetTokens` from the parent task's remaining allocation at admission (reject if insufficient — fail-fast) and **rolls up** the grandchild's usage events to the parent task record as they arrive (single writer, run lock). Global budget enforcement continues to read totals; fair-share violator detection now sees grandchild usage through the parent.
- **ADR pins for the nesting ADR** *(rev 2.1 — NEW-6)*: (i) grandchild spawn mechanism = direct `runChildPi` call-site with `cap:false`-style global-semaphore bypass + the separate nested-slot budget (the MAJ#3 judge precedent generalized); (ii) issuer depth-gate call-site (depth ≤ 1 mints); (iii) task-scoped-token requirement for the `delegate` method; (iv) new schema fields (`task.depth`, `allocation`) listed as schema additions.
- **AC: grandchild usage appears in the parent task's usage in `team status`.**

**Grandchild lifecycle** *(rev 2 — reviewer P1-12; heartbeat/deadletter are child-executor-owned today and would not cover root-spawned grandchildren)*: the delegate handler registers a heartbeat observer + deadletter path for each grandchild (same gradient 30/60/300s; dead reasons extended with `delegate-timeout`); zombie scanner backstop unchanged (`PI_CREW_KIND`/`PARENT_PID`).

**Model validation at admission** *(rev 2 — reviewer P1-14; pulled from P2 R8 into the gate)*: `delegate({model})` values are validated against the resolved model catalog at spawn-policy admission — the unvalidated `provider/model` pass-through (`model-fallback.ts:282`, the 429-cascade root) must not be reachable through the new surface.

**Extension containment** *(rev 2 — reviewer P1-10; rev-1 deny-list is basename-equality (`model/pi-args.ts:303-305`) and won't match `/…/pi-crew/index.ts` or `npm:pi-crew`)*: at depth > 0 the extension list becomes an **allowlist** — only `PROMPT_RUNTIME_EXTENSION_PATH`, regardless of source (SEC-1's project-only strip is insufficient here; the allowlist applies to user-sourced agent declarations too, closing the audit's untested hole). Bash-escape stays depth-unaccounted — documented accepted risk, zombie scanner backstop.

**Workspace interaction** *(rev 2 — reviewer P1-15; default `workspaceMode:"single"` means concurrent executors share cwd)*: executor-class `delegate` on a run with shared workspace auto-enables `serializeOnPathOverlap` for the parent+grandchild pair, or the spawn-policy rejects delegate when parent task's `cwd` overlaps another in-flight executor's — design decision recorded in the nesting ADR (default: serialize; worktree mode opt-in as today).

**Why slim SDK, not full extension in children:** broker root-gate, run-lock contention, state-root conflicts, and the 54-action team tool inside a worker are blast-radius multipliers; a 1-action `delegate` gives most of the value at a fraction of the surface. ADR records the alternative and revisit conditions.

**Acceptance:** depth-1 worker delegates → depth-2 grandchild with namespaced artifacts (`artifacts/<runId>/<parentTaskId>/nested/<subId>/`), budget reserved+rolled-up, no broker creds at depth 2, heartbeat+deadletter registered, model validated; depth-3 blocked by default with policy message; nested-budget exhaustion → immediate rejection (never queue); read-only roles' `delegate` rejected; socket-close mid-grandchild → parent still receives result via durable channel; concurrent delegates on 4-core box complete without deadlock; ADR first.

## 8. H4 — Plan UI · P2

*(Unchanged from rev 1 except anchors + dependency on H6's ownership map for depth badges.)*

- **Data:** new `RunUiSnapshot` slice `plans` + `sliceSignatures.plans` (inside existing cache + render-coalescer design — `ui/run-snapshot-cache.ts:28` TTL 1500ms, `:650+` signatures exist).
- **Dashboard pane 7 "Plan":** tree `phase → item → tasks (live status, depth badge)`; keys `A`pprove / `D`eny when `approval.status === pending` (≤2 keystrokes, no event-log reading); `V` diff on multi-revision.
- **Powerbar:** steps segment consumes plan phases when a plan exists (fallback: workflow steps).
- **Widget:** pending-approval badge `⚠ plan:RUNID`; parked-on-approval progress shown.
- **Text UI:** `team plan get` renders ASCII tree + per-item progress (SSH/no-TUI).
- **Negative AC:** >3 agents render when plan tasks exceed the widget cap → widget degrades to summary line, dashboard shows full tree (cap is widget-only, not data-loss).

**Acceptance:** approval pending visible in widget+dashboard and approvable ≤2 keystrokes; pane reflects item→task status live; no new cache layer.

## 9. Supporting upgrades (P2, condensed)

- **Model-routing transparency:** pre-run summary of resolved chain + worst-case spawn budget; loud warning on unvalidated `provider/model` pass-through (`model-fallback.ts:282`) for all non-delegate surfaces; per-attempt model in transcripts. *(Validation at the delegate gate is P1 §7; this P2 item covers the rest of the surfaces.)*
- **Worker self-reporting:** bounded worker→`PI_CREW_EVENTS_PATH` append channel; heartbeats become corroboration (closes L8).
- **Docs hygiene:** commands-reference phantom list; widget TTL doc (500→1500ms); phantom `plan-execute` workflow refs.

## 10. Roadmap

```
P0 (scaffolding completion; R2 mini-ADR)       ── ~1 week
  R1 unified identity + real steer_subagent    (H6)   [ADR-less; back-compat records]
  R2 waiting producer + ask + park contract    (H5)   [mini-ADR: park semantics, reconciler TTL]
  R3 approval surfaces in existing UI          (H4-subset) [ADR-less]

P1 (new objects; ADRs land BEFORE code)        ── ~2-3 weeks
  R4 Plan object + team plan + migration       (H3)   [ADR]
  R5 governed nesting + spawn-policy.ts        (H1)   [ADR — depends on R4]
  R6 spec system + write-gate validator        (H2)   [ADR — shares revision machinery with R4]

P2 (UI + transparency)                         ── ~1-2 weeks
  R7 plan/task-graph UI slice + pane 7         (H4)   [depends on R4; uses R1 ownership map]
  R8 model-routing transparency (surfaces beyond §7 gate)
  R9 worker self-reporting channel
  R10 docs hygiene
```

Dependency edges (convention: `A→B` = A before B): `R1→R2`, `R1→R5`, `R4→R5` *(rev 2: flipped from rev-1's erroneous `R5→R4` — reviewer P1-13; plan items must exist before grandchild tasks can link to them)*, `R4→R7`, `R6~R4` (shared machinery, either order). DAG — no cycles.

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Nested spawn recursion / fork bombs | spawn-policy single gate; separate nested-slot budget with fail-fast; depth default 2 via trustworthy depthOverride; model+budget validated at admission; zombie scanner backstop |
| Broker token leakage at depth ≥2 | tokens minted only depth ≤1 (issuer depth gate); heap-only transport unchanged |
| **Worker token readable via `/proc/<pid>/environ`, inherited by anything the worker spawns** *(rev 2 — reviewer P2-20; pre-existing, amplified by v2's wider worker permissions: ask/wait + delegate)* | accepted risk, recorded; mitigations: short-TTL worker tokens (rotate per task), method-level authz (`to === conn.taskId`) limits blast radius; revisit in nesting ADR |
| Park/deadlock interactions (ask + delegate waits) | worker stays alive parked; scheduler owns deadlines (persisted); delegate never queues (fail-fast); nested budget separate from global sem |
| Plan/spec schema churn | ADR-first; shared revision machinery; snapshots frozen at dispatch |
| Write-gate strictness breaking valid runs | strict opt-in per workflow; must-only; non-strict = warn + `unverified` badge; reject-start only when strict mode misconfigured (no verifier task) |
| UI slice coherence cost | one new slice only; reuses coalescer; no new cache layer |
| Bundle staleness in live sessions | rebuild + restart discipline (knowledge.md lesson) |
| **Shared-workspace path conflicts under nesting** *(rev 2 — reviewer P1-15)* | serialize parent+grandchild on path overlap by default; worktree opt-in; decided in nesting ADR |

## 12. Decision checklist (updated after review round 1)

1. ~~Approve P0 now?~~ → **Reviewer verdict: R1/R3 approvable now; R2 only after its mini-ADR lands (park semantics §3 rewritten).** Recommend: approve R1+R3 immediately, write R2 mini-ADR this week. *(Your call still required.)*
2. ADR order for P1: **Plan → Nesting → Spec** (dependency-correct, matches §10) — confirm?
3. `maxDepth` default: keep **2** (recommended; enforcement now real via depthOverride) or raise to 3?
4. Spec write-gate first release: **non-strict warn-only default, strict opt-in per workflow** (recommended) — confirm?
5. H4 pane 7: feature flag `PI_CREW_PLAN_UI=1` first release (recommended after review — new UI slice on a hot path) or default-on?

## 13. Review history

- **Round 1** (2026-08-17, run `team_20260817020423_3ea83cd4d0ec08e3`, team `review`): 4 tasks (explorer/reviewer/security-reviewer/verifier); 20 findings merged from two independent adversarial passes (explorer + reviewer; security artifact truncated but dimensions covered by both). Verdict: **APPROVE-WITH-CHANGES** — conditional on P0-1/P0-2 (§7 rewritten), P1-4/P1-5 (§3 rewritten), and doc-level P1s (all applied in rev 2). This document is the disposition of all 20.
- **Round 2** (2026-08-17, run `team_20260817025826_bb2b2510dbbc33b2`, team `review`): convergence check; disposition of all 20 round-1 findings — **18 CLOSED, 2 PARTIAL (P1-5, P1-9), 0 OPEN** (explorer and reviewer agreed 20/20); plus 6 new findings (NEW-1 P1 ask-delivery seam contradiction, NEW-2 P1 nonexistent sandbox, NEW-3 P1/P2 blocked-state flip never occurs today, NEW-4 P2 legacy token fallback, NEW-5 P3 field anchors read as existing, NEW-6 P3 ADR pins). Verdict: **NEEDS-ROUND-3 (doc-diff-only)** — R1+R3 approvable now. **Rev 2.1 applies all six:** NEW-1 → §3 ask tool polls mailbox, answer returned as tool result (option b), liveness discriminator + no-double-dispatch AC; NEW-2 → §6 hardened-subprocess re-run sandbox spec (env-stripped, cwd-pinned, ulimit-wrapped, SIGKILL-escalated, network-disabled best-effort, idempotent flag); NEW-3 → §3 park on `waitState` alone, no manifest-status flip; NEW-4 → principle 2 + §3 task-scoped-token requirement, legacy fallback rejected for new methods; NEW-5 → new schema fields explicitly marked as additions in the mini-ADR/nesting ADR lists; NEW-6 → §7 ADR-pins block. Round 3 (run team_20260817034629): 4/4 CONVERGED — 5/6 CLOSED + NEW-5 closed by marking task.depth at §7; 4 P3 editorial nits fixed in rev 2.1 post-script (title rev, mailbox path anchor state/coordination/mailbox.ts:105, §7 delegate delivery synced to option-b, task.depth marked NEW). Design READY for §12 decisions.
