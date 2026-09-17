# appendEvent Census — WI-1.6 (M1a Evidence & Baseline)

- Date: 2026-09-10
- HEAD: `627f59c9c6891eb9c78307ca17d24907bd5dae79` (pi-crew repo, working tree)
- Node: v22.23.1, linux
- Scope: `src/**` non-test TypeScript (verified: zero `*.test.ts` / `__tests__/` exist under `src/`)
- Terminal-type reference: `src/config/defaults.ts:81-92` → `DEFAULT_EVENT_LOG.terminalEventTypes` = 9 types:
  `run.blocked`, `run.completed`, `run.failed`, `run.cancelled`, `task.completed`, `task.failed`,
  `task.skipped`, `task.cancelled`, `task.needs_attention`

## 1. Verdict on the claim "80 sync call-site / 31 file"

**Claim is OFF-BY-ONE. Real count: 79 sync `appendEvent` call-sites across 31 files.**

The `80` figure comes from raw grep minus the definition only; it misses one comment line that also
matches the grep. Exact derivation (each command re-runnable at this HEAD):

```bash
cd /home/bom/source/my_pi/pi-crew
# raw lines matching the sync API name (includes 1 definition + 1 comment):
grep -rnE "\bappendEvent\(" src/ --include="*.ts" | grep -v "\.test\.ts" | wc -l
# → 81
# minus the definition (event-log.ts:241):
grep -rnE "\bappendEvent\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "export function appendEvent(" | wc -l
# → 80   ← this is where the claim's "80" stopped
# minus the comment mention (event-log.ts:429 JSDoc "prefer this over the sync `appendEvent()`"):
grep -rnE "\bappendEvent\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "export function appendEvent(" | grep -v "event-log.ts:429:" | wc -l
# → 79   ← TRUE sync call-site count
# files containing at least one real sync call-site (31; includes event-log.ts internal site):
grep -rlE "\bappendEvent\(" src/ --include="*.ts" | grep -v "\.test\.ts" | wc -l
# → 31
```

Of the 79 sync call-sites, **78 are external** and **1 is internal**
(`state/event-log/event-log.ts:1073` — the buffered terminal-path flush passthrough inside
`appendEventBuffered`). The 31-file figure holds either way (30 external-only files + event-log.ts).

## 2. Census scope note — the API is a bare function, not a method

`grep ".appendEvent("` (method-style, as written in the research claim) returns **0 matches** in
`src/` — all call-sites import the function from `state/event-log/event-log.ts` and call it bare.
The event-log surface has **4 append variants**, all census-ed here:

| Variant | Kind | Definition | Real call-sites | External / internal |
|---|---|---|---|---|
| `appendEvent` | sync, deprecated (`@deprecated` event-log.ts:101) | event-log.ts:241 | **79** | 78 / 1 (ts:1073) |
| `appendEventAsync` | async, recommended | event-log.ts:431 | **68** | 67 / 1 (ts:1207, f&f wrapper) |
| `appendEventBuffered` | buffered, coalescing | event-log.ts:1058 | **2** | 2 / 0 |
| `appendEventFireAndForget` | async f&f wrapper | event-log.ts:1206 | **25** | 25 / 0 |
| **TOTAL** | | | **174** | **172 external + 2 internal** |

Excluded from counts: 1 definition per variant (4), 3 comment mentions
(event-log.ts:101, :237, :429), 0 test files (none in `src/`).

Reproduction:

```bash
grep -rnE "\bappendEventAsync\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/state/event-log/event-log.ts:" | wc -l   # → 67 external (+1 internal wrapper call at ts:1207 = 68)
grep -rnE "\bappendEventBuffered\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/state/event-log/event-log.ts:" | wc -l  # → 2
grep -rnE "\bappendEventFireAndForget\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/state/event-log/event-log.ts:" | wc -l # → 25
```

The only 2 `appendEventBuffered` call-sites (the ~50× cheaper primitive from b4 bench):
- `src/runtime/dispatch-batch.ts:591` — `void appendEventBuffered(...)` — `task.coalesced_dispatch_start`
- `src/runtime/task-runner/child-executor.ts:445` — `void appendEventBuffered(...)` — `task.progress` family

## 3. await / no-await split

- sync `appendEvent`: **0 awaited, 0 voided, 79 bare** (it returns `TeamEvent`, not a Promise — awaiting is impossible; verified no `await appendEvent(` exists).
- `appendEventAsync` (68): **44 awaited, 17 `void`-ed, 7 bare floating** (per-site column below).
- `appendEventBuffered` (2): both `void`-ed.
- `appendEventFireAndForget` (25): all bare (wrapper returns void by design).

