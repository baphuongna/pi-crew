# State durability policy (event-log write path)

> **W-E Phase 2 (G7) decision record.** Status: DECIDED (2026-10-02).
> Sources: explorer grounding (run `team_20261002074144_0f848ed65d51d84c`, adaptive-02) +
> independent re-verification of every line number, count, and in-code contract comment
> during authoring. This document is the source of truth for which event-log call-sites
> must stay synchronous and which may use async/buffered APIs.
>
> **Headline verdict:** all 39 real sync `appendEvent()` call-sites outside `event-log.ts`
> carry either **mandatory** durability semantics (crash-recovery + terminal paths — 13
> sites) or a **documented same-tick read-back contract** (26 sites, each with an in-code
> "REVIEW FIX (2026-09-10): reverted M2a/M2b buffered conversion" or "Read-your-writes"
> comment). The hot paths already route through async APIs. The B1 sweep therefore has
> **zero eligible conversion targets left** — see §6.

## 1. Write APIs (primitives — do not invent new ones)

| API | Where | Semantics | Use when |
|---|---|---|---|
| `appendEvent(eventsPath, event)` | `event-log.ts:241` | Sync append under `withEventLogLockSync` (deprecated lock family — `sleepSync` ≤5s, blocks the event loop; see `:95-140`). Stamps `time`, persists `seq`. | Caller (or a later same-tick reader) requires the event on disk before the next statement. **Class (a).** |
| `appendEventAsync(eventsPath, event)` | `event-log.ts:431` | Async append under `withEventLogLockAsync` (`.alock`), no `sleepSync`, no buffering — writes immediately per event. v0.9.26 semantics. | Caller is already in an async context and nobody reads the log synchronously right after. **Class (b).** |
| `appendEventBuffered(eventsPath, event, bufferMs=20)` | `event-log.ts:1058` | Queues and flushes under one lock acquire after 20ms (unref timer). **Terminal event types bypass the buffer**: pending queue is flushed first, then a sync `appendEvent` runs (`:1060-1073`). | Caller is in a **sync** context (closure/callback) but no same-tick read-back exists. **Class (b), sync-context form.** |
| `appendEventFireAndForget(eventsPath, event)` | `event-log.ts:1206` | `appendEventAsync` without awaiting; errors go to `logInternalError`. | High-frequency events whose return value is ignored (`task.progress`). **Class (b).** |

Non-`appendEvent` durable writers covered by this policy (documented for completeness):

- `runtime/deadletter.ts:41-57` — `appendDeadletter` uses raw `fs.appendFileSync` on its own
  `deadletter.jsonl`. Sync by design; must never throw into the retry path.
- `prompt/worker-events-channel.ts:60-93` — **not** an `appendEvent` call-site. Local
  injectable `appendEvent` seam whose default is a raw single-`O_APPEND`-line
  `appendFileSync` writer with a partial-line quarantine guard and caller-stamped `time`
  (crash-safety contract documented in-file). This is the worker-side hot path; it
  deliberately bypasses the event-log lock machinery.
- `runtime/stale-reconciler.ts` — persists via `saveRunManifest` +
  `atomicWriteJson`/`atomicWriteFile` sentinels; emits **no** events itself.

## 2. Durability classes

- **(a) keep-sync** — the event (or the fact that it is on disk before the function
  returns) is load-bearing:
  - **(a-mandatory)** crash-recovery markers, terminal paths, and state that recovery /
    reconcilers / zombie detectors read back.
  - **(a-retained)** documented same-tick read-back contract (tests, dedupe sets,
    read-your-writes API returns) or approval-gate semantics with zero conversion payoff.
- **(b) async-eligible** — pure progress/observability with no synchronous reader:
  - async enclosing function → `await appendEventAsync(...)`;
  - sync enclosing function/closure → `appendEventBuffered(...)`;
  - return value ignored + high frequency → `appendEventFireAndForget(...)`.

**Decision rule for new call-sites:** default to (b). Escalate to (a) only if one of:
the event type is in `TERMINAL_EVENT_TYPES`; the site is on a recovery/respawn/resume/
orphan/deadletter path; a reader (test, dedupe, status display, API result consumer)
reads `events.jsonl` synchronously after the call; or the event is the first-ever event
for a fresh manifest (buffered append leaves the file nonexistent — ENOENT hazard,
see `foreground-control.ts:190-192`).

