---
name: live-agent-lifecycle
description: >
  Live agent registration, workspace isolation, termination, and eviction workflow.
  When NOT to use: static extension registration patterns (use pi-extension-lifecycle); ownership disputes (use ownership-session-security).

origin: pi-crew
triggers:
  - "register agent"
  - "terminate agent"
  - "evict stale"
  - "ghost agent"
  - "workspace isolation"

---
# live-agent-lifecycle

Live agents are real-time, in-memory worker sessions managed by `LiveAgentManager` (`src/runtime/live-agent-manager.ts`). They are distinct from `CrewAgentRecord` files on disk — live agents provide real-time activity (tool names, response text, turn count) while agent records are durable snapshots.

## Architecture

**LiveAgentHandle** is the core data structure:

```typescript
interface LiveAgentHandle {
  agentId: string;        // unique per run
  taskId: string;         // maps to task
  runId: string;          // run this agent belongs to
  workspaceId: string;   // manifest.cwd — workspace boundary
  role?: string;
  agent?: string;
  modelName?: string;
  session: LiveSessionHandle; // steer/prompt/abort/dispose
  status: CrewAgentRecord["status"];
  pendingSteers: string[];
  pendingFollowUps: string[];
  pendingMessages: IrcMessage[];
  activity: LiveAgentActivity; // real-time tracking
  createdAt: string;
  updatedAt: string;
}
```

The in-memory `liveAgents` Map stores all active handles. It is never persisted — on Pi restart, the Map is empty and agents are re-created from agent records.

## Registration

`registerLiveAgent(input, eventLogFn?, eventsPath?)` is called when a live session worker starts. It:

1. Creates or reuses the handle in `liveAgents` Map
2. Preserves pending steers/followups from previous sessions
3. Emits `live_agent.registered` event to events.jsonl
4. Flushes any pending steers/followups immediately if the session already has the methods

Key caller sites:
- `live-session-runtime.ts` — when a live session agent starts
- `live-executor.ts` — when spawning a live task
- (workspaceId is passed through the entire call chain)

## Workspace Isolation

**`workspaceId: string`** field is the workspace boundary. Set to `manifest.cwd` at registration time.

**Why it matters:** When Pi has multiple workspace folders open, agents from workspace A must not be visible or controllable from workspace B. Every handle carries its origin workspace.

**Enforcement in api.ts:**
- `listActiveLiveAgentsByWorkspace(workspaceId)` — filters by workspace
- Steering/follow-up operations check `live.workspaceId !== manifest.cwd` → reject with error
- Widget queries use `listLiveAgentsByWorkspace(manifest.cwd)` so each workspace only sees its own agents

**Enforcement in live-session-runtime.ts:**
- Config carries `workspaceId` from `TeamContext.workspaceId`
- Session creation passes workspaceId through

---

## Activity Tracking

`LiveAgentActivity` provides real-time data without reading disk:

```typescript
interface LiveAgentActivity {
  activeTools: Map<string, string>;   // toolName → description
  toolUses: number;                   // total invocations
  turnCount: number;
  maxTurns?: number;
  responseText: string;               // last 200 chars
  compactionCount: number;
  startedAtMs: number;
  completedAtMs: number;              // 0 = still running
  modelName?: string;
}
```

Tracking functions (called from live-executor):
- `trackLiveAgentToolStart(agentId, toolName)` — adds tool to activeTools
- `trackLiveAgentToolEnd(agentId, toolName)` — removes tool from activeTools
- `trackLiveAgentTurnEnd(agentId, compaction?)` — increments turn, clears tools
- `trackLiveAgentResponseText(agentId, text)` — stores last 200 chars
- `markLiveAgentCompleted(agentId)` — sets completedAtMs

---

## Termination

`terminateLiveAgent(agentIdOrTaskId, status?, eventLogFn?, eventsPath?)` is the canonical termination path:

1. Sets handle status (default: "stopped")
2. Emits `live_agent.terminated` event to events.jsonl
3. Calls `session.abort()` to stop the child
4. Calls `session.dispose()` to clean up
5. Removes from `liveAgents` Map

**Termination call sites (4 total):**

