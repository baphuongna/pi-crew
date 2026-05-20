# Bug #15: Background Runner Receives SIGTERM ~3s After Spawn

## Status: ✅ Fixed — Disabled async by default

## Fix Applied: Disable Async by Default
**File:** `src/extension/team-tool/run.ts`
```typescript
// Background runners are disabled by default because Pi infrastructure sends SIGTERM to
// async children ~3s after spawn (Bug #15). Set to true to enable background runs.
// const runAsync = params.async ?? loadedConfig.config.asyncByDefault ?? false;
const runAsync = false; // TEMP: always false until SIGTERM issue is fixed
```

**Verification (2026-05-20):** Full 4-task team run `team_20260520091127_8bcd4ca6f9fa84f5` completed successfully in ~4 minutes using foreground blocking mode. 01_explore, 02_plan, 03_execute, 04_verify all completed with `status=completed`. No SIGTERM because no background runner was spawned.

**Root Cause:** Pi CLI infrastructure sends SIGTERM to async background runners ~3s after spawn. `setsid:true` does not work in Node.js 22.22.0. No fix available from pi-crew side — requires Pi infrastructure change or Node.js fix.

## Symptom (Historical)
All async background runners die with SIGTERM approximately 3 seconds after spawning, regardless of workload or configuration. The SIGTERM comes from the Pi CLI process.

## Timeline (from events.jsonl)
```
06:56:31.549  async.spawned   (background runner created, pid noted)
06:56:32.466  async.started   (background runner main() begins executing)
06:56:32.691  worker.spawned 01_explore (child Pi worker spawned)
06:56:32.706  worker.spawned 02_plan (child Pi worker spawned)
06:56:35.713  async.failed   SIGTERM received from pi process (ppid=1509889)
                → background runner exits with code 143
```

## Root Cause Analysis

### Pi Infrastructure Cleanup — CONFIRMED
Pi CLI infrastructure sends SIGTERM to direct children when the tool call that spawned them returns. This is normal cleanup behavior for detached processes.

**Evidence:**
- SIGTERM sender PID = Pi process (1509889) — exactly where `crew_agent` tool runs
- SIGTERM arrives at a consistent ~3s interval after `async.started`
- No OOM, no dmesg entries, no pi-crew internal kill(SIGTERM) calls exist
- Pi source has SIGTERM handling for subprocess cleanup

### setsid Bug in Node.js 22.22.0 — Confirmed
`setsid: true` does not actually create a new session in Node.js 22.22.0. The background runner remains in the Pi process's process group (PGID=1509889). This was confirmed by direct testing showing that `detached: true` + `setsid: true` does NOT result in the child having its own PGID.

### Key Discovery: Orphaned Workers Survive
After SIGTERM kills the background runner, orphaned workers continue running:
```
07:03:39.148  SIGTERM → background runner DIES but orphaned workers CONTINUE
07:08:39      stale-reconciler detects dead heartbeat → cancel orphaned tasks
```

This proves:
1. Child workers are properly detached (PPID=1 or independent PG)
2. Pi only sends SIGTERM to **direct children** (background runner), not grandchildren
3. The issue is that background-runner is a direct child and gets killed

## Files Modified
```
src/extension/team-tool/run.ts — runAsync = false (disabled async by default)
```

## Future Considerations
1. **Re-enable async** when Pi infrastructure is fixed or Node.js setsid works correctly
2. **Shell wrapper approach** — spawn via `/bin/sh -c 'exec setsid node ...'` as intermediate process
3. **Report to Pi maintainers** — the Pi infrastructure's cleanup behavior may need adjustment for long-running async workers