`TERMINAL_EVENT_TYPES` (`config/defaults.ts:82-92`): `run.{blocked,completed,failed,cancelled}`,
`task.{completed,failed,skipped,cancelled,needs_attention}`. ⚠ `dwf.*`, `goal.*`, `async.*`
terminal-ish types are **not** in this set — if such a type is ever routed through
`appendEventBuffered`, it will NOT get the terminal bypass. This is why every `dwf.*`
lifecycle site is kept sync (§3, table rows 20-29).

## 3. Full inventory — all sync `appendEvent()` call-sites outside `event-log.ts`

Counts re-verified 2026-10-02 (working tree at `6f260d24`):

- `grep -E '\bappendEvent\('` in `src/` (excluding `src/state/event-log/`, tests): **41 matches**.
- Minus **2 local-shadow calls** (call a local/injected `appendEvent`, not the event-log
  export — see §4): → **39 real sync call-sites**, classified below.
- Distribution of the rest of the family (already async): `appendEventAsync` 72,
  `appendEventBuffered` 42, `appendEventFireAndForget` 26.

### 3.1 Class (a) — MANDATORY keep-sync (13 sites)

The plan-required list: 7 crash-recovery sites + terminal paths + their state-store
and detection feeders.

| # | Call-site | Event type | Enclosing function | Why sync is mandatory |
|---|---|---|---|---|
| 1 | `runtime/recovery/crash-recovery.ts:167` | `crew.run.recovery_skipped` | `applyRecoveryPlan` (async) | Recovery decision must be durable before resume proceeds; recovery UI/tests read it back. |
| 2 | `runtime/recovery/crash-recovery.ts:177` | `crew.run.recovery_blocked` | `applyRecoveryPlan` | Same — blocked-run record drives later recovery attempts. |
| 3 | `runtime/recovery/crash-recovery.ts:206` | `crew.run.resumed` | `applyRecoveryPlan` | Run-resume marker; read by respawn/resume flow and status display. |
| 4 | `runtime/recovery/crash-recovery.ts:229` | `crew.run.recovery_declined` | `declineRecoveryPlan` (**sync fn**) | Recovery decision record from a sync API; no async context available. |
| 5 | `runtime/recovery/crash-recovery.ts:338` | `crew.run.orphan_skip` | `cancelOrphanedRuns` | Orphan-cleanup audit record; reconcile outcomes are read back by the reconciler. |
| 6 | `runtime/recovery/crash-recovery.ts:377` | `crew.run.orphan_cancelled` | `cancelOrphanedRuns` | Orphan cancel is a terminal-ish outcome; must survive an immediate crash after cleanup. |
| 7 | `runtime/recovery/crash-recovery.ts:771` | `crew.run.reconciled_stale` | `reconcileAllStaleRuns` (async) | Stale-reconcile outcome; stale-recovery reads the log to decide further action. |
| 8 | `state/stores/state-store.ts:932` | `run.${status}` (completed/failed/cancelled/blocked) | `setRunStatus` terminal path | **THE terminal path.** `run.*` terminals ∈ `TERMINAL_EVENT_TYPES`; buffer already bypasses to sync for these — writing sync directly is the contract. |
| 9 | `state/stores/state-store.ts:913` | `run.terminal_preserved` | `setRunStatus` preserve-refusal | Terminal-adjacent: records refusal to overwrite a terminal status; read by resume logic. |
| 10 | `state/stores/state-store.ts:494` | `run.created` | run-creation (`createRunManifest`) | First event, paired with the manifest write; crash-recovery scans depend on run.created being present when the manifest exists. |
| 11 | `extension/team-tool/status.ts:100` | `async.stale` | `transitionStaleAsyncUnderLock` (sync, under run lock) | Feeds stale-recovery. In-code contract (`:95-99`): "callers reading eventsPath immediately after status see the event — async fire-and-forget would race"; M2b buffered conversion reverted 2026-09-10. |
| 12 | `extension/async-notifier.ts:133` | `async.died` | `markDeadAsyncRunIfNeeded` (async) | Zombie-detection input: the function itself just did a synchronous `readEventsCursor` scan (`:118-120`) and races exit; the marker must land before the lock is released. |
| 13 | `extension/team-tool/cancel.ts:401` | `task.cancelled` | `handleCancel` (async) | `task.cancelled` ∈ `TERMINAL_EVENT_TYPES` — terminal path. |

### 3.2 Class (a) — RETAINED keep-sync, documented read-back contracts (26 sites)

Every site in this table has an in-code comment (quoted/paraphrased in the reason
column) documenting **why** a buffered/async conversion was rejected — most were
converted during M2a/M2b (2026-09-10) and **reverted in review**. Re-converting any of
them requires first migrating the synchronous reader named in the comment.

