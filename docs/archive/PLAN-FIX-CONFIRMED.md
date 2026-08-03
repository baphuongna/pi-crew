# Plan: Fix Confirmed Issues from Code Review

## Date: 2026-07-15
## Source: Review team_20260715061952_eb072129587c5a44

---

## Issue 1: Foreground Abort on session_switch (HIGH)

### Problem
`cleanupRuntime()` is called on ALL `session_shutdown` events, including session switches. The P0 fix comment says "foreground runs should NOT be aborted on session switch", but the implementation still aborts them.

### Root Cause
```typescript
// register.ts:1388
pi.on("session_shutdown", () => cleanupRuntime());
```

The handler doesn't check `event.reason`. During `switchSession`, the event has `reason: "resume"`, which triggers `cleanupRuntime()` → aborts foreground team runs.

### Evidence
- Pi agent source: `SessionShutdownEvent.reason` can be `"quit" | "reload" | "new" | "resume" | "fork"`
- `switchSession()` calls `teardownCurrent("resume", ...)` which emits `session_shutdown` with `reason: "resume"`
- `cleanupRuntime()` aborts ALL foreground team run controllers

### Fix
**File:** `src/extension/register.ts`

1. Update `session_shutdown` handler to check `event.reason`:
```typescript
pi.on("session_shutdown", (event) => {
    // Only abort foreground runs on actual shutdown, not session switch.
    // Session switch (reason="resume"/"new"/"fork") should let foreground runs complete.
    if (event.reason === "quit" || event.reason === "reload") {
        cleanupRuntime();
    } else {
        // For session switch: cleanup resources but don't abort foreground runs
        // This matches the P0 fix intent
        cleanupSessionResourcesOnly();
    }
});
```

2. Extract `cleanupSessionResourcesOnly()` from `cleanupRuntime()`:
- Cleanup preload timers, watchers, schedulers
- Stop subagents
- Dispose UI
- BUT do NOT abort `foregroundTeamRunControllers`

3. Add test for this behavior:
- Verify foreground runs survive session switch
- Verify foreground runs are aborted on actual shutdown

### Risk: LOW
- Only changes when foreground runs are aborted
- Existing session shutdown behavior unchanged
- P0 fix intent finally matches implementation

---

## Issue 2: `undefined/` Directory Cleanup (LOW)

### Problem
Directory `pi-crew/undefined/` exists with stale `.pi/teams/state/runs/` structure. Created by external process with `cwd` set to `undefined`.

### Fix
1. Add to `.gitignore`:
```
undefined/
```

2. Clean up existing directory:
```bash
rm -rf pi-crew/undefined/
```

3. Add defensive assertion in `createRunPaths`:
```typescript
export function createRunPaths(cwd: string, runId = createRunId()): RunPaths {
    if (!cwd || typeof cwd !== 'string') {
        throw new Error(`Invalid cwd: ${cwd}`);
    }
    assertSafePathId("runId", runId);
    // ... rest of function
}
```

### Risk: VERY LOW
- Defensive check only
- Existing valid calls unaffected

---

## Issue 3: Document EPERM Lock Decision (LOW)

### Problem
EPERM handling in `readLockSnapshot` treats EPERM as "not alive" (stealable). This is a deliberate trade-off but should be documented clearly.

### Fix
1. Add JSDoc comment to `readLockSnapshot`:
```typescript
/**
 * EPERM handling rationale:
 * - EPERM means process exists but we lack permission to signal it
 * - We treat it as "potentially stale" to avoid blocking indefinitely
 * - This is acceptable: EPERM requires elevated privileges, and on
 *   single-user workstations (typical pi-crew environment) this is rare
 * - On shared/multi-user systems, this could allow lock stealing from
 *   a live process under different permissions
 * - See: locks.ts:54-58 for the original design decision
 */
```

2. Add note in SECURITY-ISSUES.md:
```
### SEC-008: EPERM Lock Stealing (Accepted Risk)
- **Severity:** Low (single-user), Medium (multi-user)
- **Status:** Accepted — documented trade-off
- **Rationale:** Blocking indefinitely is worse than allowing stealing
```

### Risk: NONE
- Documentation only

---

## Implementation Order

1. **Issue 1** (HIGH) — Fix foreground abort semantics
2. **Issue 2** (LOW) — Clean up `undefined/` directory
3. **Issue 3** (LOW) — Document EPERM decision

## Testing

1. **Issue 1:**
   - Run existing foreground run tests
   - Add new test: foreground run survives session switch
   - Add new test: foreground run aborted on actual shutdown

2. **Issue 2:**
   - Verify `undefined/` directory removed
   - Verify `.gitignore` entry works
   - Verify `createRunPaths` rejects invalid cwd

3. **Issue 3:**
   - No tests needed (documentation only)

## Rollback

All changes are low-risk and can be reverted via git.
