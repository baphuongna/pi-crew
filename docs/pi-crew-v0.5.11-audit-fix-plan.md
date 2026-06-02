# pi-crew v0.5.11 Audit Fix Plan (Round 16)

## Source Verification Findings

I read the following files and identified 5 confirmed real issues:

### Issue 1: `process.stderr.write` bypasses `logInternalError` (LOW, cleanup)
**Files** (7 occurrences total):
- `src/extension/notification-router.ts:87` — sink error fallback
- `src/i18n.ts:106` — missing translation warning
- `src/observability/metric-registry.ts:40,52,64` — metric description change warnings
- `src/runtime/parent-guard.ts:37` — parent dead message
- `src/state/jsonl-writer.ts:71` — write failed warning

**Rationale**: v0.5.9 L1 fix (in `event-bus.ts`) moved from `console.error` to `logInternalError` to ensure errors are captured even when stderr is redirected. These 7 callsites bypass that pattern.

### Issue 2: `OverflowRecoveryTracker.states` Map has no terminal-state eviction timer (MEDIUM)
**File**: `src/runtime/overflow-recovery.ts:34-38`

When `feedEvent` reaches phase="recovered"/"failed"/"none", the timer uses `TERMINAL_STATE_TTL_MS = 5*60_000`. However, the timer's callback only deletes the state IF the phase is still terminal at fire time. If a state is e.g. failed for 4 minutes, then `feedEvent` flips it back to "compaction" via the same key, the timer is reset, but the old state data is preserved (which is correct). But:

**Real bug**: When `feedEvent` first creates a state and immediately transitions to terminal phase, the timer fires after 5 min, deletes the state, and the timer's own reference is removed. **However**, if a new `feedEvent` arrives AFTER the timer has fired (i.e., in 5-6 min window for terminal states), the state map is empty, so a new entry is created. This is fine.

**Actual real bug**: Looking at `dispose()` — it calls `for (const timer of this.timers.values()) clearTimeout(timer)`, which is correct. So the issue is just: `states` Map can grow to N concurrent tasks. The terminal-state TTL handles cleanup. This is OK.

**Conclusion**: No real bug here, but I should add a "MAX_TRACKED_STATES" cap as a defensive measure.

### Issue 3: `AutoResumeController` race on rapid `scheduleResume` calls (LOW)
**File**: `src/runtime/auto-resume.ts:51-71`

`cancelResume()` clears the timer, but if `cancelResume` is called between `setTimeout` and the callback executing, the callback's `if (!this.cancelled)` check handles it. However, `cancelled` is a separate boolean from `timerId !== null`. The flow is:

1. `scheduleResume` → `cancelled = false`, `timerId = setTimeout(...)`
2. `cancelResume` → `clearTimeout(timerId)`, `cancelled = true`
3. `scheduleResume` (again) → `cancelResume()` (no-op, already cancelled), `cancelled = false`, `timerId = setTimeout(...)`

This is correct. **No real bug.**

### Issue 4: `OverflowRecoveryTracker` callback exception in `feedEvent` is silent (LOW)
**File**: `src/runtime/overflow-recovery.ts:113-117`

```ts
if (previousPhase !== phase && this.callbacks.onPhaseChange) {
    try {
        this.callbacks.onPhaseChange(state, previousPhase);
    } catch (error) {
        logInternalError("overflow-recovery.onPhaseChange", error, `taskId=${taskId}`);
    }
}
```

This is properly wrapped in try/catch. **No bug.**

### Issue 5: `NotificationRouter.evictSeenIfNeeded` only fires on enqueue (MEDIUM)
**File**: `src/extension/notification-router.ts:65-75`

The eviction runs on every `enqueue` call. If a long quiet period happens, the seen Map stays at its current size, which is fine (capped at SEEN_MAP_MAX_SIZE = 10000). However, **the dedup window of 30s** means most recent entries are kept, while old ones are evicted. This is correct.

**Real issue**: `seenCleanupCounter` is declared at line 60 but **never used**! It's dead code. Should either be wired in or removed.

**File**: `src/extension/notification-router.ts:60`

```ts
private seenCleanupCounter = 0;  // ← declared, never used
```

This is dead code that should be removed for code quality.

## Plan (5 phases)

### Phase 1: L1 cleanup (continued)
Replace 7 `process.stderr.write` calls with `logInternalError`:
- `src/extension/notification-router.ts:87`
- `src/i18n.ts:106`
- `src/observability/metric-registry.ts:40,52,64`
- `src/runtime/parent-guard.ts:37`
- `src/state/jsonl-writer.ts:71`

**Note**: `internal-error.ts:5` itself uses `console.error` — that's the implementation, leave it.

### Phase 2: Remove dead code
- `src/extension/notification-router.ts:60` — unused `seenCleanupCounter`

### Phase 3: Defensive MAX_TRACKED_STATES cap
- `src/runtime/overflow-recovery.ts:34` — add `MAX_TRACKED_STATES = 5000` cap to `states` Map

### Phase 4: New test coverage
- `test/unit/notification-router.test.ts` — new test file
- `test/unit/overflow-recovery.test.ts` — new test file
- `test/unit/auto-resume.test.ts` — new test file

### Phase 5: Release v0.5.11