| # | Call-site | Event type | Enclosing function | Documented contract |
|---|---|---|---|---|
| 14 | `state/stores/plan-store.ts:155` | `plan.created` / `plan.revised` | `appendPlanRevision` (sync, inside lock) | "REVIEW FIX (2026-09-10): reverted M2b — plan lifecycle events are low-frequency and consumers (plan-store tests, status display) expect read-your-writes; sync errors propagate to the producer inside the lock." |
| 15 | `state/stores/plan-store.ts:215` | `plan.approved` / `plan.rejected` | `setPlanApproval` (sync) | Same revert comment ("see above"). |
| 16 | `runtime/plan-approval.ts:125` | `plan.approval_required` | `ensurePlanApprovalRequested` (async) | Approval gate: the gate must be durably armed before the API returns; low-frequency → conversion payoff ≈ 0. |
| 17 | `runtime/plan-replan.ts:116` | `plan.item.dropped` (hard) | `sweepDroppedPlanItems` (sync) | "REVIEW FIX (2026-09-10): reverted M2b — sweep tests read plan.item.dropped events synchronously." |
| 18 | `runtime/plan-replan.ts:133` | `plan.item.dropped` (advisory) | `sweepDroppedPlanItems` | Same ("see above"). |
| 19 | `runtime/goal-workflow/goal-state-store.ts:87` | `goal.state_changed` | `GoalStateStore.save` (sync) | "REVIEW FIX (2026-09-10): reverted M2b — goal.state_changed is read back synchronously by CAS tests and goal status display; low-frequency transition event." |
| 20 | `runtime/goal-workflow/dynamic-workflow-runner.ts:188` | `dwf.trust_denied` | `runDynamicWorkflow` (async) | "REVIEW FIX (2026-09-10): DWF lifecycle events reverted from M2a — runner sites are read back synchronously (dwf-setresult tests, resume flow, status display after run end)." Also thrown-error adjacent. |
| 21 | `runtime/goal-workflow/dynamic-workflow-runner.ts:198` | `dwf.started` | `runDynamicWorkflow` | Same revert comment covers all runner lifecycle sites. |
| 22 | `runtime/goal-workflow/dynamic-workflow-runner.ts:211` | `dwf.resumed` | `runDynamicWorkflow` | Resume-flow marker — same read-back set. |
| 23 | `runtime/goal-workflow/dynamic-workflow-runner.ts:288` | `dwf.failed` | `runDynamicWorkflow` | Lifecycle terminal. ⚠ `dwf.failed` NOT in `TERMINAL_EVENT_TYPES` → buffered would lose the terminal bypass; must stay sync. |
| 24 | `runtime/goal-workflow/dynamic-workflow-runner.ts:323` | `dwf.phase_completed` (closing safety net, round-12 P0-1) | `runDynamicWorkflow` | Runner lifecycle; asserted by dwf-setresult rounds after run end. |
| 25 | `runtime/goal-workflow/dynamic-workflow-runner.ts:331` | `dwf.completed` | `runDynamicWorkflow` | Lifecycle terminal; ⚠ not in `TERMINAL_EVENT_TYPES` (same as row 23). |
| 26 | `runtime/goal-workflow/dynamic-workflow-context.ts:373` | `dwf.log` (agent-call cap record) | `makeWorkflowCtx` → agent-call cap guard | "Durable record" immediately before `DwfAgentCallCapError` throw; asserted by cap tests. |
| 27 | `runtime/goal-workflow/dynamic-workflow-context.ts:781` | `dwf.phase_completed` | `makeWorkflowCtx` → `phase()` (sync ctx API) | "REVIEW FIX (2026-09-10): reverted M2a — phase transitions are low-frequency AND read back synchronously (tests, checkpoint resume; dwf-setresult rounds 12/14/18 assert the events file immediately after the run)." |
| 28 | `runtime/goal-workflow/dynamic-workflow-context.ts:804` | `dwf.phase_started` | `makeWorkflowCtx` → `phase()` | Same ("see phase_completed"). |
| 29 | `runtime/goal-workflow/dynamic-workflow-context.ts:819` | `dwf.log` (`ctx.log`) | `makeWorkflowCtx` → `log()` | Same ("see phase()"). |
| 30 | `runtime/group-join.ts:135` | `agent.group_join.partial` / `.completed` | `deliverGroupJoin` (**sync**, returns result) | Read-after-write: the sync function's return value is consumed immediately; callers/tests read events right after. |
| 31 | `runtime/group-join.ts:148` | `agent.group_join.delivery_reused` | `deliverGroupJoin` | Same. |
| 32 | `extension/team-tool/api/mailbox.ts:194` | `mailbox.acknowledged` | mailbox ack API (inside `withRunLockSync`) | "Read-your-writes (CI 2026-09-11, phase4): the ack API returns and callers/tests read events.jsonl synchronously right after — buffered append flushes later." |
| 33 | `extension/team-tool/api/mailbox.ts:204` | `agent.group_join.acknowledged` | mailbox ack API | Same comment block. |
| 34 | `extension/team-tool/status.ts:203` | `agent.group_join.ack_timeout` | `handleStatus` (**sync** tool handler) | "REVIEW FIX (2026-09-10): reverted M2b — the dedupe set below is rebuilt from readEventsCursor in THIS invocation, so a buffered write would re-emit duplicates on sub-20ms re-polls." |
| 35 | `runtime/attention-events.ts:21` | `task.attention` | `appendTaskAttentionEvent` (sync → boolean) | Read-your-writes **dedupe**: reads a 256KB tail of the same file immediately before (`:13-21`); buffered append would race the dedupe and duplicate events. (⚠ `task.needs_attention` IS terminal — different type, also stays sync via the buffer bypass.) |
| 36 | `runtime/foreground-control.ts:193` | `foreground.interrupt_requested` | `writeForegroundInterruptRequest` (sync) | "Read-your-writes (CI 2026-09-11, phase6): for a fresh manifest this may be the FIRST event — buffered append leaves events.jsonl nonexistent at the sync read right after (ENOENT)." |
| 37 | `runtime/supervisor-contact.ts:28` | `supervisor.contact` | `recordSupervisorContact` (sync) | "REVIEW FIX (2026-09-10): reverted M2b — supervisor.contact events are read back synchronously (tests + contact-history display); low-frequency by design." |
| 38 | `hooks/registry.ts:185` | `hook.executed` | `appendHookEvent` (sync) | "REVIEW FIX (2026-09-10): reverted M2b — hook.executed events are read back synchronously (recovery-hooks tests, hooks audit display) and are low-frequency." |
| 39 | `extension/team-tool/api/agent-control.ts:61` | `agent.nudged` | nudge API handler | "Read-your-writes (CI 2026-09-11, phase8): the nudge caller reads events.jsonl synchronously right after dispatch — sync appendEvent." |

