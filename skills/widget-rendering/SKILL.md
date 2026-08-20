---
name: widget-rendering
description: "Pi TUI crew widget data sources, display priority, and rendering performance."
origin: pi-crew
triggers:
  - "empty agent"
  - "ghost run"
  - "widget timing"
  - "display priority"
  - "snapshot cache"
  - "widget render"
  - "UI refresh"

---
# widget-rendering

The crew widget (`src/ui/crew-widget.ts`) displays active runs and their agents in the Pi TUI. It must render synchronously at TTY refresh rate without blocking. Understanding the data sources and timing rules is essential for debugging display issues.

## Three Data Sources

The widget has three sources, used in priority order:

### 1. `liveAgents` Map (real-time, highest priority)

In-memory map from `live-agent-manager.ts`. Provides:
- Real-time tool names: `activeTools` Map (toolName → description)
- Turn count, response text, compaction count
- Session stats: context %, token usage
- Status from the handle

**When used:** Agents with `liveHandle && liveHandle.status === "running"` get the live activity description (tool labels, response text, turn counter).

**When NOT used:** After `evictStaleLiveAgentHandles()` removes a handle, widget falls back to agent records on disk.

### 2. Snapshot cache (1500ms TTL)

`RunSnapshotCache` from `run-snapshot-cache.ts` caches parsed manifests and agents for 1500ms. Reduces disk reads during rapid refresh.

**When used:** As the fallback when no live handle exists. Prevents excessive disk reads on every render tick.

**Invalidation:** Cache is invalidated when:
- `invalidate()` is called on a specific run
- An empty result is returned (forces refresh on next tick)
- TTL expires (1500ms)

### 3. `agents.json` on disk (durables, lowest priority)

`readCrewAgents(run)` reads `artifactsRoot/agents.json`. Provides:
- Final agent status (completed/failed/cancelled)
- Tool count, token usage from final record
- Error messages
- Timestamps (startedAt, completedAt)

**When used:** For completed agents, or when snapshot cache misses.

## Display Priority

```
for each active run:
  for each agent in run:
    if liveAgents has this agent (by agentId or taskId):
      → use live activity description (tool labels, response text)
      → use live status (running/queued/waiting)
      → use live session stats (context %, turns, tokens)
    else if snapshot cache has fresh data:
      → use cached agent status
      → use cached tool count, tokens, progress
    else:
      → read agents.json from disk
      → use disk agent status

    if status is completed/failed/cancelled:
      → apply linger rules (finishedAgents: 1min, errors: 2min)
```

## Active Runs Filtering

`activeWidgetRuns()` determines which runs to show. Key filter: `isDisplayActiveRun(manifest, tasks)` from `process-status.ts`.

**Rule: `hasStaleAsyncProcess()`**

A run with an async PID is considered stale (hidden) if:
1. PID is recorded but process is dead, AND
2. The run is more than 30 minutes old (`STALE_ACTIVE_RUN_MS = 30 * 60 * 1000`)

**Rule: `isDisplayActiveRun()`**

```typescript
export function isDisplayActiveRun(manifest: TeamRunManifest, tasks: TeamTaskState[]): boolean {
  if (manifest.status === "running" || manifest.status === "waiting") {
    if (manifest.async?.pid) {
      if (hasStaleAsyncProcess(manifest.async.pid, manifest.updatedAt)) return false;
    }
    const hasActiveTask = tasks.some((t) => t.status === "running" || t.status === "queued" || t.status === "waiting");
    if (!hasActiveTask) return false;
    return true;
  }
  return false;
}
```

This filters out ghost runs (PID dead, manifest still "running") that are more than 30 minutes old.

---

## Stale Handle Eviction

**On every widget refresh**, `evictStaleLiveAgentHandles()` is called at the start of `activeWidgetRuns()`:

```typescript
export function activeWidgetRuns(...): WidgetRun[] {
  evictStaleLiveAgentHandles(); // prevent memory leaks
  const runs = preloadedManifests ?? ...;
  // ...
}
```

**Eviction rule:** Remove handles where:
- Status is terminal (not running/queued/waiting), AND
- `updatedAt` is more than 10 minutes ago

