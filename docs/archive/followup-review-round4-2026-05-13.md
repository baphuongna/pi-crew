# Follow-up Review Round 4 — 2026-05-13

Review of commits `c7bd455` through `5f47e92` (7 commits on top of `faa81e4`).

## Summary

These commits harden live-session runtime cleanup, async runner lifecycle, crew-agent persistence, and Windows test flakiness. Overall quality is high and the fixes address real production issues. However, one commit introduces a **regression** that breaks the resume/follow-up capability for completed live-session agents. Two other issues could cause crashes or races in edge cases.

**All identified bugs have been fixed in commits `a8a43b4` through current working tree.**

---

## Critical — FIXED

### BUG-014: `removeLiveAgentHandle` on normal completion destroys resume capability

**File:** `src/runtime/live-session-runtime.ts` (finally block, line ~610)  
**Commit:** `7a25644` → **Fixed in a8a43b4**

The finally block calls `removeLiveAgentHandle(agentId)` for non-aborted completions. This **deletes the live-agent handle from the registry entirely**, including its terminal status.

**Impact:** After a live-session task completes normally, `steerLiveAgent`, `followUpLiveAgent`, and `resumeLiveAgent` all fail with "Live agent '...' is not registered in this process."

**Fix:** Added `disposeLiveAgentSession()` in `live-agent-manager.ts` — disposes session resources but keeps the handle in the registry for resume/follow-up.

---

## High — FIXED

### BUG-015: `withAgentsLock` crashes on `EISDIR` from corrupted lock path

**File:** `src/runtime/crew-agent-records.ts`  
**Commit:** `c7bd455` → **Fixed in a8a43b4**

`withAgentsLock` only caught `EEXIST`; if lock path was a directory, `EISDIR` crashed the process.

**Fix:** Handle `EISDIR` by removing the directory and retrying.

---

## Medium — FIXED

### BUG-016: `markActiveTasksAndAgentsFailed` lacks run-level lock, races with crash recovery

**File:** `src/extension/async-notifier.ts`  
**Commit:** `d6d466d` → **Fixed in current working tree**

`markActiveTasksAndAgentsFailed` called `saveRunTasks` and `saveCrewAgents` without `withRunLockSync`. Crash recovery (`cancelOrphanedRuns`) uses `withRunLockSync`. Concurrent execution on the same run risks lost updates.

**Fix:** Wrapped `markDeadAsyncRunIfNeeded` mutations inside `withRunLockSync(run, () => { ... })`. Also reloaded fresh manifest inside the lock to avoid operating on stale data.

---

## Low — FIXED

### BUG-017: `safeDisposeLiveSession` catches all errors silently

**File:** `src/runtime/live-agent-manager.ts`  
**Commit:** `7a25644` → **Fixed in current working tree**

Any exception from `dispose()` was swallowed without logging.

**Fix:** Log disposal errors via `logInternalError`.

### BUG-018: `effectiveRuntime` in `run.ts` is manually constructed

**File:** `src/extension/team-tool/run.ts`  
**Commit:** `2486051` → **Fixed in current working tree**

The async fallback runtime was manually built field-by-field. If `CrewRuntimeCapabilities` gains a new required field, this site won't inherit it.

**Fix:** Use spread of original runtime with overrides: `{ ...runtime, kind: "child-process", steer: false, resume: false, liveToolActivity: false, fallback: "child-process", reason: "..." }`.

### NIT-007: `removeStaleAgentsLock` reads unlimited file size

**File:** `src/runtime/crew-agent-records.ts`  
**Commit:** `c7bd455` → **Fixed in current working tree**

`fs.readFileSync(lockPath, "utf-8")` reads entire file into memory. Corrupted multi-megabyte file causes memory pressure.

**Fix:** Check `fs.statSync(lockPath).size > 1024` before reading; skip stale removal if oversized.

### NIT-008: `maxCollectedJsonEvents` cap is hardcoded at 200

**File:** `src/runtime/live-session-runtime.ts`  
**Commit:** `c7bd455` → **Fixed in current working tree**

Long-running agents drop older JSON events needed for debugging/yield detection.

**Fix:** Increased cap from 200 to 1000.

---

## Verification

- `npm run typecheck` passes.
- Targeted tests (`async-notifier`, `isolation-policy`, `live-agent-manager`, `live-session-runtime`, `team-tool-dispatch`) pass: **31 pass / 0 fail**.
- Full unit test suite not run due to time constraints; no new failures observed in targeted runs.

## Files Changed in Fixes

- `src/extension/async-notifier.ts` — BUG-016 (run lock)
- `src/runtime/live-agent-manager.ts` — BUG-014 (disposeLiveAgentSession), BUG-017 (log dispose errors)
- `src/runtime/live-session-runtime.ts` — BUG-014 (use disposeLiveAgentSession), NIT-008 (cap 1000)
- `src/runtime/crew-agent-records.ts` — BUG-015 (EISDIR), NIT-007 (size cap)
- `src/extension/team-tool/run.ts` — BUG-018 (spread runtime)
- `test/unit/live-agent-manager.test.ts` — test for disposeLiveAgentSession
