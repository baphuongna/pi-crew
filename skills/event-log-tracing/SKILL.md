---
name: event-log-tracing
description: "Structured event logging for worker lifecycle, live agents, crash recovery. Use when debugging crashes, tracing agent lifecycle, investigating stale runs. Triggers: event log, trace events, worker crashed, agent died, stale run, events.jsonl."
---

# event-log-tracing

Every pi-crew run writes a persistent event log at `.crew/state/runs/<runId>/events.jsonl`. Events are the primary evidence for understanding what happened — especially when workers crash, agents get stuck, or runs become orphaned.

## Event Format

Every event is a JSON object on one line:

```json
{
  "time": "2026-05-14T10:27:52.000Z",
  "type": "worker.spawned",
  "runId": "team_20260514092752_218fe358085d7115",
  "taskId": "01_explore",
  "message": "Worker spawned: pid 12345",
  "data": { "pid": 12345, "role": "explorer" },
  "metadata": {
    "seq": 42,
    "provenance": "team_runner",
    "fingerprint": "a1b2c3d4e5f6g7h8"
  }
}
```

**Required fields:** `time`, `type`, `runId`
**Optional fields:** `taskId`, `message`, `data`, `metadata`
**Metadata auto-populated:** `seq` (line number), `provenance` (who wrote it), `fingerprint` (for terminal events)

---

## Event Taxonomy

### Worker Lifecycle Events (from child-pi.ts via onLifecycleEvent callback)

| Event | When | Data |
|---|---|---|
| `worker.spawned` | Child process starts with a PID | `{pid, cwd}` |
| `worker.spawn_error` | Spawn failed (no PID, binary not found, permission denied) | `{pid?, error}` |
| `worker.response_timeout` | No stdout for `responseTimeoutMs` (default 5 min) | `{pid, error}` |
| `worker.final_drain` | Child finished but lingered — SIGTERM sent | `{pid}` |
| `worker.hard_kill` | Child still alive after `hardKillMs` — SIGKILL sent | `{pid}` |
| `worker.exit` | Process exited (before close) | `{pid, exitCode}` |
| `worker.close` | stdio fully closed | `{pid, exitCode}` |

**Tracing worker crashes:**
- `worker.spawned` followed by `worker.exit` with non-zero code → worker crashed
- `worker.spawned` followed immediately by `worker.spawn_error` → spawn failed
- `worker.spawned` followed by `worker.response_timeout` → worker hung
- `worker.spawned` followed by `worker.final_drain` → worker lingered but completed
- `worker.spawned` followed by `worker.hard_kill` → worker had to be forcibly killed

**Tracing "worker blinks":**
- Widget shows agent appears and disappears within 1 frame
- Root cause: `worker.spawned` + very fast `worker.exit` (crash during spawn)
- Look for `worker.spawn_error` with error details (API key, model, binary)
- `executeWorkers=false` (scaffold mode) means no `worker.spawned` at all — agent completes instantly

### Live Agent Events (from live-agent-manager.ts)

| Event | When | Data |
|---|---|---|
| `live_agent.registered` | `registerLiveAgent` called | `{agentId, role, agent, workspaceId, runId, taskId}` |
| `live_agent.terminated` | `terminateLiveAgent` called | `{agentId, status, role, workspaceId, runId, taskId}` |

These track the full lifecycle from spawn to cleanup.

### Run Lifecycle Events (from task-runner.ts, team-runner.ts)

| Event | When | Data |
|---|---|---|
| `run.created` | Run manifest created | `{team, workflow}` |
| `run.running` | Workflow execution begins | — |
| `run.completed` | All tasks done, no errors | — |
| `run.failed` | Run failed (fatal error, cancelled) | `{reason?}` |
| `task.started` | Task worker spawned | `{role, agent, runtime, cwd}` |
| `task.progress` | Progress event (activity, turns, tokens) | `{eventType, activityState, toolCount, turns, tokens}` |
| `task.attention` | Attention needed (no yield, completion guard, etc.) | `{reason, activityState}` |
| `task.completed` | Task finished successfully | — |
| `task.failed` | Task failed | `{error?}` |
| `task.output_validation` | Output format validation result | `{valid, formatMatch, structurePreserved, issues}` |

