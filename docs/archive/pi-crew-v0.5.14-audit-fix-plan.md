# pi-crew v0.5.14 Audit Fix Plan (Round 19)

## Source Verification Findings

I read the following files and identified 5 confirmed real issues:

### Issue 1: `checkpoint.ts` lacks path validation for runId/taskId (MEDIUM security)
**File**: `src/runtime/checkpoint.ts:133-200`

The `saveCheckpoint(runId, taskId, ...)`, `loadCheckpoint(runId, taskId)`, `deleteCheckpoint(runId, taskId)`, `listCheckpoints(runId)`, `hasCheckpoint(runId, taskId)` functions all build paths like:

```ts
const stateRoot = path.join(process.cwd(), ".crew/state/runs", runId);
const checkpointPath = path.join(stateRoot, "checkpoints", `${taskId}.json`);
```

If `runId` or `taskId` contains `../`, an attacker (or a bug) could write to arbitrary paths outside `.crew/`. The other modules (e.g., `state-store.ts`) use `assertSafePathId` and `resolveContainedRelativePath` to defend against this, but `checkpoint.ts` does not.

**Note**: These functions are not currently used in production code (only in tests), so the attack surface is small. But the issue should be fixed for defense-in-depth.

**Fix**: Use `assertSafePathId(runId)` and `assertSafePathId(taskId)` from `utils/safe-paths.ts`.

### Issue 2: `subagent-manager.ts` busy-polls blocked runs (MEDIUM performance)
**File**: `src/runtime/subagent-manager.ts:323-356, 358-389`

`pollRunToTerminal` and `scheduleBlockedTerminalPoll` use `setTimeout` to poll the run manifest every `pollIntervalMs` (default 1000ms). For long-running tasks (hours), this means thousands of `loadRunManifestById` calls.

Each call does:
- File stat
- File read
- JSON parse

**Fix**: Use `fs.watch()` to be notified of manifest changes instead of polling. This is event-driven and only fires when the file actually changes.

### Issue 3: `subagent-manager.ts:waitForRecord` busy-loops with 100ms sleep (LOW performance)
**File**: `src/runtime/subagent-manager.ts:217-225`

When `record.promise` is undefined (just created), the function busy-loops with 100ms `setTimeout`. This works but is inefficient.

**Fix**: Use an event emitter or a promise that's resolved when the record transitions to terminal state.

### Issue 4: `subagent-manager.ts:scheduleStuckBlockedNotify` timer holds strong ref to `record` (LOW memory)
**File**: `src/runtime/subagent-manager.ts:393-407`

The timer closure captures `record` strongly. If the agent is removed (via `removeAgent` or similar), the timer still holds a reference until it fires.

**Fix**: Add `removeAgent(id)` method that clears the timer.

### Issue 5: Test coverage gaps for subagent-manager, paths, checkpoint (LOW)
- `test/unit/subagent-manager.test.ts` — does not exist
- `test/unit/paths.test.ts` — does not exist
- `test/unit/checkpoint.test.ts` — exists but no path-traversal tests

## Plan (5 phases)

### Phase 1: Path validation in checkpoint.ts
- Use `assertSafePathId` from `utils/safe-paths.ts`
- Update `saveCheckpoint`, `loadCheckpoint`, `deleteCheckpoint`, `listCheckpoints`, `hasCheckpoint`

### Phase 2: Add tests for path validation
- Test that `saveCheckpoint` rejects `../etc/passwd`
- Test that `loadCheckpoint` rejects path-traversal IDs

### Phase 3: Test coverage for subagent-manager
- Test spawn, abort, waitForAll
- Test path validation
- Test concurrent limits
- Test cleanup of controllers

### Phase 4: Test coverage for paths
- Test findRepoRoot with various project markers
- Test cache TTL
- Test projectPiRoot / projectCrewRoot

### Phase 5: Release v0.5.14
