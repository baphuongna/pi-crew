# Phase 4 Triage: sync `appendEvent` → async migration

## Summary

Migrated **4 non-terminal diagnostic calls** to `appendEventFireAndForget` and **1 audit-critical call** to `await appendEventAsync`. All other sync callers remain sync. Three review rounds caught and fixed real production bugs during this phase.

## Key finding: hot path already migrated

`src/runtime/task-runner.ts` (the hottest path — fires on every worker event) is **already fully async**. Verified: **zero** sync `appendEvent` calls in task-runner.ts. Event writes use:
- 6 × `appendEventAsync` (lines 213, 503, 621, 916, 1013, 1237)
- 1 × `appendEventBuffered` (line 430)
- 1 × `appendEventFireAndForget` (line 282)

This means the `sleepSync` busy-wait in `withEventLogLockSync` is NOT on the per-event hot path. It only contends during lifecycle transitions (run start/stop, signal handling) where the blocking cost is acceptable.

## Final migration — 5 calls in 1 file

Only `adaptive-plan.ts` was migrated (partially):

| Call | Event type | Method | Rationale |
|------|-----------|--------|-----------|
| Line 398 | `adaptive.plan_missing` | `appendEventFireAndForget` | Diagnostic — safe |
| Line 417 | `adaptive.plan_missing` | `appendEventFireAndForget` | Diagnostic — safe |
| Line 450 | `adaptive.plan_repaired` | `appendEventFireAndForget` | Diagnostic — safe |
| Line 458 | `adaptive.plan_repaired` | `appendEventFireAndForget` | Diagnostic — safe |
| Line 465 | `adaptive.plan_repair_failed` | `appendEventFireAndForget` | Diagnostic — safe |
| Line 534 | `adaptive.plan_injected` | `await appendEventAsync` | **Audit-critical** — team-runner reads tasks immediately after. Upgraded to awaited async to prevent ordering inversion. |

## Reverted after review (test regressions + error context loss)

| File | Calls | Why reverted |
|------|-------|-------------|
| `attention-events.ts` | 1 | Dedup regression: sync `readEvents` for dedup + async write = rapid calls bypass dedup (Round 2 MEDIUM-1) |
| `supervisor-contact.ts` | 1 | Test regression: `recordSupervisorContact` called from sync `onStdoutLine` callback; event not on disk when consumer reads (Round 1 HIGH #1). Also dead `try/catch` losing runId/taskId error context (Round 3 HIGH-1). |
| `hooks/registry.ts` | 1 | Test regression: 3 tests fail because `appendHookEvent` is followed by sync `readEvents` (Round 1 HIGH #2). Also ordering inversion risk with subsequent sync events in crash-recovery.ts (Round 1 MEDIUM #1). |

## Intentionally kept sync — 86 calls (unchanged from original 94)

| Path | Reason to keep sync |
|------|---------------------|
| `background-runner.ts` (11) | Separate child process; terminal/crash events (`async.failed`, `async.completed`, `unhandledRejection` guard) must be on disk before exit. |
| `crash-recovery.ts` (4) | Terminal recovery events — ordering and durability critical. |
| `team-tool/*.ts` (lifecycle) | Run start/cancel/status — terminal-ish, fire once per run. |
| `goal-loop-runner.ts` (12) | Goal turn boundaries — ordering matters for goal state. |
| `dynamic-workflow-runner.ts` (5) | Phase transitions — ordering matters. |
| `state-store.ts` (2) | State persistence — sync write guarantees. |

## Real ordering risk: sync-vs-async lock divergence

The sync and async event-write paths use **different lock mechanisms**:
- **Sync** `appendEvent` → `withEventLogLockSync` → filesystem directory lock + `sleepSync`
- **Async** `appendEventAsync` / `appendEventFireAndForget` → in-process promise chain → no filesystem lock

These do not coordinate. A fire-and-forget call yields to the event loop before its I/O starts, while a subsequent sync `appendEvent` acquires the file lock and writes immediately. The sync event can land on disk **before** the earlier fire-and-forget event — a true ordering inversion (acknowledged in `event-log.ts` comment "EL-1: the sidecar can regress via sync/async interleave").

## Why not migrate everything?

Migrating the remaining 86 would require per-caller analysis of ordering dependencies and consumers that read events immediately after. The three review rounds found that even seemingly safe migrations (supervisor-contact, hooks/registry) caused test regressions because downstream consumers read events synchronously. High effort, low return since they're not hot-path and the sync/async mixing risk is already accepted in the codebase.
