# Runtime Safety

## Behavior

pi-crew enforces multiple safety layers to prevent resource leaks, crashes,
and runaway execution.

### Depth Guard

- Tracks `PI_CREW_SESSION_DEPTH` environment variable
- Depth >= 2 forces `child-process` mode instead of `live-session`
- Prevents stack overflow from nested team runs

### Resource Limits

- Memory cap on live-session agents
- Prompt timeout for agent responses
- Tool count restoration after session error

### Process Cleanup

- `cleanupTempDir()` with `existsSync` guard against double cleanup
- `safeDisposeLiveSession()` for clean resource teardown
- `removeLiveAgentHandle()` for registry cleanup

### Error Handling

- `try/catch` around all I/O operations in UI code
- `rmSyncRetry()` with exponential backoff for Windows EBUSY
- `rejectRunPromise` (not `resolveRunPromise`) in error paths

### State Integrity

- `withRunLockSync` for all state mutations
- Atomic write helpers (`writeJsonAtomic`, `appendJsonAtomic`)
- `markActiveTasksAndAgentsFailed()` for crash recovery
- Event log append-only for audit trail
