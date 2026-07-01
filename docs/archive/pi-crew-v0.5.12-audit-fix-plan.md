# pi-crew v0.5.12 Audit Fix Plan (Round 17)

## Source Verification Findings

I read the following files and identified 4 confirmed real issues + test coverage gaps.

### Issue 1: Signal listeners stack up on registerCleanupHandler (HIGH)
**File**: `src/extension/crew-cleanup.ts:81-82`

```ts
process.on("SIGTERM", () => { void handleSignal("SIGTERM"); });
process.on("SIGHUP", () => { void handleSignal("SIGHUP"); });
```

These listeners are added every time `registerCleanupHandler(pi)` is called. If the extension is reloaded (e.g., in dev mode, or via `pi install --reload`), the listeners stack up. This causes:
- Memory leak (closures over `handleSignal`)
- Multiple cleanup invocations on shutdown → multiple SIGTERM to children
- Confusing logs ("Received SIGTERM - starting cleanup" repeated)

**Fix**: Make the signal handlers idempotent. Use a module-level `signalHandlersRegistered` flag, or use `process.once` instead of `process.on`. Better: register only once at module load.

### Issue 2: Unhandled promise rejection in signal handler (MEDIUM)
**File**: `src/extension/crew-cleanup.ts:81-82`

```ts
process.on("SIGTERM", () => { void handleSignal("SIGTERM"); });
```

If `handleSignal` throws or rejects, the unhandled rejection is silently swallowed (because `void` discards the promise). This violates our "log all errors" pattern from v0.5.9 L1.

**Fix**: Wrap with `.catch()` and `logInternalError`.

### Issue 3: console.error bypasses logInternalError in 4 files (MEDIUM, L1 continued)
**Files** (7 occurrences total):
- `src/extension/crew-cleanup.ts:59` (cleanup error)
- `src/extension/crew-cleanup.ts:84` (kill process error)
- `src/extension/crew-cleanup.ts:103` (temp cleanup error)
- `src/extension/async-notifier.ts:124` (notifier error)
- `src/runtime/async-runner.ts:166` (spawn failed)
- `src/runtime/hidden-handoff.ts:244` (handoff failed)
- `src/runtime/crew-hooks.ts:167,172` (hook error)

**Rationale**: v0.5.9 L1 fix (in `event-bus.ts`) and v0.5.11 round 16 cleanup moved from `console.error` to `logInternalError` to ensure errors are captured even when stderr is redirected. These 8 callsites bypass that pattern.

**Note**: `internal-error.ts:5` itself uses `console.error` — that's the implementation, leave it. `background-runner.ts:146` overrides `console.error` for testing — also leave.

### Issue 4: Test coverage gaps in security/runtime code (LOW)
- `test/unit/crew-cleanup.test.ts` — does not exist
- `test/unit/async-notifier.test.ts` — does not exist
- `test/unit/pi-spawn.test.ts` — does not exist (security-critical!)
- `test/unit/live-agent-manager.test.ts` — does not exist
- `test/unit/crew-hooks.test.ts` — does not exist

## Plan (5 phases)

### Phase 1: Fix signal handler stacking
- Use module-level flag to register signal handlers only once
- Wrap with `.catch()` to log promise rejections

### Phase 2: L1 cleanup in 4 files
Replace 8 `console.error` calls with `logInternalError`:
- crew-cleanup.ts (3 calls)
- async-notifier.ts (1 call)
- async-runner.ts (1 call)
- hidden-handoff.ts (1 call)
- crew-hooks.ts (2 calls)

### Phase 3: Test coverage for security-critical modules
- `test/unit/crew-cleanup.test.ts` — test signal handler idempotency, cleanup logic
- `test/unit/pi-spawn.test.ts` — test `isWithinAllowedPrefixes`, `validateExplicitBin`

### Phase 4: Test coverage for runtime modules
- `test/unit/async-notifier.test.ts` — test isCurrent guard, generation check
- `test/unit/live-agent-manager.test.ts` — test eviction logic

### Phase 5: Release v0.5.12
