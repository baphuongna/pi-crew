# TODO: investigate "dead worker" dashboard alert re-firing

**Status**: FIXED 2026-08-06 — root cause confirmed; fix implemented (see "## Fix implemented").
**Severity**: LOW–MEDIUM (cosmetic noise + minor trust erosion; no data/correctness impact — the run is already terminal and the OS process is gone).

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

## Confirmed root cause (traced from source)

The alert is **heartbeat-based**, NOT `progress.activityState`-based (the stuck `progress.activityState`
in the per-agent `status.json` is a separate, purely-cosmetic staleness — it is NOT what feeds the alert).

**Emit site**: `src/extension/registration/lifecycle-handlers.ts:706` —
`maybeNotifyHealth("recovery_dead_workers", summary.dead, ...)`, called inside `renderTick`'s
health-notification loop (~`:663-712`).

**Gate** (the loop only acts on a run when BOTH hold):
```js
for (const run of sessionManifests) {
    if (run.status !== "running") continue;                    // GATE 1: run-level
    const snapshot = snapshotCache.get(run.runId);
    if (!snapshot || snapshot.manifest.status !== "running") continue;  // GATE 2: snapshot
    const summary = summarizeHeartbeats(snapshot, { now });
    maybeNotifyHealth("recovery_dead_workers", summary.dead, ...);   // fires iff summary.dead > 0
}
```

**`summary.dead`** comes from `summarizeHeartbeats` (`src/ui/heartbeat-aggregator.ts:34`): it counts a
task as dead iff `isActiveTask(task)` — i.e. `task.status === "running"` — AND its heartbeat is
missing or older than `deadMs` (default **5 min**).

**On-disk state for the failing run is CORRECT and terminal**: `manifest.json` run status = `failed`;
`tasks.json` `adaptive-01-executor` status = `failed`, `heartbeat.alive = false` (lastSeen
04:19:24.447, the kill time). So a FRESH read yields `summary.dead = 0` and GATE 1 blocks → no alert.

**Why it still fires / re-fires**:
1. **Stale snapshot cache (primary).** `renderTick` gates on `snapshotCache.get(run.runId)` and
   `snapshot.manifest.status`. The snapshot cache is invalidated only on explicit
   `invalidate(runId)` calls (`commands.ts:444,453`) — it is **NOT auto-invalidated when a run's
   manifest transitions to terminal**. So a snapshot captured while the run was `running` keeps a
   task at `status:"running"`; once the killed worker's heartbeat ages past 5 min, that stale
   snapshot reads as `summary.dead = 1`. The manifest cache itself has a 500 ms TTL + file watcher,
   but the loop consumes `lastPreloadedManifests`, which can lag the on-disk `failed` transition
   long enough for GATE 1+2 to pass during a render tick.
2. **No terminal clear (secondary / stickiness).** There is **no dismiss/clear path** for health
   notifications. `grep` for `dismissOperator`/`clearNotification` returns nothing. Once emitted,
   the notification `id = recovery_dead_workers_<runId>` is deduped only by time: `autoRecoveryLast`
   (5 min, `lifecycle-handlers.ts`) on top of `NotificationRouter` dedup (30 s,
   `notification-router.ts:enqueue`). So while the run reads as running+dead, the alert re-delivers
   **every 5 min**; and a single delivered notification can be re-surfaced by the dashboard until
   the user manually acts (R/K/D).

Net: a run killed by `worker.response_timeout` has a heartbeat that goes permanently stale; the
health loop keeps re-classifying it as a dead worker (via the stale snapshot) and re-emitting the
alert (every 5 min), because nothing reconciles/clears it once the run is terminal.

## Recommended fix (scoped, not yet implemented)

Two complementary changes; either alone helps, both together are robust:

1. **[PRIMARY] Invalidate the snapshot cache on terminal transition.** In `renderTick`'s health
   loop (or in the snapshot cache itself), drop/skip a `snapshotCache` entry whose manifest status
   is no longer `running`. Concretely, change GATE 2 to `if (!snapshot || snapshot.manifest.status
   !== "running") { continue; }` — it already reads `snapshot.manifest.status`, so just make sure a
   terminal manifest is never paired with a stale-running snapshot. More robust: when
   `snapshot.manifest.status !== "running"`, call `snapshotCache.invalidate(run.runId)` so the stale
   entry is purged and subsequent ticks get a fresh (empty/terminal) snapshot → `continue`.
2. **[SECONDARY] Clear health notifications on terminal.** Add a dismiss path: when the loop sees a
   run is now terminal (`run.status !== "running"`), emit a clear for previously-sent ids
   `recovery_dead_workers_<runId>` / `recovery_missing_heartbeat_<runId>`. Requires extending
   `NotificationRouter`/`notifyOperator` with a clear sentinel (e.g. `NotificationDescriptor.clear?:
   boolean`) — small additive change.