## 4. Terminal classification — methodology & legend

For every call-site the `type:` property expression of the event literal was extracted and matched
against the 9 terminal types:

- **TERMINAL** — expression resolves to literal(s) that are all in `terminalEventTypes` (incl. ternaries whose every branch is a terminal literal).
- **NON-TERMINAL** — literal(s), none terminal (progress/lifecycle/diagnostic events).
- **NON-TERMINAL\*** — identifier/passthrough whose *type signature constrains* it to a closed non-terminal literal union (code-verified, e.g. `signalEventType()` → `"async.signal" | "async.failed"`).
- **DYNAMIC** — variable/passthrough with unconstrained type at the call-site.
- **DYNAMIC†** — internal passthrough inside `event-log.ts` itself.
- **DYNAMIC(template)** — template literal; prefix annotated (see below).

### Headline classification (all 174 call-sites)

| Class | Count | Notes |
|---|---|---|
| TERMINAL | **9** | 8 direct-literal + 1 all-terminal ternary (post-execution.ts:638) |
| NON-TERMINAL (+`*`) | **157** | 154 literal + 3 constrained-union |
| DYNAMIC (all kinds) | **8** | 4 var/passthrough + 2 internal `†` + 2 template |

Only **2 template sites** exist and both are load-bearing:
- `state/stores/state-store.ts:830` — `` `run.${status}` `` → **terminal-producing** (the ONLY producer of `run.completed` / `run.failed` / `run.cancelled` / `run.blocked` run-status events via state-store; provenance `team_runner`).
- `runtime/task-runner/child-executor.ts:636` — `` `worker.${event.type}` `` → non-terminal `worker.*` lifecycle family.

### Terminal-literal inventory (9 TERMINAL sites)

| file:line | variant | type |
|---|---|---|
| extension/team-tool/cancel.ts:395 | **sync** | `task.cancelled` ← **the ONLY sync terminal call-site in the codebase** |
| extension/team-tool/run.ts:577 | async | `run.blocked` |
| extension/team-tool/run.ts:673 | async | `run.blocked` |
| extension/team-tool.ts:409 | async | `run.blocked` |
| runtime/dispatch-batch.ts:893 | async | `task.cancelled` |
| runtime/task-runner/post-execution.ts:198 | async | `task.needs_attention` |
| runtime/task-runner/post-execution.ts:638 | async | ternary `task.failed` / `task.needs_attention` / `task.completed` |
| runtime/team-runner.ts:675 | async | `task.cancelled` |
| runtime/team-runner.ts:1091 | async | `run.cancelled` |

Notable negative findings:
- **`run.completed` never appears as a direct literal at any call-site** — it is only produced via the state-store template (`run.${status}`).
- `task.completed` / `task.failed` literals appear only inside the post-execution.ts:638 ternary.
- `task.skipped`: **0 call-sites** emit it as a literal anywhere in `src/` (grep-verified below).
- `run.blocked` (3 async) is the most common terminal literal.

```bash
# terminal-literal reproduction:
grep -rn 'type: "run\.\(blocked\|completed\|failed\|cancelled\)"' src/ --include="*.ts" | grep -v "\.test\.ts"
grep -rn 'type: "task\.\(completed\|failed\|skipped\|cancelled\|needs_attention\)"' src/ --include="*.ts" | grep -v "\.test\.ts"
# task.skipped literal → 0 hits (checked 2026-09-10)
```

## 5. Per-file rollup (52 files, 174 call-sites)

Sorted by total call-sites, then sync count. The research claim's "top" list is CONFIRMED with
exact numbers: **goal-loop-runner (13, all sync) > background-runner (12) > crash-recovery (7, all
sync) = finalize-run (7) > dynamic-workflow-runner (6)**; **team-tool/api cluster = 11 sync across
5 files** (mailbox 3, task-claims 3, agent-control 2, plan-approval 2, heartbeat 1).