```typescript
const STALE_HANDLE_MS = 10 * 60 * 1000;
if (handle.status !== "running" && handle.status !== "queued" && handle.status !== "waiting") {
  const age = now - new Date(handle.updatedAt).getTime();
  if (age > STALE_HANDLE_MS) {
    liveAgents.delete(agentId);
    safeDisposeLiveSession(handle);
  }
}
```

**Why called on every refresh:** Ensures the in-memory Map stays bounded even during long Pi sessions. Completed agents linger for 10 minutes (for visibility), then get evicted.

---

## Frame Timing Rules

### `renderTick()` must be non-blocking

Every render cycle (`renderTick` / `requestAnimationFrame`) must complete in <16ms to maintain 60fps. The widget must not:
- Call `fs.readFileSync` on hot paths
- Call `loadConfig()` during render
- Scan directories (`readdirSync`)
- Make network calls

**Solution:** Preload everything async before the first render.

### Widget refresh intervals

| Scenario | Interval |
|---|---|
| Live agents running | 160ms (`LIVE_REFRESH_MS`) |
| No live agents, recent activity | 2s |
| Idle | 10s |

### TTL interactions

- Snapshot cache TTL = 1500ms
- Preload interval must be < TTL to avoid render-time gaps
- If preload interval ≥ TTL, the cache always has fresh data for render

---

## Agent Activity Description

`agentActivity(agent, liveHandle?)` generates the activity string shown in the widget:

```typescript
function agentActivity(agent: CrewAgentRecord, liveHandle?: LiveAgentHandle): string {
  if (liveHandle && liveHandle.status === "running") {
    const live = describeLiveActivity(liveHandle);
    // Prefer richer agent.progress data if live is just the fallback
    if (live === "thinking…" && agent.progress?.currentTool)
      return `${TOOL_LABELS[agent.progress.currentTool] ?? agent.progress.currentTool}…`;
    return live;
  }
  // Fallback chain from agent records
  if (agent.progress?.currentTool) return `${TOOL_LABELS[agent.progress.currentTool]}…`;
  if (recent output) return lastOutput line;
  if (activityState === "needs_attention") return "needs attention";
  if (status === "queued") return "queued";
  if (status === "running") {
    if (age < 5s && no tool) return "spawning…";
    return "thinking…";
  }
  if (status === "failed") return agent.error ?? "failed";
  return "done";
}
```

**Tool name extraction:** `TOOL_LABELS` maps tool names to readable labels:
```typescript
const TOOL_LABELS = {
  read: "reading",
  bash: "running command",
  edit: "editing",
  write: "writing",
  grep: "searching",
  find: "finding files",
  ls: "listing",
};
```

---

## Ghost Run Display Bug Patterns

### Bug: Agent shows "running" in widget but process is dead

**Root cause:** `agents.json` still has status "running" while the actual PID is dead.

**Fix path:** `reconcileAllStaleRuns` now calls `upsertCrewAgent` when repairing tasks, syncing agent status files. Also `purgeStaleActiveRunIndex` and `cancelOrphanedRuns` now sync agent records.

### Bug: Widget shows empty agent (no name, no status)

**Root cause:** `agentActivity` fallback chain returned `"done"` with no name. The agent description construction had fallbacks to empty strings.

**Fix applied:** `agentActivity` now uses `handle.agent ?? handle.role ?? agent.agent ?? agent.role ?? "Agent"` as the description base. Plus `(running)` suffix uses `handle.status` not `agent.status`.

### Bug: Ghost runs appear after Pi restart

**Root cause:** `active-run-index.json` is missing on restart, so `purgeStaleActiveRunIndex()` doesn't know about orphaned runs. `reconcileAllStaleRuns` (disk scan) was never called.

**Fix applied:** `reconcileAllStaleRuns` is now called at session start in `register.ts`.

### Bug: "worker blinks" — agent appears and disappears in 1 frame

**Root cause:** Worker spawns and crashes in <1 frame. Structured logs (`worker.spawned` + rapid `worker.exit`) expose the crash cause.