### Task Parallel Events

| Event | When | Data |
|---|---|---|
| `task.parallel_start` | Parallel task batch launched | `{tasks, concurrency}` |
| `task.parallel_end` | All parallel tasks finished | `{completed, failed, cancelled}` |

### Hook Events

| Event | When | Data |
|---|---|---|
| `hook.executed` | Hook ran (before_run_start, before_task_start, task_result, etc.) | `{hookName, outcome}` |

### Mailbox Events

| Event | When | Data |
|---|---|---|
| `mailbox.message_added` | Steering/followup message added to mailbox | `{taskId, direction, from, to}` |
| `agent.nudged` | `nudge-agent` API called | `{agentId}` |
| `agent.steered` | Real-time steer delivered to live agent | `{agentId}` |

### Reconciliation Events

| Event | When | Data |
|---|---|---|
| `crew.run.reconciled_stale` | `reconcileStaleRun` repaired a stale run | `{verdict}` |
| `crew.run.orphan_cancelled` | `cancelOrphanedRuns` cancelled a run | `{ownerSessionId, cancelledTasks}` |

---

## appendEvent Pipeline

```
task-runner.ts (onLifecycleEvent callback)
  → child-pi.ts emits ChildPiLifecycleEvent
  → runChildPi calls eventLogFn(eventsPath, event)
  → task-runner.ts passes appendEvent as eventLogFn
  → appendEvent(eventsPath, event) in event-log.ts
  → withEventLogLockSync() (cross-process lock)
  → mkdir + appendFileSync
  → persistSequence() (events.jsonl.seq)
  → emitFromTeamEvent() (UI event bus)
  → compactEventLog() (if >50MB)
```

**Key properties:**
- Cross-process safe via lock directory (`.events.jsonl.lock/`)
- Stale lock detection (PID-based, 10s stale threshold)
- Sequence numbering for deduplication and ordering
- Terminal events (completed/failed/cancelled) get SHA-256 fingerprints
- Redacted secrets (API keys, tokens) via `redactSecrets()` before writing
- 50MB file size limit — logs `event-log.size-limit` error and stops appending

---

## Reading Events

### From the command line

```bash
# View all events for a run
cat .crew/state/runs/<runId>/events.jsonl

# Filter by type
grep '"type": "worker' .crew/state/runs/<runId>/events.jsonl

# Filter by task
grep '"taskId": "01_explore"' .crew/state/runs/<runId>/events.jsonl

# Show recent events
tail -20 .crew/state/runs/<runId>/events.jsonl

# Pretty print
cat .crew/state/runs/<runId>/events.jsonl | python -m json.tool --no-ensure-ascii 2>/dev/null | less

# Count events by type
cat .crew/state/runs/<runId>/events.jsonl | grep -o '"type": "[^"]*"' | sort | uniq -c
```

### From code (readEvents)

```typescript
import { readEvents } from "./state/event-log.ts";
const events = readEvents(eventsPath);
// events is TeamEvent[] sorted by time
```

### From code (readEventsCursor — incremental)

```typescript
import { readEventsCursor } from "./state/event-log.ts";
// Read only new events since last known seq
const result = readEventsCursor(eventsPath, {
  sinceSeq: 42,          // skip events <= seq 42
  fromByteOffset: 2048,  // start reading at byte offset
  limit: 100,            // max 100 events
});
// result.events, result.nextSeq, result.nextByteOffset
```

---

## Common Trace Patterns

### Pattern: Worker spawns and immediately crashes

```
worker.spawned     pid=12345 ts=10:27:52
worker.spawn_error error="..."  ts=10:27:52
worker.exit        exitCode=1   ts=10:27:52
worker.close       exitCode=1   ts=10:27:53
```