| file | total | sync `appendEvent` | async | buffered | fire-and-forget | TERMINAL | NON-TERM | DYNAMIC |
|---|---|---|---|---|---|---|---|---|
| `runtime/goal-workflow/goal-loop-runner.ts` | 13 | 13 | 0 | 0 | 0 | 0 | 13 | 0 |
| `runtime/background-runner.ts` | 12 | 11 | 0 | 0 | 1 | 0 | 12 | 0 |
| `extension/team-tool.ts` | 8 | 0 | 6 | 0 | 2 | 1 | 6 | 1 |
| `runtime/dispatch-batch.ts` | 8 | 0 | 7 | 1 | 0 | 1 | 7 | 0 |
| `runtime/recovery/crash-recovery.ts` | 7 | 7 | 0 | 0 | 0 | 0 | 7 | 0 |
| `runtime/finalize-run.ts` | 7 | 3 | 2 | 0 | 2 | 0 | 7 | 0 |
| `extension/team-tool/run.ts` | 7 | 0 | 7 | 0 | 0 | 2 | 5 | 0 |
| `runtime/broker/crew-broker.ts` | 7 | 0 | 7 | 0 | 0 | 0 | 7 | 0 |
| `runtime/task-runner/post-execution.ts` | 7 | 0 | 7 | 0 | 0 | 2 | 4 | 1 |
| `runtime/task-runner/pre-execution.ts` | 7 | 0 | 1 | 0 | 6 | 0 | 7 | 0 |
| `runtime/goal-workflow/dynamic-workflow-runner.ts` | 6 | 6 | 0 | 0 | 0 | 0 | 6 | 0 |
| `runtime/goal-workflow/adaptive-plan.ts` | 6 | 0 | 1 | 0 | 5 | 0 | 6 | 0 |
| `runtime/live-session/live-session-runtime.ts` | 6 | 0 | 0 | 0 | 6 | 0 | 6 | 0 |
| `runtime/team-runner.ts` | 5 | 1 | 4 | 0 | 0 | 2 | 3 | 0 |
| `extension/team-tool/lifecycle-actions.ts` | 4 | 0 | 4 | 0 | 0 | 0 | 4 | 0 |
| `runtime/task-runner/child-executor.ts` | 4 | 0 | 3 | 1 | 0 | 0 | 3 | 1 |
| `extension/team-tool/api/mailbox.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 3 | 0 |
| `extension/team-tool/api/task-claims.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 3 | 0 |
| `runtime/goal-workflow/dynamic-workflow-context.ts` | 3 | 3 | 0 | 0 | 0 | 0 | 3 | 0 |
| `extension/team-tool/cancel.ts` | 3 | 1 | 2 | 0 | 0 | 1 | 2 | 0 |
| `extension/team-tool/goal.ts` | 3 | 0 | 3 | 0 | 0 | 0 | 3 | 0 |
| `runtime/budget-enforcement.ts` | 3 | 0 | 3 | 0 | 0 | 0 | 3 | 0 |
| `extension/team-tool/api/agent-control.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `extension/team-tool/api/plan-approval.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `extension/team-tool/status.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `runtime/group-join.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `runtime/plan-replan.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `state/stores/plan-store.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 2 | 0 |
| `state/stores/state-store.ts` | 2 | 2 | 0 | 0 | 0 | 0 | 1 | 1 |
| `runtime/surface/degrade.ts` | 2 | 1 | 0 | 0 | 1 | 0 | 1 | 1 |
| `state/event-log/event-log.ts` | 2 | 1 | 1 | 0 | 0 | 0 | 0 | 2 |
| `extension/team-tool/respond.ts` | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| `runtime/scheduling/run-coalesced-task-group.ts` | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| `runtime/workflow-phase-advance.ts` | 2 | 0 | 2 | 0 | 0 | 0 | 2 | 0 |
| `extension/async-notifier.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `extension/team-tool/api/heartbeat.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `hooks/registry.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `prompt/scratchpad-lifecycle.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `prompt/worker-events-channel.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 0 | 1 |
| `runtime/attention-events.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `runtime/foreground-control.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `runtime/goal-workflow/goal-state-store.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `runtime/heartbeat/heartbeat-watcher.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `runtime/plan-approval.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `runtime/supervisor-contact.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `ui/run-action-dispatcher.ts` | 1 | 1 | 0 | 0 | 0 | 0 | 1 | 0 |
| `extension/team-tool/goal-wrap.ts` | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `extension/team-tool/parallel-dispatch.ts` | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `prompt/prompt-runtime.ts` | 1 | 0 | 0 | 0 | 1 | 0 | 1 | 0 |
| `runtime/async-runner.ts` | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `runtime/chain-runner.ts` | 1 | 0 | 1 | 0 | 0 | 0 | 1 | 0 |
| `runtime/task-runner/live-executor.ts` | 1 | 0 | 0 | 0 | 1 | 0 | 1 | 0 |
| **TOTAL (52 files)** | **174** | **79** | **68** | **2** | **25** | **9** | **157** | **8** |

## 6. Per-site detail

Legend for `variant`: sync `appendEvent` = deprecated sync API (conversion target);
`appendEventAsync` / `appendEventBuffered` / `appendEventFireAndForget` = non-blocking variants.
`await/void` column: `—` = bare call.
### runtime/goal-workflow/goal-loop-runner.ts — 13 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 124 | sync appendEvent | — | `goal.verification_compromised` | NON-TERMINAL |
| 204 | sync appendEvent | — | `goal.verification_compromised` | NON-TERMINAL |
| 524 | sync appendEvent | — | `goal.loop_start` | NON-TERMINAL |
| 548 | sync appendEvent | — | `goal.workspace_lock_failed` | NON-TERMINAL |
| 573 | sync appendEvent | — | `goal.budget_warning` | NON-TERMINAL |
| 586 | sync appendEvent | — | `goal.budget_warning` | NON-TERMINAL |
| 600 | sync appendEvent | — | `goal.turn_start` | NON-TERMINAL |
| 633 | sync appendEvent | — | `goal.loop_end` | NON-TERMINAL |
| 691 | sync appendEvent | — | `goal.turn_terminal_status` | NON-TERMINAL |
| 738 | sync appendEvent | — | `goal.turn_evaluated` | NON-TERMINAL |
| 749 | sync appendEvent | — | `goal.feedback_steered` | NON-TERMINAL |
| 784 | sync appendEvent | — | `goal.stuck` | NON-TERMINAL |
| 814 | sync appendEvent | — | `goal.loop_end` | NON-TERMINAL |

### runtime/background-runner.ts — 12 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 173 | appendEventFireAndForget | — | (param/passthrough) | NON-TERMINAL* — shorthand; signalEventType -> "async.signal"|"async.failed" |
| 254 | sync appendEvent | — | `async.interrupt_detected` | NON-TERMINAL |
| 309 | sync appendEvent | — | `async.failed` | NON-TERMINAL |
| 375 | sync appendEvent | — | `background.unregister_worker_failed` | NON-TERMINAL |
| 536 | sync appendEvent | — | `async.sigterm_received_graceful_shutdown` | NON-TERMINAL |
| 594 | sync appendEvent | — | `async.exit` | NON-TERMINAL |
| 633 | sync appendEvent | — | `async.started` | NON-TERMINAL |
| 661 | sync appendEvent | — | `async.watchdog_fired` | NON-TERMINAL |
| 823 | sync appendEvent | — | `runtime.resolved` | NON-TERMINAL |
| 888 | sync appendEvent | — | `async.completed` | NON-TERMINAL |
| 913 | sync appendEvent | — | `async.failed` | NON-TERMINAL |
| 986 | sync appendEvent | — | `async.failed` | NON-TERMINAL |

### extension/team-tool.ts — 8 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 396 | appendEventAsync | await | `runtime.resolved` | NON-TERMINAL |
| 409 | appendEventAsync | await | `run.blocked` | TERMINAL |
| 450 | appendEventAsync | await | `run.resume_requested` | NON-TERMINAL |
| 459 | appendEventAsync | await | `task.checkpoint_recovered` | NON-TERMINAL |
| 466 | appendEventAsync | await | `mailbox.replayed` | NON-TERMINAL |
| 552 | appendEventFireAndForget | — | `task.steer_dropped` | NON-TERMINAL |
| 580 | appendEventAsync | void | `task.steer_queued` | NON-TERMINAL |
| 837 | appendEventFireAndForget | — | (param/passthrough) | DYNAMIC — passthrough Record (team-tool event sink) |

### runtime/dispatch-batch.ts — 8 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 216 | appendEventAsync | await | `ask.timedout` | NON-TERMINAL |
| 435 | appendEventAsync | await | `workflow.preconditions` | NON-TERMINAL |
| 499 | appendEventAsync | await | `task.coalesced` | NON-TERMINAL |
| 513 | appendEventAsync | await | `limits.unbounded` | NON-TERMINAL |
| 591 | appendEventBuffered | void | `task.progress` | NON-TERMINAL |
| 640 | appendEventAsync | await | `task.parallel_start` | NON-TERMINAL |
| 836 | appendEventAsync | — | `crew.task.retry_attempt` | NON-TERMINAL |
| 893 | appendEventAsync | — | `task.cancelled` | TERMINAL |

### runtime/recovery/crash-recovery.ts — 7 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 159 | sync appendEvent | — | `crew.run.recovery_skipped` | NON-TERMINAL |
| 169 | sync appendEvent | — | `crew.run.recovery_blocked` | NON-TERMINAL |
| 198 | sync appendEvent | — | `crew.run.resumed` | NON-TERMINAL |
| 221 | sync appendEvent | — | `crew.run.recovery_declined` | NON-TERMINAL |
| 330 | sync appendEvent | — | `crew.run.orphan_skip` | NON-TERMINAL |
| 369 | sync appendEvent | — | `crew.run.orphan_cancelled` | NON-TERMINAL |
| 748 | sync appendEvent | — | `crew.run.reconciled_stale` | NON-TERMINAL |

### runtime/finalize-run.ts — 7 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 214 | sync appendEvent | — | `branch.stale` | NON-TERMINAL |
| 235 | sync appendEvent | — | ternary: policy.escalated / policy.action | NON-TERMINAL |
| 243 | sync appendEvent | — | ternary: recovery.escalated / recovery.attempted | NON-TERMINAL |
| 326 | appendEventFireAndForget | — | `task.reconciled_from_disk` | NON-TERMINAL |
| 357 | appendEventFireAndForget | — | `run.deliverable_warning` | NON-TERMINAL |
| 379 | appendEventAsync | await | `run.effectiveness` | NON-TERMINAL |
| 473 | appendEventAsync | await | `run.terminal_preserved` | NON-TERMINAL |

### extension/team-tool/run.ts — 7 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 135 | appendEventAsync | void | `async.failed` | NON-TERMINAL |
| 481 | appendEventAsync | void | `config.warning` | NON-TERMINAL |
| 532 | appendEventAsync | — | `runtime.resolved` | NON-TERMINAL |
| 562 | appendEventAsync | — | `runtime.resolved` | NON-TERMINAL |
| 577 | appendEventAsync | void | `run.blocked` | TERMINAL |
| 621 | appendEventAsync | void | `async.spawned` | NON-TERMINAL |
| 673 | appendEventAsync | void | `run.blocked` | TERMINAL |

### runtime/broker/crew-broker.ts — 7 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 1088 | appendEventAsync | await | `worker.message` | NON-TERMINAL |
| 1559 | appendEventAsync | void | (param/passthrough) | NON-TERMINAL* — type param constrained to delegate.* union |
| 1906 | appendEventAsync | void | `policy.action` | NON-TERMINAL |
| 2028 | appendEventAsync | void | `task.waiting` | NON-TERMINAL |
| 2037 | appendEventAsync | void | `ask.requested` | NON-TERMINAL |
| 2147 | appendEventAsync | void | `ask.answered` | NON-TERMINAL |
| 2156 | appendEventAsync | void | `task.resumed` | NON-TERMINAL |

### runtime/task-runner/post-execution.ts — 7 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 171 | appendEventAsync | await | `task.surface_lost` | NON-TERMINAL |
| 198 | appendEventAsync | await | `task.needs_attention` | TERMINAL |
| 295 | appendEventAsync | await | `task.output_validation` | NON-TERMINAL |
| 366 | appendEventAsync | await | `task.output_validation` | NON-TERMINAL |
| 466 | appendEventAsync | await | (param/passthrough) | DYNAMIC — spec-gate event.type |
| 474 | appendEventAsync | await | `task.spec_gate` | NON-TERMINAL |
| 638 | appendEventAsync | await | ternary: task.failed / task.needs_attention / task.completed | TERMINAL |

### runtime/task-runner/pre-execution.ts — 7 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 127 | appendEventFireAndForget | — | `spec.frozen` | NON-TERMINAL |
| 201 | appendEventAsync | await | `task.started` | NON-TERMINAL |
| 250 | appendEventFireAndForget | — | `hook.pre_step_skipped` | NON-TERMINAL |
| 261 | appendEventFireAndForget | — | `hook.pre_step_started` | NON-TERMINAL |
| 283 | appendEventFireAndForget | — | `hook.pre_step_completed` | NON-TERMINAL |
| 292 | appendEventFireAndForget | — | `hook.pre_step_failed` | NON-TERMINAL |
| 307 | appendEventFireAndForget | — | `hook.pre_step_optional_failed` | NON-TERMINAL |

### runtime/goal-workflow/dynamic-workflow-runner.ts — 6 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 157 | sync appendEvent | — | `dwf.trust_denied` | NON-TERMINAL |
| 167 | sync appendEvent | — | `dwf.started` | NON-TERMINAL |
| 180 | sync appendEvent | — | `dwf.resumed` | NON-TERMINAL |
| 254 | sync appendEvent | — | `dwf.failed` | NON-TERMINAL |
| 289 | sync appendEvent | — | `dwf.phase_completed` | NON-TERMINAL |
| 297 | sync appendEvent | — | `dwf.completed` | NON-TERMINAL |

### runtime/goal-workflow/adaptive-plan.ts — 6 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 421 | appendEventFireAndForget | — | `adaptive.plan_missing` | NON-TERMINAL |
| 443 | appendEventFireAndForget | — | `adaptive.plan_missing` | NON-TERMINAL |
| 477 | appendEventFireAndForget | — | `adaptive.plan_repaired` | NON-TERMINAL |
| 485 | appendEventFireAndForget | — | `adaptive.plan_repair_failed` | NON-TERMINAL |
| 492 | appendEventFireAndForget | — | `adaptive.plan_missing` | NON-TERMINAL |
| 635 | appendEventAsync | await | `adaptive.plan_injected` | NON-TERMINAL |

### runtime/live-session/live-session-runtime.ts — 6 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 744 | appendEventFireAndForget | — | `task.model_dropped` | NON-TERMINAL |
| 798 | appendEventFireAndForget | — | `"live-session.session_created"` | NON-TERMINAL |
| 819 | appendEventFireAndForget | — | `"live-session.bind_extensions_error"` | NON-TERMINAL |
| 1021 | appendEventFireAndForget | — | `"live-session.prompt_start"` | NON-TERMINAL |
| 1041 | appendEventFireAndForget | — | `"live-session.prompt_error"` | NON-TERMINAL |
| 1062 | appendEventFireAndForget | — | `"live-session.prompt_done"` | NON-TERMINAL |

### runtime/team-runner.ts — 5 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 429 | sync appendEvent | — | `run.goal_achievement` | NON-TERMINAL |
| 675 | appendEventAsync | — | `task.cancelled` | TERMINAL |
| 737 | appendEventAsync | await | `recovery.rerun_task` | NON-TERMINAL |
| 1042 | appendEventAsync | await | `surface.requeued` | NON-TERMINAL |
| 1091 | appendEventAsync | await | `run.cancelled` | TERMINAL |

### extension/team-tool/lifecycle-actions.ts — 4 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 131 | appendEventAsync | await | `run.exported` | NON-TERMINAL |
| 259 | appendEventAsync | await | `run.forget_requested` | NON-TERMINAL |
| 279 | appendEventAsync | await | `async.kill_requested` | NON-TERMINAL |
| 658 | appendEventAsync | await | `worktree.cleanup` | NON-TERMINAL |

### runtime/task-runner/child-executor.ts — 4 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 352 | appendEventAsync | void | `task.model_dropped` | NON-TERMINAL |
| 445 | appendEventBuffered | void | `task.progress` | NON-TERMINAL |
| 636 | appendEventAsync | void | `worker.${event.type}` (template) | DYNAMIC(template) |
| 815 | appendEventAsync | await | `worker.cancelled` | NON-TERMINAL |

### extension/team-tool/api/mailbox.ts — 3 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 132 | sync appendEvent | — | `mailbox.message` | NON-TERMINAL |
| 188 | sync appendEvent | — | `mailbox.acknowledged` | NON-TERMINAL |
| 194 | sync appendEvent | — | `agent.group_join.acknowledged` | NON-TERMINAL |

### extension/team-tool/api/task-claims.ts — 3 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 95 | sync appendEvent | — | `task.claimed` | NON-TERMINAL |
| 165 | sync appendEvent | — | `task.claim_released` | NON-TERMINAL |
| 244 | sync appendEvent | — | `task.status_transitioned` | NON-TERMINAL |

### runtime/goal-workflow/dynamic-workflow-context.ts — 3 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 691 | sync appendEvent | — | `dwf.phase_completed` | NON-TERMINAL |
| 713 | sync appendEvent | — | `dwf.phase_started` | NON-TERMINAL |
| 727 | sync appendEvent | — | `dwf.log` | NON-TERMINAL |

### extension/team-tool/cancel.ts — 3 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 229 | appendEventAsync | void | `task.retried` | NON-TERMINAL |
| 306 | appendEventAsync | await | `async.kill_requested` | NON-TERMINAL |
| 395 | sync appendEvent | — | `task.cancelled` | TERMINAL |

### extension/team-tool/goal.ts — 3 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 196 | appendEventAsync | await | `goal.loop_start` | NON-TERMINAL |
| 441 | appendEventAsync | await | `goal.resumed` | NON-TERMINAL |
| 490 | appendEventAsync | await | `goal.resume_spawn_failed` | NON-TERMINAL |

### runtime/budget-enforcement.ts — 3 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 214 | appendEventAsync | await | `run.budget_abort` | NON-TERMINAL |
| 240 | appendEventAsync | await | `run.budget_warning` | NON-TERMINAL |
| 263 | appendEventAsync | — | `task.budget_fair_share` | NON-TERMINAL |

### extension/team-tool/api/agent-control.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 57 | sync appendEvent | — | `agent.nudged` | NON-TERMINAL |
| 317 | sync appendEvent | — | `agent.control.queued` | NON-TERMINAL |

### extension/team-tool/api/plan-approval.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 71 | sync appendEvent | — | `plan.approved` | NON-TERMINAL |
| 153 | sync appendEvent | — | `plan.cancelled` | NON-TERMINAL |

### extension/team-tool/status.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 96 | sync appendEvent | — | `async.stale` | NON-TERMINAL |
| 195 | sync appendEvent | — | `agent.group_join.ack_timeout` | NON-TERMINAL |

### runtime/group-join.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 127 | sync appendEvent | — | ternary: agent.group_join.partial / agent.group_join.completed | NON-TERMINAL |
| 140 | sync appendEvent | — | `agent.group_join.delivery_reused` | NON-TERMINAL |

### runtime/plan-replan.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 114 | sync appendEvent | — | `plan.item.dropped` | NON-TERMINAL |
| 130 | sync appendEvent | — | `plan.item.dropped` | NON-TERMINAL |

### state/stores/plan-store.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 144 | sync appendEvent | — | ternary: plan.created / plan.revised | NON-TERMINAL |
| 203 | sync appendEvent | — | ternary: plan.approved / plan.rejected | NON-TERMINAL |

### state/stores/state-store.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 458 | sync appendEvent | — | `run.created` | NON-TERMINAL |
| 830 | sync appendEvent | — | `run.${status}` (template) | DYNAMIC(template) |

### runtime/surface/degrade.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 642 | appendEventFireAndForget | — | (param/passthrough) | DYNAMIC — passthrough AppendTeamEvent |
| 681 | sync appendEvent | — | `surface.degraded` | NON-TERMINAL |

### state/event-log/event-log.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 1073 | sync appendEvent | — | (param/passthrough) | DYNAMIC† — buffered terminal-path passthrough (terminal-only by routing) |
| 1207 | appendEventAsync | — | (param/passthrough) | DYNAMIC† — fire-and-forget wrapper passthrough |

### extension/team-tool/respond.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 240 | appendEventAsync | void | `ask.answered` | NON-TERMINAL |
| 259 | appendEventAsync | void | `task.resumed` | NON-TERMINAL |

### runtime/scheduling/run-coalesced-task-group.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 61 | appendEventAsync | await | `task.coalesced_dispatch_start` | NON-TERMINAL |
| 289 | appendEventAsync | await | `task.coalesced_dispatch_end` | NON-TERMINAL |

### runtime/workflow-phase-advance.ts — 2 call-sites

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 75 | appendEventAsync | await | `workflow.phase_guard_blocked` | NON-TERMINAL |
| 87 | appendEventAsync | await | ternary: workflow.phase_failed / workflow.phase_completed | NON-TERMINAL |

### extension/async-notifier.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 116 | sync appendEvent | — | `async.died` | NON-TERMINAL |

### extension/team-tool/api/heartbeat.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 82 | sync appendEvent | — | `worker.heartbeat` | NON-TERMINAL |

### hooks/registry.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 182 | sync appendEvent | — | `hook.executed` | NON-TERMINAL |

### prompt/scratchpad-lifecycle.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 87 | sync appendEvent | — | (param/passthrough) | NON-TERMINAL* — shorthand type; param union "scratchpad.cell"|"scratchpad.restored" |

### prompt/worker-events-channel.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 109 | sync appendEvent | — | (param/passthrough) | DYNAMIC — item.type: string (worker channel) |

### runtime/attention-events.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 21 | sync appendEvent | — | `task.attention` | NON-TERMINAL |

### runtime/foreground-control.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 183 | sync appendEvent | — | `foreground.interrupt_requested` | NON-TERMINAL |

### runtime/goal-workflow/goal-state-store.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 84 | sync appendEvent | — | `goal.state_changed` | NON-TERMINAL |

### runtime/heartbeat/heartbeat-watcher.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 178 | sync appendEvent | — | `crew.task.heartbeat_dead` | NON-TERMINAL |

### runtime/plan-approval.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 112 | sync appendEvent | — | `plan.approval_required` | NON-TERMINAL |

### runtime/supervisor-contact.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 25 | sync appendEvent | — | `supervisor.contact` | NON-TERMINAL |

### ui/run-action-dispatcher.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 140 | sync appendEvent | — | `worker.kill_stale` | NON-TERMINAL |

### extension/team-tool/goal-wrap.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 272 | appendEventAsync | await | `goal.loop_start` | NON-TERMINAL |

### extension/team-tool/parallel-dispatch.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 168 | appendEventAsync | await | `run.started` | NON-TERMINAL |

### prompt/prompt-runtime.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 625 | appendEventFireAndForget | — | `ask.timedout` | NON-TERMINAL |

### runtime/async-runner.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 294 | appendEventAsync | await | `async.failed` | NON-TERMINAL |

### runtime/chain-runner.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 239 | appendEventAsync | await | `chain.step_completed` | NON-TERMINAL |

### runtime/task-runner/live-executor.ts — 1 call-site

| line | variant | await/void | type (verbatim) | class |
|---|---|---|---|---|
| 108 | appendEventFireAndForget | — | `task.progress` | NON-TERMINAL |

## 7. Key findings for M2 (buffered/async conversion scoping)

1. **Sync conversion surface = 79 sites, but only 1 emits a terminal event** (cancel.ts:395
   `task.cancelled`). Terminal-event sync-append risk (ordering vs buffer flush, the C-01 concern in
   event-log.ts) is therefore nearly zero on the sync path — the 79 sites are ~99% non-terminal
   progress/diagnostic events (`goal.*`, `async.*`, `recovery.*`, `plan.*`, `agent.*`, `dwf.*`...).
2. **Top sync hotspots for M2a conversion** (highest latency win per b4: sync ≈14 ms/event vs
   buffered ≈0.28 ms): goal-loop-runner (13), background-runner (11), crash-recovery (7),
   dynamic-workflow-runner (6), team-tool/api cluster (11), dynamic-workflow-context (3), finalize-run
   (3). These 7 file-groups cover 54/79 ≈ 68% of the sync surface.
3. `appendEventAsync` already routes terminal events through the **direct sync path internally**
   (event-log.ts:432-441 comment: "Do NOT route non-terminal events through appendEventBuffered") —
   so async adoption, not new plumbing, is the remaining work; the buffered primitive has exactly 2
   call-sites today.
4. Counting rule for the M2 re-scoping checkpoint (spec: convert-set > ~20 → split M2a/M2b):
   **79 sync sites exceed the threshold → M2a/M2b split recommended** (e.g. M2a = top-7 file-groups
   above; M2b = remaining 25 sites incl. the single terminal site with ordering care).
5. 7 async sites are bare floating promises (no `await`, no `void`, no `.catch`) — listed in §6 with
   variant `appendEventAsync` and `—` prefix; candidates for explicit `void`/`.catch` hygiene in M2
   (NOT a functional bug — fire-and-forget wrapper exists for this pattern).

## 8. Reproduction — full command set

```bash
cd /home/bom/source/my_pi/pi-crew
# (all commands run at HEAD 627f59c9c6891eb9c78307ca17d24907bd5dae79, 2026-09-10)