**Fix:** Event log tracing skill documents this pattern.

---

## Enforcement — Widget Rendering Gate

**Before modifying widget rendering or display logic, verify:**

- [ ] Render path is synchronous and non-blocking (no fs/network calls)
- [ ] Display priority chain correct (liveAgents → snapshot cache → agents.json)
- [ ] Ghost run filtering works (stale async PID + age > 30min hidden)
- [ ] Stale handle eviction runs on every refresh (10min terminal handles removed)
- [ ] Cache invalidation handles empty results (forces refresh on next tick)
- [ ] Tool name extraction uses TOOL_LABELS for readable activity descriptions

If ANY answer is NO → Stop. Fix widget rendering issues before proceeding.

## Anti-patterns

- **Blocking render with fs calls**: Every `readFileSync`, `readdirSync`, `fs.statSync` in the render path causes frame drops. Preload everything async.
- **Stale cache in hot path**: If snapshot cache TTL is too long, widget shows outdated state. Keep TTL at 1500ms or less (the code default; lower only with cause).
- **No invalidation on empty**: When `readCrewAgents` returns `[]` (no agents yet), the cache must be invalidated on next tick to prevent showing empty for too long.
- **Expired handles accumulating**: Without `evictStaleLiveAgentHandles`, the Map grows indefinitely. Call it on every refresh.
- **Widget showing stale health warnings**: Completed/cancelled/failed runs should not show health warnings. Filter by status.

---

## Source patterns

- `src/ui/crew-widget.ts` — render, refresh, activeWidgetRuns, evictStaleLiveAgentHandles, agentActivity, describeLiveActivity
- `src/ui/run-snapshot-cache.ts` — SnapshotCache, get, refreshIfStale, TTL=1500ms
- `src/runtime/crew-agent-records.ts` — readCrewAgents, agents.json
- `src/runtime/process-status.ts` — hasStaleAsyncProcess, isDisplayActiveRun
- `src/runtime/background-runner.ts` — active run filtering with async PID check
- `src/state/active-run-registry.ts` — purgeStaleActiveRunIndex

---

## Render Performance Rules

Render-path performance for the widget is non-negotiable. Treat every `render(width)`, widget update, and powerbar refresh as a hot synchronous path.

- **Render from snapshots only.** Read data from in-memory snapshots, never from disk or network during render. Preload config, manifests, snapshots, agent records, and mailbox counts asynchronously *before* the first frame.
- **Coalesce with `RenderScheduler`.** Always go through `RenderScheduler.schedule()` rather than issuing direct/repeated renders. This batches pending paints and avoids redundant refresh storms.
- **Prefer `snapshotCache.get(runId)`** on render paths. If a synchronous fallback is genuinely unavoidable, classify it as first-load/rare and document why it can't be preloaded.
- **Keep panes pure.** Dashboard panes must accept a snapshot/model and format strings only. Never call `fs.readFileSync`, `fs.readdirSync`, `fs.statSync`, network APIs, or large JSON parsing from pane render methods.
- **Stay non-blocking at 60fps.** Each render cycle must complete in under ~16ms. Anything that can't finish synchronously (reads, fetches, directory scans) belongs in the async preload path, not `renderTick()`.
- **Respect the snapshot-cache TTL of ≤1500ms.** Keep the `RunSnapshotCache` TTL at 1500ms or less (the code default; lower only with cause) so the widget never shows stale state. Watch TTL interactions: the preload interval must be shorter than the cache TTL, otherwise render-time refresh gaps appear.
- **Guard session switches.** On a session switch, cancel timers and ensure in-flight async preloads cannot update a now-stale session's UI.
- **Filter stale warnings by terminal status.** Do not surface health warnings for completed/failed/cancelled runs.

**Anti-patterns:** calling `loadConfig()`, `manifestCache.list()`, or `refreshIfStale()` inside `renderTick()` without preloaded frame data; directory scans or large JSON parsing in widget render/update functions; showing stale health warnings for terminal runs.

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/crew-widget.test.ts test/unit/run-snapshot-cache.test.ts test/unit/live-agent-manager.test.ts
npm test
```