| Location | When |
|---|---|
| `team-runner.ts` (run complete) | All agents terminated when run succeeds or fails |
| `team-runner.ts` (task complete) | Per-task termination when `terminateOnTaskComplete=true` |
| `background-runner.ts` (catch) | Termination in finally block after background run |
| `cancel.ts` | Termination when user cancels a run |
| `respond.ts` | Termination when responding to waiting tasks |
| `crash-recovery.ts` (purgeStale) | Termination when cleaning up orphaned runs |
| `crash-recovery.ts` (reconcile) | Termination when reconciling stale runs |

`terminateLiveAgentsForRun(runId, status?, eventLogFn?, eventsPath?)` terminates all agents for a run in parallel.

---

## Eviction

**Stale handles** are handles whose status is terminal (not running/queued/waiting) and older than 10 minutes. `evictStaleLiveAgentHandles(now?)` removes them:

```typescript
const STALE_HANDLE_MS = 10 * 60 * 1000;
// Only evict terminal-status handles
if (handle.status !== "running" && handle.status !== "queued" && handle.status !== "waiting") {
  const age = now - new Date(handle.updatedAt).getTime();
  if (age > STALE_HANDLE_MS) {
    liveAgents.delete(agentId);
    safeDisposeLiveSession(handle);
  }
}
```

**Triggered on every widget refresh** in `crew-widget.ts`:
```typescript
evictStaleLiveAgentHandles(); // called at start of activeWidgetRuns()
```

This prevents the Map from growing indefinitely with completed agents.

---

## Live Agent → Agent Record Sync

On task completion, `upsertCrewAgent(manifest, recordFromTask(manifest, task, "live-session"))` is called to persist the final status to disk (`agents.json`, `agents/<id>/status.json`). This ensures the widget sees the correct status even after the live agent handle is evicted.

The sync chain:
```
task.completed → upsertCrewAgent → agents.json updated
             → live_agent.terminated event logged
             → (later) evictStaleLiveAgentHandles → handle removed from Map
```

---

## Enforcement — Live Agent Lifecycle Gate

**Before terminating or evicting live agents, verify:**

- [ ] Agent handle status is terminal (not running/queued/waiting) for eviction
- [ ] Handle age exceeds STALE_HANDLE_MS (10 minutes) for eviction
- [ ] workspaceId matches current workspace for cross-workspace prevention
- [ ] Agent record sync completed before handle eviction (upsertCrewAgent called)
- [ ] Termination called in all exit paths (finally blocks, crash-recovery)

If ANY answer is NO → Stop. Verify lifecycle state before mutation.

## Anti-patterns

- **Missing termination on error path**: If a live agent crashes and `terminateLiveAgent` is not called, the handle stays in the Map forever with status "running". Use `finally` blocks or crash-recovery to ensure termination.
- **Stale handle accumulation**: Without `evictStaleLiveAgentHandles`, completed agents accumulate in the Map. This is mitigated by calling eviction on every widget refresh.
- **Cross-workspace access**: Never call steer/follow-up/stop/resume on a handle whose `workspaceId` differs from the current workspace. Always check `live.workspaceId === manifest.cwd`.
- **Losing activity on session switch**: Live agents are in-memory only. On Pi session switch/restart, all activity tracking is lost. Agent records on disk persist.

---

## Source patterns

- `src/runtime/live-agent-manager.ts` — register, terminate, evict, workspaceId
- `src/runtime/live-session-runtime.ts` — 4 lifecycle gaps fixed
- `src/runtime/team-runner.ts` — terminate on success/fail
- `src/runtime/background-runner.ts` — terminate on catch
- `src/runtime/crash-recovery.ts` — terminate in purge+reconcile
- `src/extension/team-tool/api.ts` — workspaceId filter
- `src/extension/team-tool/cancel.ts` — terminate on cancel
- `src/extension/team-tool/respond.ts` — terminate on respond
- `src/ui/crew-widget.ts` — evictStaleLiveAgentHandles on refresh

---

## Verification

```bash
cd pi-crew
npx tsc --noEmit
node --experimental-strip-types --test test/unit/live-agent-manager.test.ts test/unit/live-session-runtime.test.ts test/unit/live-agent-control.test.ts
npm test
```