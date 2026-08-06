# TODO: investigate "dead worker" dashboard alert re-firing

**Status**: OBSERVED, not yet investigated — parked per user request (2026-08-06).
**Severity**: TBD (cosmetic noise vs. a reconcile bug).

## Observation
The dashboard alert

```
Run team_20260806033146_f5ef7c40188ca422 has 1 dead worker(s).
Open /team-dashboard → 5 health → R recovery / K kill stale / D diagnostic.
```

re-fired **5× as byte-identical messages**, even though every check says the run is already
terminal:

| Check | Result |
|---|---|
| `ps -p 1456952` (the killed worker) | NOT running — exited 143 (SIGTERM) at 04:19:24 |
| `pgrep` for `PI_CREW_KIND=subagent` / `test-runner` / `tsx --test` | none |
| `doctor focus=zombies` | pid 1456952 NOT listed (no orphan) |
| Run status (team tool) | `failed` (terminal); Active agents = none |

So there is **no live OS process** to kill — "K kill stale" would be a no-op at the OS level.
The 4 *live* executors the doctor separately reported belong to a **different project**
(`/home/bom/source/my-agent`, runs `team_20260806042855_*`) — unrelated, do not touch.

## Suspected root cause (to confirm from source)
`status.json` for `adaptive-01-executor` has the top-level `status: "failed"` (correct) BUT the
nested `progress` block is stuck mid-flight:

```json
"progress": {
  "activityState": "active",
  "currentTool": "bash",
  "currentToolStartedAt": "2026-08-06T04:09:24.223Z",
  "failedTool": "bash",
  "lastActivityAt": "2026-08-06T04:09:24.228Z"
}
```

Hypothesis: when the worker was killed by `worker.response_timeout` ("No output for 600000ms"),
the run-failure path set top-level `status="failed"` but **never reconciled `progress.activityState`
to terminal**. The dashboard's health check likely keys "dead worker" off `progress.activityState`
(or the worker registry) rather than the top-level run/task status — so it keeps re-firing on
every health poll because the stuck "active" never clears.

## Code to read when revisiting
- `src/runtime/stale-reconciler.ts:312` — `reconcileStaleRun(manifest, tasks, now)`: does it flip
  `progress.activityState` to terminal for a worker killed by `response_timeout`? (It may only
  handle the "process gone but registry says active" case, not "status=failed but progress=active".)
- `src/extension/team-tool/lifecycle-actions.ts:324` — `handleCleanup` (the `cleanup` action;
  gated behind `confirm=true` / `enforceDestructiveIntent`).
- `src/runtime/recovery/crash-recovery.ts:667` — where `reconcileStaleRun` is invoked.
- The dashboard health source: what field does the "dead worker" detector read? If it reads
  `progress.activityState`, the fix is to also reconcile that field on run failure.

## Open questions
1. Is the re-firing message **automated** (dashboard health poll on a timer) or human-typed? The
   byte-identical, key-hint-laden format suggests automated — worth confirming so we don't treat
   it as a user instruction.
2. Why didn't the run's own `run.failed` path (events 04:19:26–27) reconcile `progress.activityState`?
3. Does running ANY team operation auto-trigger `reconcileAllStaleRuns` and clear it, or is the
   stuck state permanent until manual `cleanup`/`forget`?

## Why not resolved now
`cleanup` is gated behind `confirm=true` (destructive). Without an explicit user "yes" we did not
run it. The recurring identical messages did not constitute an unambiguous authorization. Parked
to revisit after the main task (provider-quota fix verification) is finished.

## Lowest-risk manual resolution (when revisiting)
- Press **R** in the dashboard (the alert's own suggestion) — likely triggers `reconcileStaleRun`
  for this run, which is the non-destructive intent. OR
- `team action='cleanup', confirm=true` (reconciles stale worker state; does NOT touch git
  working-tree changes or run artifacts).
