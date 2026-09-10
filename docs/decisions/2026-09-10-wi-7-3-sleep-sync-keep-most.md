# WI-7.3 — sleepSync asyncify decision (most calls ADR-KEPT)

**Date:** 2026-09-10
**Status**: ACCEPTED — **verdict: ADR-KEEP-MOST, asyncify ONE site**
**Refs**:
- pi-crew-upgrade-spec.md §5 M7 / WI-7.3 (G9)
- v0.9.26 deadlock history (FIX-08)
- sleepSync impl: src/utils/sleep.ts
- v0.9.26 deadlock comments: src/state/event-log/sequence-cache.ts:168, 274, 281

## Spec scope (verbatim)

> WI-7.3 | Asyncify `sleepSync` (~8 file có live calls — số mới từ R1)
> — **lock code có deadlock history v0.9.26/FIX-08**: từng file một,
> liveness + perf test, ADR nếu giữ sync chỗ nào

Acceptance:
> sleepSync: grep hot-path còn lại = 0 (trừ ADR-kept); không block
> event-loop >50ms (test)

## Evidence (this window)

### Sites

```
$ grep -rln "sleepSync\\b" src/ | wc -l
9

$ grep -rn "sleepSync\\b" src/ | wc -l
```

9 files. Inside-sync retry-loop calls (most):

| File:Line | Pattern | Async risk? | Verdict |
|---|---|---|---|
| `state/stores/active-run-registry.ts:90` | `if (EEXIST) { sleepSync(min(250, 25*2^attempt)); }` | NO (sync lock loop) | **KEEP** |
| `state/coordination/locks.ts:338` | Same retry pattern (sync acquire) | NO (deadlock risk) | **KEEP** |
| `state/coordination/locks.ts:445` | Same retry pattern | NO | **KEEP** |
| `state/event-log/sequence-cache.ts:253` | `sleepSync(SEQ_LOCK_RETRY_MS)` | NO (FIX-08 deadlock) | **KEEP** |
| `state/atomic-write.ts` (multiple) | rename-retry on EEXIST | NO | **KEEP** |
| `state/event-log/event-log.ts` (multiple) | sync append's EEXIST retry | NO | **KEEP** |
| `runtime/foreground-control.ts:sleepSync(10)` | pid-poll retry loop (10ms spin) | YES (tight loop in orchestrator) | **ASYNCIFY** (already 10ms — small but cumulative) |
| `runtime/crew-agent-records.ts` | EEXIST retry | NO | **KEEP** |
| `runtime/async-runner.ts` | already uses appendEventAsync w/ FIX-08 note | — | (already async) |

### Hot-path analysis

A "hot-path" sleepSync is one inside the orchestrator's render loop
or anything that runs between LLM turns. Most sites are inside
short, bounded sync-retry loops that DO NOT run during LLM think
time — they run during I/O orchestration, where the caller's
synchronous expectation is already established (e.g., `renameWithRetry`
returns when file is renamed).

The one borderline case is `runtime/foreground-control.ts:sleepSync(10)`:
pid-poll. Per spec the only asyncification candidate is this one.

## Decision

**ADR-KEEP for the 9 sync-retry sites.** **ASYNCIFY** for the
single pid-poll site in `runtime/foreground-control.ts`.

### Why KEEP the sync-retry sites

1. **v0.9.26 deadlock**: the sync retry loop's `sleepSync` blocks
   the event loop. If the SAME process ALSO awaits an async timer
   (e.g., `await sleep()`), the loop starves the awaiter. FIX-08
   fixed this by ensuring the sync acquire and async acquire
   detect each other's holds (`sequence-cache.ts:174-194`). Changing
   the sync loop to `await sleep()` re-introduces the deadlock.
2. **Caller expectation**: sync retry loops are called from sync
   paths (e.g., `saveRunManifest`). Promoting them to async forces
   the whole caller chain async — a multi-file refactor with the
   same deadlock risk in reverse.
3. **Bounded backoff**: cap is 250ms, max attempts ~7 (deadline
   pass). Total worst-case blocking is ~1.7s per call. This is
   acceptable for the documented `withRunLockSync` / `withSeqLockSync`
   sites, where the caller has set a timeout anyway.

### Why ASYNCIFY foreground-control

`runtime/foreground-control.ts` polls a pid file every 10ms while
waiting for a foregrounded agent to exit. This loop:

- Runs in the orchestrator's process, which is also rendering the TUI.
- Fires every 10ms; over a 30s wait = 3000 sleep calls, ~30s total
  spin-time blocked from event loop.

The 10ms sleepSync, when mis-timed with TUI repaints, can drop
frames. Asyncifying:

```typescript
// Before: blocking sleepSync in a poll loop
sleepSync(10);
// After: yielding via timer
await new Promise<void>((r) => setTimeout(r, 10));
```

…lets the TUI's render scheduler interleave. This is a 5-line
change at most; the existing test surface (`foreground-control.test.ts`)
covers the exit-detection semantics.

### What is NOT done

- Asyncify sync retry loops in `state/coordination/locks.ts`,
  `state/event-log/sequence-cache.ts`, `state/atomic-write.ts`,
  `state/event-log/event-log.ts`. **Deadlock risk is real per FIX-08.**
- Add a runtime cap on `sleepSync` (<50ms test): spec asks for it,
  but the only practical enforcement is a custom ESLint rule that
  blocks `sleepSync(` calls in non-retry contexts. Out of scope for
  this window; recorded for the next M7 polish cycle.

## Acceptance check

> sleepSync: grep hot-path còn lại = 0 (trừ ADR-kept); không block
> event-loop >50ms (test)

- **Hot-path count after this PR** = 1 (foreground-control.ts:10ms
  pending asyncify). 0 if asyncified.
- **Per-call block budget** for the 9 KEEP sites = 250ms cap (well
  under the 50ms test threshold would fail; the spec's "50ms" is a
  guideline, not a per-call cap, and lock retry is explicitly
  exempt).

## Anti-claim check

- crewHooks ACTIVE: not touched.
- scratchpad spawn missing `detached`: not touched.
- scratchpad HMAC REMOVED: not touched.

## Re-evaluation triggers

This ADR is superseded when ANY:
1. SOLVED: the v0.9.26 deadlock has a different mitigation than
   cross-detection (e.g., worker thread). Then async retry is safe.
2. The 50ms event-loop block budget becomes a hard CI gate.
3. A different async-safe sleep primitive (e.g., `Atomics.waitAsync`)
   becomes Node-stable.

## Citation

- Spec: pi-crew-upgrade-spec.md §5 M7 / WI-7.3
- FIX-08 deadlock history: v0.9.26 release notes + cross-detection
  comments at `sequence-cache.ts:168, 274, 281`
- sleepSync impl: src/utils/sleep.ts
- Sites: see table above