**Diagnosis:** Check the `error` field in `spawn_error`. Common causes:
- `"API key not found"` — missing `PI_API_KEY` or `ANTHROPIC_API_KEY`
- `"Model not available"` — wrong model name
- `"Binary not found"` — pi binary not in PATH
- `"Permission denied"` — pi binary not executable

### Pattern: Worker hangs and gets killed

```
worker.spawned     pid=12345 ts=10:27:52
worker.response_timeout error="No output for 300000ms" ts=10:32:52
worker.final_drain pid=12345 ts=10:32:53
worker.hard_kill   pid=12345 ts=10:35:53
worker.exit        exitCode=null ts=10:35:53
worker.close       exitCode=null ts=10:35:54
```

**Diagnosis:** 5 minutes with no output. Worker was unresponsive and was killed.

### Pattern: Normal completion

```
worker.spawned     pid=12345 ts=10:27:52
task.progress      eventType=message ts=10:27:58
task.progress      eventType=message_end ts=10:28:05
task.completed     ts=10:28:10
worker.exit        exitCode=0 ts=10:28:10
worker.close       exitCode=0 ts=10:28:11
```

### Pattern: Scaffold mode (no worker spawn)

```
task.started       runtime=scaffold ts=10:27:52
task.completed     ts=10:27:53
```

**Note:** No `worker.spawned` event means the task ran in scaffold mode (`executeWorkers=false`).

### Pattern: Orphaned run recovered

```
crew.run.orphan_cancelled runId=xxx message="Auto-cancelled orphaned run (owner: ...)"
task.failed taskId=01_explore error="Stale run reconciled: pid_dead"
```

**Diagnosis:** The run's PID was dead. crash-recovery cancelled the tasks.

### Pattern: Ghost run (PID dead, manifest still running)

```
# From reconcileAllStaleRuns scan:
worker.spawned     pid=20964 (but PID 20964 is now dead)
# ... no worker events after this
# → reconcileStaleRun marks tasks cancelled
crew.run.reconciled_stale verdict=pid_dead
```

---

## Anti-patterns

- **`logInternalError` only logs in debug mode**: Production errors are silent — `events.jsonl` is the only durable evidence. Always emit events, never rely on `console.error`.
- **Event flooding**: `task.progress` events can be noisy (up to every ~100ms per active task). Use `readEventsCursor` with `limit` and `sinceSeq` for UI rendering.
- **Missing runId correlation**: Every event must have `runId`. Never write events without it — it breaks correlation.
- **Unredacted secrets**: `appendEvent` calls `redactSecrets()` internally, but caller should avoid putting raw API keys in `data` fields.
- **Corrupt JSONL**: On crash, the last line may be incomplete. `readEvents()` skips unparseable lines silently.

---

## Source patterns

- `src/runtime/child-pi.ts` — ChildPiLifecycleEvent interface, 7 event types
- `src/runtime/task-runner.ts` — onLifecycleEvent callback, bridge to appendEvent
- `src/runtime/live-agent-manager.ts` — live_agent.registered/terminated
- `src/state/event-log.ts` — appendEvent, readEvents, readEventsCursor, scanSequence
- `src/runtime/stale-reconciler.ts` — crew.run.reconciled_stale
- `src/runtime/crash-recovery.ts` — crew.run.orphan_cancelled
- `src/extension/register.ts` — reconcileAllStaleRuns at session start

---

## Verification

```bash
# Check events exist for a run
cat .crew/state/runs/<runId>/events.jsonl | grep -c .   # count events

# Verify worker lifecycle events
grep 'worker\.' .crew/state/runs/<runId>/events.jsonl

# Verify live agent events
grep 'live_agent\.' .crew/state/runs/<runId>/events.jsonl

# Verify reconciliation events
grep 'crew\.run\.' .crew/state/runs/<runId>/events.jsonl

# TypeScript
npx tsc --noEmit
```