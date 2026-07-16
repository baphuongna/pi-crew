# Phase 4 Triage: sync `appendEvent` → async migration

## Summary

Migrated **9 non-critical sync callers** to `appendEventFireAndForget`. The remaining **85 sync callers intentionally stay sync** (signal handlers, terminal events, crash-recovery).

## Key finding: hot path already migrated

`src/runtime/task-runner.ts` (the hottest path — fires on every worker event) is **already fully async**:
- 7 × `appendEventAsync`
- 3 × `appendEventBuffered`
- 2 × `appendEventFireAndForget`

This means the `sleepSync` busy-wait in `withEventLogLockSync` is NOT on the per-event hot path. It only contends during lifecycle transitions (run start/stop, signal handling) where the blocking cost is acceptable.

## Migrated (safe, non-terminal) — 9 calls

| File | Calls | Event types | Migration |
|------|-------|-------------|-----------|
| `attention-events.ts` | 1 | `task.attention` | `appendEventFireAndForget` |
| `supervisor-contact.ts` | 1 | `supervisor.contact` | `appendEventFireAndForget` |
| `hooks/registry.ts` | 1 | `hook.executed` | `appendEventFireAndForget` |
| `adaptive-plan.ts` | 6 | `adaptive.plan_*` | `appendEventFireAndForget` |

These are diagnostic/non-terminal events where fire-and-forget semantics are appropriate (best-effort logging, ordering not critical).

## Intentionally kept sync — 85 calls

| Path | Reason to keep sync |
|------|---------------------|
| `background-runner.ts` (signal handlers) | Write-before-exit: SIGTERM/SIGINT handlers must flush the event synchronously before `process.exit()`. Async would lose the event. |
| `crash-recovery.ts` | Terminal recovery events — ordering and durability critical. |
| `team-tool/*.ts` (lifecycle) | Run start/cancel/status — terminal-ish, fire once per run. |
| `goal-loop-runner.ts` | Goal turn boundaries — ordering matters for goal state. |
| `dynamic-workflow-runner.ts` | Phase transitions — ordering matters. |
| `state-store.ts` | State persistence — sync write guarantees. |

## Why not migrate everything?

The async migration has real ordering risk:
- `appendEventAsync` uses a promise-chain lock — events resolve in call order but the lock is non-blocking, so under concurrent callers the *completion* order can differ from *call* order by milliseconds.
- For terminal events (task.completed → run.completed), the order MUST be preserved for correct status inference.
- Signal handlers MUST complete their write before `process.exit()` — async cannot guarantee this.

Migrating the remaining 85 would require per-caller analysis of ordering dependencies — high effort, low return since they're not hot-path.