### 3.3 Class (b) — async-eligible sync `appendEvent()` call-sites

**None.** 0 of the 39 real sync call-sites are class (b). The hot paths this class was
created for already use the async family — `task.progress` is written via
`appendEventBuffered` (`runtime/dispatch-batch.ts:628`, `runtime/task-runner/child-executor.ts:530`)
and `appendEventFireAndForget` (`runtime/task-runner/live-executor.ts:108`); the worker-side
event stream uses its own O_APPEND writer (§4).

## 4. Local `appendEvent` shadows — NOT event-log call-sites (grep false positives)

| Site | What it actually calls | Status |
|---|---|---|
| `prompt/worker-events-channel.ts:109` (inside `write()` closure, `:108-125`) | Local `appendEvent` seam (`:60-93`): injectable; default = raw single-line `appendFileSync` with O_APPEND, partial-line quarantine guard, caller-stamped `time`. | **Do not convert** in B1. Its crash-safety contract (single-line atomicity, quarantine) differs from event-log's lock+fsync; the raw writer is already the cheapest sync write possible. Conversion is a redesign, not a sweep. |
| `runtime/surface/degrade.ts:681` (inside `degrade()` closure, `createSurfaceRuntimeController`) | Local `appendEvent` (`:638-646`): injectable; **default = `appendEventFireAndForget`** (imported at `:29`). | Already async — nothing to sweep. The explorer's "(b) surface.degraded" row was this shadow, not a sync site. |

## 5. Flush coverage — machinery already present (verified)

1. **Buffered-event flush on process end** — `event-log.ts`:
   - `:1218` `process.on("exit")` → `flushBufferedQueuesSync()` + `asyncQueues.clear()` (EL-2: sync-only hook, uses sync lock + `appendFileSync` + fsync + `persistSequence`).
   - `:1236` `process.on("beforeExit")` → awaits `flushEventLogBuffer()` + `drainAsyncQueues()` (async-aware; only when pending work exists — avoids floating-promise failures under `--test-force-exit`).
   - `:1252-1253` `SIGTERM` / `SIGINT` → `setImmediate(() => flushBufferedQueuesSync())` — handler returns immediately so the main thread is never blocked by sync I/O from an idle terminal.
   - `:1258` `uncaughtException` → sync flush + queue clear, then re-throw (preserves default exit).