# sync appendEvent: 81 raw lines → 80 minus def → 79 minus comment; 31 files
grep -rnE "\bappendEvent\(" src/ --include="*.ts" | grep -v "\.test\.ts" | wc -l
grep -rlE "\bappendEvent\(" src/ --include="*.ts" | grep -v "\.test\.ts" | wc -l

# async / buffered / fire-and-forget (external; +1 internal each for async wrapper)
grep -rnE "\bappendEventAsync\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/state/event-log/event-log.ts:" | wc -l        # 67
grep -rnE "\bappendEventBuffered\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/state/event-log/event-log.ts:" | wc -l     # 2
grep -rnE "\bappendEventFireAndForget\(" src/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "src/state/event-log/event-log.ts:" | wc -l # 25

# per-file raw line counts (before def/comment exclusion):
grep -rcE "\bappendEvent\(" src/ --include="*.ts" | grep -v ":0$" | grep -v "\.test\." | sort -t: -k2 -rn

# terminal definitions reference:
sed -n '81,92p' src/config/defaults.ts
```

Census generated by scripted extraction (`\bappendEvent(` variant regex per file, comment/definition
exclusion, `type:` expression capture with multi-line window) + manual code-read verification of
every DYNAMIC / NOLITERAL / shorthand site (all annotated in §6).