Defense-in-depth (optional): `summarizeHeartbeats` could accept a run-status hint and skip
dead-counting for terminal runs, but the gate already covers this if the snapshot is fresh.

## Fix implemented

Commit: `__COMMIT__` (placeholder — committer fills the hash).

Both complementary changes were implemented; together they make the invariant hold: **a terminal run
(failed / completed / cancelled) on disk never produces or re-fires a `recovery_dead_workers` /
`recovery_missing_heartbeat` health notification, regardless of in-memory cache staleness.**

### Fix #1 — fresh-manifest re-verify gate (PRIMARY)

File: `src/extension/registration/lifecycle-handlers.ts`, health loop inside `renderTick`.

After GATE 1 (`run.status !== "running"`), the loop now re-verifies each run against a **FRESH**
manifest-cache read: `ctx.getManifestCache(extensionCtx.cwd).get(run.runId)`. The manifest cache has
a 500 ms TTL + file watcher, so it is the source of truth, whereas the preloaded `run` (from
`lastPreloadedManifests`) can lag the on-disk terminal transition.

- If the fresh manifest is absent or its status is **not** `running` (i.e. terminal), the loop:
  1. calls `snapshotCache.invalidate(run.runId)` to purge the stale snapshot, and
  2. calls `clearHealthNotifications(run.runId)` (Fix #2), then
  3. `continue`s — it never reaches `maybeNotifyHealth`.
- GATE 2 (`snapshot.manifest.status !== "running"`) also now invalidates the stale snapshot and clears
  before continuing, so a running-snapshot paired with a now-terminal manifest is purged.

Net: a terminal run never reaches `maybeNotifyHealth`, and its stale snapshot is purged so subsequent
ticks also skip.

### Fix #2 — notification clear path (SECONDARY)

- `src/extension/notification-router.ts`: `NotificationDescriptor` gained an optional `clear?: boolean`.
  In `enqueue`, a clear is handled **before** the severity/quiet-hours/dedup logic: it removes the id
  from `seen` (so a future genuine re-occurrence can re-notify), invokes the sink, delivers, and
  returns `true` — bypassing the severity filter, quiet hours, and dedup (a clear must always go
  through so the dashboard can drop the previously-emitted notification).
- `src/extension/registration/lifecycle.ts`: the `deliver` callback passed to `NotificationRouter`
  is now clear-aware — for a `clear` notification it **decrements** `notificationCount` (floor 0) and
  **skips** `sendFollowUp` (a dismissal is not a new alert); the shared widget refresh still runs.
- `clearHealthNotifications(runId)` (defined in `renderTick`): for each of
  `recovery_dead_workers` / `recovery_missing_heartbeat`, it deletes the `autoRecoveryLast` cooldown
  entry AND emits a clear via `ctx.notifyOperator`, so the dashboard drops the alert and a future
genuine re-occurrence is not artificially throttled.

### Files changed

- `src/extension/notification-router.ts` — `clear?: boolean` on `NotificationDescriptor`; clear path in `enqueue`.
- `src/extension/registration/lifecycle-handlers.ts` — fresh-manifest re-verify gate, snapshot invalidation on terminal, `clearHealthNotifications` helper.
- `src/extension/registration/lifecycle.ts` — clear-aware deliver callback (decrement count, skip follow-up).
- `test/unit/extension/core/notification-router.test.ts` — clear-removes-seen + clear-bypasses-filter tests.
- `test/unit/runtime/heartbeat/heartbeat-aggregator.test.ts` — regression guard: running task with >5min stale heartbeat is still dead.

### Non-regression guarantee

A genuinely RUNNING run with a stale worker still alerts — the fresh-read gate only blocks when the
fresh status is **not** `running`, and `summarizeHeartbeats` is unchanged (pinned by the new
regression test).

## Notes superseded by the investigation
- The earlier "read `reconcileStaleRun` / `progress.activityState`" hunch was **wrong**: the alert
  is heartbeat-based (`summarizeHeartbeats`), not `progress.activityState`-based. The stuck
  `progress.activityState` in `agents/<taskId>/status.json` is a separate cosmetic staleness (the
  run-failure path doesn't reconcile the nested `progress` block) — worth a separate minor fix but
  NOT the cause of the alert.
- Open question (automated vs human-typed) is **moot**: the messages are fresh re-deliveries every
  ≤5 min from `renderTick` while the stale snapshot reads running+dead, plus dashboard re-surfacing.

## Code to read when revisiting
- `src/extension/notification-router.ts:enqueue` — dedup (`seen` Map, 30 s default) + deliver; no
  TTL/clear (only size-eviction at 10 000). This is why the alert has no self-heal.
- `src/ui/run-snapshot-cache.ts` — `createRunSnapshotCache` + `invalidate(runId)`; confirm it has no
  auto-invalidation on terminal manifest status (the gap behind Fix #1).
- `src/runtime/manifest-cache.ts` — 500 ms TTL + file watcher; the *manifest* cache is fresh, the
  *snapshot* cache is the stale one.

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