2. **Atomic-write coalescer flush** — `atomic-write.ts:1229-1231`: `exit` → `flushPendingAtomicWrites()`; `SIGTERM`/`SIGINT` → `setImmediate(flushPendingAtomicWrites)`. The coalescer (50ms) has the ST-7 `skipCoalesce: true` escape hatch — terminal task transitions fall through to a **synchronous** `atomicWriteJson` so they survive SIGKILL inside the coalesce window.
3. **Background runner signals** — `background-runner.ts`:
   - `:217` SIGINT (RT-2): `abortController.abort()` + `process.exitCode = 130` — deliberately NOT `process.exit(130)` so `main()`'s `finally` cleanup (child-pi termination, worker unregister) still runs.
   - `:841` SIGTERM (BUG #17 fix): performs real buffered I/O (`async.sigterm_received_graceful_shutdown`) to flush io_uring state, then aborts for graceful shutdown.
4. **Self-flushing buffers** (no external timer needed): `appendEventBuffered` flushes per-queue at `DEFAULT_BUFFER_MS = 20` via an unref'd timer with terminal-type bypass (`event-log.ts:1058-1081`); the atomic coalescer flushes at 50ms.

## 6. Gap-fill decisions (Phase 2 scope)

- **Periodic flush option: REJECTED.** No `setInterval` exists in `src/state/event-log/`
  or `atomic-write.ts` (verified), and none is warranted: `appendEventAsync` writes
  immediately per event (no batch window to age out), the buffered queue self-flushes at
  20ms, coalesced atomic writes at 50ms, and `beforeExit` drains what remains. A periodic
  timer would add wakeups and a keep-alive handle for zero additional durability.
- **SIGHUP handler: REJECTED.** A listener that only flushes (mirroring SIGTERM/SIGINT)
  suppresses SIGHUP's default terminate-on-hangup — in the foreground `pi` session no
  other SIGHUP handler would exit the process, producing a zombie session holding run
  locks. A listener that also exits (`process.exit(129)`) recreates the RT-2 bug class
  (exit bypasses `finally` cleanup → orphaned child-pi workers). Both variants are worse
  than the status quo; the residual ≤20ms buffered-loss window on hangup is accepted
  (consistent with the documented SIGKILL caveat, `event-log.ts:1045-1048`).
- **No other gaps found.** Exit-hook flush for catchable signals named by the spec
  (SIGTERM/SIGINT) is fully covered in all three layers (§5). Phase 2 is therefore
  **doc-only**; no source changes.

## 7. Accepted residual risks

| Risk | Window | Why accepted |
|---|---|---|
| SIGKILL (kill -9) | Buffered events ≤20ms in flight; coalesced atomic writes ≤50ms | Cannot be intercepted; documented at `event-log.ts:1046-1048` and in the buffer API docs. Mitigated where it matters: terminal types bypass the buffer; ST-7 skipCoalesce for terminal task transitions. |
| Default-disposition signal death (incl. SIGHUP) | Same ≤20ms window; `exit` hook does not fire on signal-kill | See §6 SIGHUP analysis. |
| Second-signal race | `setImmediate` flush from the first SIGTERM/SIGINT may not complete before a follow-up kill | Deliberate trade-off: the handler must return immediately (idle-TUI safety). Follow-up signals escalate to SIGKILL semantics = accepted risk above. |

## 8. Implications for Phase 3 (B1 sweep) and atomic-write hardening

- **B1 sweep = no-op on current evidence.** 39/39 sync call-sites are keep-sync
  (13 mandatory + 26 documented read-back contracts); the explorer's three "(b)"
  candidates dissolve on inspection (`worker-events-channel.ts:109` and `degrade.ts:681`
  are local shadows — §4; `goal-state-store.ts:87` has an explicit revert comment —
  row 19). The M2a/M2b effort (2026-09-10) already ran this sweep and review reverted
  it; the revert comments are the per-site do-not-convert evidence trail. Any future
  conversion of a row-14-39 site must first migrate the named synchronous reader and
  cite this policy.
- **Atomic-write hardening (W-E tail) = DEFER / already adopted.** `state-store.ts`
  already persists manifest and tasks via `atomicWriteJson` / `atomicWriteJsonCoalesced`
  (ST-7 `skipCoalesce` for terminal) / `atomicWriteJsonAsync` — all backed by
  `atomic-write.ts` write-temp-rename + fsync + parent-dir fsync. There is no remaining
  non-atomic JSON state write to harden in the state store; a re-hardening pass would be
  make-work.
