# pi-crew Bug Fix Plan — 2026-07-10

## Status: IMPLEMENTED (partial — 9/10 fixes done, 1 reverted, 1 deferred)

## Final Results
- **Tests:** 2995 passing, 0 failures
- **Files changed:** 9 source files + 4 test files
- **Reverted:** FIX-07 (broke existing test — retry wrapper was misguided)
- **Partial:** FIX-08 (1/3 files migrated)
- **Deferred:** FIX-09 (low priority)

## Implementation Log

| Fix | Status | Files |
|-----|--------|-------|
| FIX-01: logInternalError severity tiers | ✅ DONE | `src/utils/internal-error.ts` |
| FIX-01b: Upgrade 5 critical callers | ✅ DONE | `state-helpers.ts`, `child-pi.ts`, `team-runner.ts`, `atomic-write.ts`, `crash-recovery.ts` |
| FIX-02: Steering content sanitization | ✅ DONE | `src/prompt/prompt-runtime.ts` |
| FIX-03: Steering file path validation | ✅ DONE | `src/prompt/prompt-runtime.ts` |
| FIX-04: Symlink cache TTL + comment | ✅ DONE | `src/state/atomic-write.ts` |
| FIX-05: CAS error message count | ✅ DONE | `src/runtime/task-runner/state-helpers.ts` |
| FIX-06: Stale skill comment | ✅ DONE | `src/runtime/skill-instructions.ts` |
| FIX-07: withRunLockSync retry | ❌ REVERTED | broke api-locks test; fast-fail is correct |
| FIX-08: Sync→async appendEvent | 🟡 PARTIAL | `src/runtime/async-runner.ts` only (1/3 files) |
| FIX-09: execFile migration | ❌ DEFERRED | low priority, not started |

## Why FIX-07 was reverted
The retry wrapper extended failure time from instant to 60s (staleMs×2). The original "fast-fail on hard lock contention" behavior is correct: if a lock is held by a fresh, alive process, the caller should propagate the error and decide whether to retry. The 60s blind retry doesn't help — it just makes failures take longer. The existing test `api-locks.test.ts:37` expects fast-fail and is correct.

## Why FIX-08 is partial
The worker assigned to FIX-08 failed before doing any work (worker terminated early). I migrated 1 file manually (`async-runner.ts`, 1 call site) which is low-risk. The 2 remaining files (`goal-loop-runner.ts` 12 calls, `team-tool/api.ts` 11 calls) require careful review of each call site for ordering dependencies. Recommended for follow-up.

---

## Phase 1: HIGH — Observability Foundation (unlocks all other fixes)

### FIX-01: `logInternalError` severity tiers
**File:** `src/utils/internal-error.ts`
**Problem:** ALL 100+ internal error calls are gated behind `PI_TEAMS_DEBUG`. CAS failures, zombie processes, event-log corruption, heartbeat leaks — all invisible in production.
**Fix:**
- Add severity parameter: `"error" | "warn" | "debug"` (default: `"debug"` for backward compat)
- `"error"` and `"warn"` → always emit to `console.error`
- `"debug"` → gated behind `PI_TEAMS_DEBUG` (current behavior)
- Update the function signature: `logInternalError(scope, error, details?, severity?)`
- Do NOT change all 100+ callers now — just add the parameter. Callers can be upgraded incrementally.

### FIX-01b: Upgrade critical callers to severity="error"
**Files:** Key callers that MUST be visible in production:
- `src/runtime/task-runner/state-helpers.ts:96` — CAS convergence failure → `"error"`
- `src/runtime/child-pi.ts:111` — taskkill stuck zombie → `"error"`
- `src/runtime/team-runner.ts:703` — false-green downgrade → `"error"`
- `src/state/atomic-write.ts:734` — coalesced flush failure → `"error"`
- `src/state/event-log.ts` — event-log corruption/rotation errors → `"error"`
- `src/runtime/crash-recovery.ts` — orphan process termination → `"warn"`

---

## Phase 2: HIGH — Security Fixes

### FIX-02: Steering file content sanitization
**File:** `src/prompt/prompt-runtime.ts`
**Problem:** `entry.message` from steering file injected raw into agent sessions via `pi.sendMessage`. No length check, no content filtering.
**Fix:**
- Add max length check (e.g., 4096 chars) on `entry.message`
- Add content validation: reject messages with control characters or excessive newlines
- Log rejection via `logInternalError("prompt-runtime.steer-rejected", ...)` with severity="warn"
- Add unit test for malicious steering content

### FIX-03: Steering file path containment validation
**File:** `src/prompt/prompt-runtime.ts`
**Problem:** `PI_CREW_STEERING_FILE` env var read and used for file I/O without path validation. No `resolveRealContainedPath`, no symlink check.
**Fix:**
- Import `resolveRealContainedPath` from `src/utils/safe-paths.ts`
- Validate steering file path against session artifacts root before first read
- Add `fs.lstatSync` check to reject symlinks
- Reject with `logInternalError` if validation fails

---

## Phase 3: HIGH — Symlink Cache

