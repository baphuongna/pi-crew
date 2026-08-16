# Bug Report: lazy-agent-materialization test is skipped (foreground-run timing)

**Date:** 2026-08-10
**Severity:** Low–Medium (documented behavior with zero coverage; no runtime bug observed)
**Status:** Open — root cause documented in the skip comment; fix not yet implemented
**Affects:** `test/unit/runtime/core/lazy-agent-materialization.test.ts:17` (skipped test)
**Blocks:** nothing immediately; the "lazy materialization" feature is documented but unverified

---

## Summary

The `queued dependency tasks are shown as waiting tasks, not materialized agents` test is silently skipped via `test.skip(...)` with a detailed inline comment but no bug ticket. The skip comment names a real architectural mismatch:

> The test checks that agents aren't materialized before `scheduled()` is called, but in practice `handleTeamTool` waits for run completion via `waitForRun()`, which means by the time it returns, all tasks have already completed and agents are materialized. This is a known limitation of the foreground run architecture.

So the "lazy materialization" property (queued dep tasks should appear as *waiting tasks*, not as *materialized agents*) cannot be exercised through the standard `handleTeamTool` entry point because that entry point blocks until completion.

## Affected property

The lazy-materialization concept: when task A depends on task B, and B is queued (not yet running), the dashboard should show B as a *waiting task* — NOT prematurely materialize an agent for B. This is a UX property of the scheduler dashboard. Without this test, any change that eagerly materializes agents for queued tasks ships silently.

## Suggested fix

The test scaffolding already exists in the file (it calls `startForegroundRun` + `scheduled()`). The fix is to use the lower-level `startForegroundRun` API (which returns immediately) instead of `handleTeamTool` (which awaits completion):

1. Replace `await handleTeamTool(...)` with `const handle = startForegroundRun(...)`.
2. Snapshot the dashboard state (call `readCrewAgents(manifest)`) while the run is in flight.
3. Assert that agents for queued dep tasks are NOT materialized at snapshot time.
4. Then `await handle.completion` to let the run finish and tear down.

This matches the pattern used by `test/integration/async-restart-recovery.test.ts` (which exercises the async path the same way).

## References

- `test/unit/runtime/core/lazy-agent-materialization.test.ts:17-65` — the skipped test
- `src/runtime/foreground-control.ts` — `startForegroundRun` (the non-blocking entry point)
- `src/runtime/crew-agent-records.ts` — `readCrewAgents` (the snapshot reader)
- `improvement-plan-2026-08-09.md` D.1 — the convention this bug file matches
