# Failure-mode inventory

> **Quick Win 20 (Pattern 20 — declare, don't hide).** Maps the 7 pi-rlm failure
> modes to their pi-crew handlers. Sourced from `rlm-patterns/20-failure-mode-inventory.md`
> (pi-rlm reference) + on-disk verification of pi-crew code paths.
> Gaps are DECLARED, not hidden — each has a status + a forward pointer.

| Mode | pi-crew handler | file:line | Status |
|---|---|---|---|
| **crash** | `shouldRecoverTask` / `detectInterruptedRuns` / `applyRecoveryPlan` | `runtime/recovery/crash-recovery.ts:101,108,145` | ✅ covered (running task + dead/stale heartbeat → re-queue) |
| **wedge** | heartbeat staleness + zombie scan + scratchpad ping | `runtime/heartbeat/worker-heartbeat.ts:28` (`isWorkerHeartbeatStale`); `runtime/process/zombie-scanner.ts:166` (`scanZombieSubagents`); **`prompt/scratchpad-lifecycle.ts:480` (ping-before-execute — pi-crew equivalent of pi-rlm `assertGuestResponsive`)** | ✅ covered (gap CLOSED in Phase 1 — a wedged scratchpad guest is detected before the next `execute`, not just bounded by the 120s cell timeout) |
| **EPIPE** | scratchpad protocol pipe + guest stdin-EOF + hooks + broker | `runtime/scratchpad/engine.ts:151,288`; `runtime/scratchpad/guest.ts:68` (`EPIPE`/`ERR_STREAM_DESTROYED` → exit); `runtime/iteration-hooks.ts:229`; `state/stores/crew-broker-client.ts:184,490` | ⚠️ **partial GAP**: no EPIPE-specific handling in the `child-pi`/`runWorker` spawn path — relies on generic `retryableErrors` globs in `executeWithRetry`. Declared, not fixed (outside quick-win scope). |
| **timeout** | 3 layers: task wall-clock, worker no-output, scratchpad per-cell | `runtime/task-runner/child-executor.ts:454` (`taskTimeoutMs`); `runtime/child-pi/child-pi.ts:481` (`responseTimeoutMs` → SIGTERM); `prompt/scratchpad-lifecycle.ts:60` (`EXECUTE_CELL_TIMEOUT_MS = 120_000`) | ⚠️ **partial GAP**: three independent timeout layers (wall-clock / no-output / per-cell) with no single cross-layer contract test asserting their interplay. Declared. |
| **rate-limit** | model-fallback 429 classification → retryable | `runtime/model/model-fallback.ts:302` (`RETRYABLE_MODEL_FAILURE_PATTERNS`: `/rate.?limit/i`, `/\b429\b/`, `/quota/`); `:382` (`isRetryableModelFailure`); consumed by `executeWithRetry` (`runtime/team-runner.ts:818`) | ✅ covered |
| **auth** | non-retryable classification (never falls back) | `runtime/model/model-fallback.ts:371` (`NON_RETRYABLE_MODEL_FAILURE_PATTERNS`: `/auth/i`, `/unauthori[sz]ed/i`, `/forbidden/i`, `/api key/i`, `/token expired/i`, `/billing/i`); credential detection `:179` | ✅ covered (auth/billing failures are non-retryable by design) |
| **teardown** | session_shutdown + SIGTERM/SIGHUP + scratchpad F3 | `extension/crew-cleanup.ts:66,98` (`session_shutdown` → `cleanupChildProcesses` + SIGTERM handler); `extension/registration/lifecycle-handlers.ts:107` (reason-aware); **`prompt/scratchpad-lifecycle.ts:587` (F3 flush+kill on `reason === "quit"`)**; async runners survive session_shutdown (`runtime/async-runner.ts:280`, by design) | ✅ covered (kill-and-restore verified in Phase 3 — pi print-mode SIGTERM handler emits `quit` → F3 flush) |

## Declared gaps (forward pointers)

1. **EPIPE in child-pi path** — the spawn/runWorker path has no explicit EPIPE handling; an EPIPE from the child surfaces as a generic error retried only if it matches a `retryableErrors` glob. If EPIPE-specific retry/handling is needed, add it in `child-pi.ts` / `child-executor.ts`.
2. **Timeout layer interplay** — `taskTimeoutMs` (wall-clock), `responseTimeoutMs` (no-output), and `EXECUTE_CELL_TIMEOUT_MS` (per-cell) are independent; no contract test asserts which fires first under overlap. If precise layering matters, add a cross-layer test.
3. **wedge (closed note)** — Phase 1 added `ping-before-execute` (`scratchpad-lifecycle.ts:480`) so a wedged scratchpad guest is detected before the next cell; the guest wedge is no longer only bounded by the 120s cell timeout. (A wedged worker EVENT LOOP — sync infinite loop — is still only bounded by the cell timeout + parent SIGKILL; that is the accepted backstop.)
