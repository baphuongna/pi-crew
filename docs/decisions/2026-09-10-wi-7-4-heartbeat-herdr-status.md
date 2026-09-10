# WI-7.4 — Heartbeat unification + herdr graceful-kill-by-pid (status)

**Date:** 2026-09-10
**Status**: ACCEPTED — **verdict: HEARTBEAT parity test shipped; herdr A2 deferred**
**Refs**:
- pi-crew-upgrade-spec.md §5 M7 / WI-7.4 (G27)
- R3 addendum: heartbeat unification parity test + herdr terminate-only-child test

## What this PR delivers

### 1. Heartbeat parity test (3 sources)

New test file `test/unit/runtime/heartbeat/heartbeat-source-parity.test.ts`:

The test asserts that the 3 heartbeat sources of truth agree on
"worker alive" classification:
- **task.heartbeat (manifest field)** — WorkerHeartbeatState in JSON
- **`<stateRoot>/heartbeat.json`** — team-runner-owned file
- **`crew.heartbeat.staleness_ms` metric** — observability gauge

For a synthetic WorkerHeartbeatState, all 3 sources should yield the
same `heartbeatAgeMs()` value (within 1ms tolerance for write-clock
drift).

### 2. herdr graceful-kill-by-pid ADR decision

The spec acceptance requires "herdr graceful-kill-by-pid có test
terminate-only-child-process". The current state:

```
src/runtime/surface/herdr-provider.ts:24-26:
  * `pane.close` để herdr tự terminate cả cây process trong pane, nên graceful
  * và force cùng đường (khác tmux provider). TODO(A2): kill theo pid worker
  * từ manifest (pane.process_info) trước khi pane.close cho graceful thật.
```

The "graceful" path in herdr-provider calls `pane.close`, which
herdr interprets as "kill the whole process tree inside this pane".
This is recorded as **A2 (graceful-by-pid)** in `herdr-provider.ts`.

**Decision**: defer A2 implementation to the next M7 polish cycle.
Rationale:
- A2 requires reading `pane.process_info` from herdr (a runtime
  capability check) and matching it against `manifest.tasks[i].pid`.
- A miss-fire here could terminate the wrong process (the herdr
  pane may host multiple agents in mixed-workflow scenarios).
- Without a green-path integration test against a real herdr
  instance, A2 cannot be safely verified.
- Current `pane.close` semantics are fail-safe (whole-tree kill,
  never partial). The cost is loss of "the agent had a chance to
  flush stdout cleanly" — observable but recoverable (recovery
  reattaches via existing ledger).

## Test for herdr graceful-kill-by-pid

The acceptance test from spec §5 M7:

> herdr graceful-kill-by-pid có test terminate-only-child-process.

**This is NOT shipped.** Reason: a meaningful test requires either
a real herdr instance (not available in unit tests) or a mock herdr
that captures the `pane.close`/`kill by pid` semantics correctly.
The unit-test mock would essentially be testing our own mock.

Spec acceptance is recorded as deferred. Re-evaluation trigger:
- When herdr exposes a test-mode API that allows capturing
  kill-by-pid calls, write the test against that.

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Re-evaluation triggers

This ADR is superseded when ANY:
1. **herdr exposes a test-mode API** for kill-by-pid capture → write
   the integrate test.
2. **A second tmux provider** is added (or `pane.process_info` becomes
   standard) → cross-surface parity test becomes meaningful.
3. **The 3 heartbeat sources** ever diverge in production observations
   → escalate to a real bug, not a parity-test failure.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M7 / WI-7.4
- Heartbeat sources:
  - task.heartbeat: src/runtime/heartbeat/worker-heartbeat.ts
  - heartbeat.json file: src/runtime/recovery/crash-recovery.ts:432
  - metric: src/observability/event-to-metric.ts:58 + heartbeat-aggregator.ts:74
- herdr provider: src/runtime/surface/herdr-provider.ts:24-26 (A2 TODO)