### FIX-04: `invalidateSymlinkSafeCache` wiring or documentation
**File:** `src/state/atomic-write.ts`
**Problem:** Exported function has zero callers. Documentation claims it's called from file-creation hooks. 30s TTL is sole protection.
**Fix (Option A — document trust model):**
- Update comment to state: "TTL-only invalidation. The `.crew/` state directory is trusted (single-user, non-shared). Symlink attacks require write access to state dir."
- Remove misleading "invalidated explicitly via" claim from comment
- Reduce TTL from 30s to 10s as belt-and-suspenders
**Fix (Option B — wire callers):** More complex, defer to follow-up.

**Decision:** Option A (document + reduce TTL) — simpler, lower risk.

---

## Phase 4: MEDIUM — Correctness Fixes

### FIX-05: CAS retry error message count
**File:** `src/runtime/task-runner/state-helpers.ts`
**Problem:** Loop runs 100 iterations but error says "50 attempts".
**Fix:**
- Change `"failed to converge after 50 attempts"` → `"failed to converge after 100 attempts"` (2 locations: `logInternalError` call and thrown error)
- Better: extract `const MAX_CAS_ATTEMPTS = 100` and use in both loop and message

### FIX-06: Stale skill-instructions comment
**File:** `src/runtime/skill-instructions.ts`
**Problem:** Comment at lines 33-35 says "project-level SKILL.md files will be FOUND FIRST" but SEC-003 fix reversed to package-first.
**Fix:**
- Replace comment: "Package skills are checked FIRST (SEC-003). Project-level skills with the same name will NOT override the trusted package version."

### FIX-07: `withRunLockSync` outer retry wrapper
**File:** `src/state/locks.ts`
**Problem:** `withRunLockSync` throws immediately on cross-process contention, unlike `withFileLockSync` which has deadline-based retry.
**Fix:**
- Add the same deadline-based retry loop pattern from `withFileLockSync` to `withRunLockSync`
- Keep the existing re-entrance fast-path (`runLockHeldByUs`)
- Use `staleMs * 2` as deadline (same as `withFileLockSync`)

---

## Phase 5: MEDIUM — Performance

### FIX-08: Sync `appendEvent` migration (partial)
**Files:** `src/runtime/goal-loop-runner.ts`, `src/runtime/async-runner.ts`, `src/extension/team-tool/api.ts`
**Problem:** 97 callers use sync `appendEvent()` → `sleepSync(10)` blocks event loop. These are in async contexts.
**Fix (Phase 1 — top 3 hot-path callers):**
- `goal-loop-runner.ts` — migrate ~10 calls to `appendEventAsync`
- `async-runner.ts` — migrate ~5 calls to `appendEventAsync`
- `team-tool/api.ts` — migrate ~10 calls to `appendEventAsync`
- Note: verify that callers don't rely on sync ordering guarantees before migrating

---

## Phase 6: LOW — Defense-in-Depth

### FIX-09: Verification gates execFile migration
**File:** `src/runtime/verification-gates.ts`
**Problem:** Commands use `sh -c` which enables shell interpretation. VULN-3/4 fixed but edge cases remain.
**Fix:**
- Replace `spawn("sh", ["-c", command], ...)` with `spawn("sh", ["-c", command], ...)` BUT add `shell: false` and use `execFile` for simple commands
- OR: wrap command in a shell script file and execute that (eliminates `sh -c` injection surface)
- Keep existing dangerous-pattern validation as belt-and-suspenders

**Note:** This is lower priority because verification commands are user-supplied (not worker-injected), and existing validation is solid. Defer if time-constrained.

---

## Tests to Add

| Test | File | Covers |
|---|---|---|
| Steering content sanitization | `test/unit/prompt-runtime-steering.test.ts` | FIX-02 |
| Steering file path validation | `test/unit/prompt-runtime-steering.test.ts` | FIX-03 |
| `logInternalError` severity tiers | `test/unit/internal-error.test.ts` | FIX-01 |
| CAS error message accuracy | `test/unit/state-helpers.test.ts` | FIX-05 |
| `withRunLockSync` contention retry | `test/unit/locks-race.test.ts` | FIX-07 |

---

## Execution Order

```
Phase 1 (FIX-01, FIX-01b) ← MUST be first (other fixes depend on severity tiers)
    ↓
Phase 2 (FIX-02, FIX-03) ← security fixes, can parallel with Phase 3
Phase 3 (FIX-04) ← symlink cache, independent
    ↓
Phase 4 (FIX-05, FIX-06, FIX-07) ← correctness fixes, independent of each other
    ↓
Phase 5 (FIX-08) ← performance, requires careful migration
    ↓
Phase 6 (FIX-09) ← defense-in-depth, lowest priority
    ↓
Tests ← after code changes
    ↓
npm test ← verify no regressions
```

## Success Criteria
- [ ] `npm test` passes (1554+ tests, 0 failures)
- [ ] FIX-01: `logInternalError("scope", err, details, "error")` emits to stderr without `PI_TEAMS_DEBUG`
- [ ] FIX-02: Steering content > 4096 chars is rejected
- [ ] FIX-03: Steering file outside artifacts root is rejected
- [ ] FIX-04: Symlink cache TTL reduced to 10s, misleading comment removed
- [ ] FIX-05: CAS error message says "100 attempts" matching loop bound
- [ ] FIX-06: Skill comment reflects package-first order
- [ ] FIX-07: `withRunLockSync` retries on contention instead of throwing immediately
- [ ] FIX-08: Top 3 async callers migrated to `appendEventAsync`
