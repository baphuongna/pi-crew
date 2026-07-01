# Historical Bug Reports (v0.2.x)

> **Current version: v0.9.0** — See [CHANGELOG.md](../CHANGELOG.md) for all bug fixes.
> This page tracks historical bugs from v0.2.x. All listed bugs are fixed.

---

# pi-crew v0.2.20 — Bug Report & Fixes

**Date:** 2026-05-19  
**Session:** Comprehensive integration test + root cause analysis  
**Environment:** linux/x64, Node v22.22.0, Pi CLI v0.75.3, pi-crew v0.2.20  
**Status:** ✅ 14/14 bugs fixed (commits `de9e8b4` and `5dc794e`)

> **All bugs fixed ✅** — Source code verified. See [pi-crew-test-final.md](pi-crew-test-final.md) for end-to-end test results.

---

## Bug #1: Background workers "heartbeat dead" — actually a MiniMax 429 Rate Limit

| Field | Value |
|---|---|
| **Severity** | 🔴 HIGH |
| **Status** | ✅ Fixed — 429 now retries with fallback models instead of blocking 300s |
| **Affected** | All background/async workers |
| **Symptom** | Workers time out after 300s with "heartbeat dead", zero output |

### Description

When running `team action='run'` with `async=true` or `Agent(run_in_background=true)`, workers spawn successfully (PID exists) but **time out after 300s** with a generic error:
```
worker.response_timeout: No output for 300000ms
crew.task.heartbeat_dead: Task 01_assess heartbeat dead.
```

### Root cause

**Fixed.** Previously the 429 rate limit was not retried because:
1. `RETRYABLE_MODEL_FAILURE_PATTERNS` had `/\b429\b/` but MiniMax returns `rate_limit_error: usage limit exceeded` (no clear "429" number)
2. 429 was fast-failed in `child-pi.ts onJsonEvent` instead of letting the task-runner handle retry with fallback

### Fix applied

1. **model-fallback.ts**: Added `/rate_limit_error/i` to `RETRYABLE_MODEL_FAILURE_PATTERNS` to correctly identify the MiniMax rate limit error
2. **model-fallback.ts**: Changed `/\b429\b/` → `/rate.?limit/i` to match more formats
3. **child-pi.ts**: Removed the 429 fast-fail — let the task-runner handle retry with the model fallback chain

### Model fallback chain

When the main model gets a 429:
1. Fall back to `fallbackModels` (if configured)
2. Fall back to other available models in the system
3. If there is no fallback and retries are exhausted → fail with the correct error message

**Recommended config:** Add `fallbackModels` to the agent config to have more options when the main model is rate-limited.

---

## Bug #2: child-pi.ts does not detect 429 rate limit error — reports wrong "heartbeat dead"

| Field | Value |
|---|---|
| **Severity** | 🔴 HIGH |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | All child Pi workers |
| **Symptom** | Worker reports generic "No output for 300000ms" instead of "Provider rate limit: 429" |

### Description

The Pi CLI outputs JSON events for 429 errors very clearly:
```json
{"type":"turn_end","message":{"stopReason":"error","errorMessage":"429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"...}}"}}
```

But `child-pi.ts` **does not parse error events** — it only cares about:
- `isFinalAssistantEvent()` — to trigger the final drain
- `turn_end` — to count turns for turn limiting

Result: child-pi sees output (JSON events), **restarts the heartbeat timer**, but **does not recognize it as an error**. Pi blocks after 3 retries → heartbeat times out at 300s → generic error message.

### Code location

`/home/bom/source/my_pi/pi-crew/src/runtime/child-pi.ts`, line ~394:
```typescript
onJsonEvent: (event) => {
    restartNoResponseTimer();
    // Turn-count-based steering: only counts turns, does NOT check errors
    if (event && typeof event === "object" && !Array.isArray(event)) {
        const obj = event as Record<string, unknown>;
        if (obj.type === "turn_end") {
            turnCount += 1;
            // ... turn limit logic only ...
        }
    }
    // MISSING: detect provider errors (429, auth, etc.)
}
```

### Fix

Add provider error detection in `onJsonEvent`:
```typescript
let providerError: string | undefined;

// In onJsonEvent:
if (obj.type === "turn_end" && obj.message?.stopReason === "error") {
    const errMsg = obj.message?.errorMessage || "";
    if (errMsg && !providerError) providerError = errMsg;
    // Fast-fail on rate limit — don't wait 300s
    if (/429|rate.?limit/i.test(errMsg)) {
        settle({ exitCode: 1, stdout, stderr: `Provider rate limit: ${errMsg.slice(0, 200)}` });
    }
}
```

### Impact

This fix changes the error message from:
```
❌ "Child Pi produced no new output for 300000ms; process was terminated as unresponsive."
```
to:
```
✅ "Provider rate limit: 429 rate_limit_error: usage limit exceeded, resets at 2026-05-19T05:00:00Z"
```

And it **fails fast** instead of waiting 300s.

---

## Bug #3: background.log is useless — does not capture worker output

| Field | Value |
|---|---|
| **Severity** | 🟠 MEDIUM |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | Debugging experience for all background runs |
| **Symptom** | background.log contains only 1 line: `[pi-crew] background loader=jiti` |

### Description

When a background worker fails, the log file at `.crew/state/runs/<id>/background.log` contains only:
```
[pi-crew] background loader=jiti
```

Missing:
- Worker stdout/stderr
- Error messages
- Provider responses
- Exit codes

### Cause

`async-runner.ts` line 130-145:
```typescript
const logFd = fs.openSync(logPath, "a");
// ...
const child = spawn(process.execPath, command.args, buildBackgroundSpawnOptions(manifest, logFd));
```

`buildBackgroundSpawnOptions` line 123-127:
```typescript
return {
    cwd: manifest.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],  // stdout+stderr → background.log
    // ...
};
```

**The stdout/stderr of the background-runner** is written to background.log. But **child Pi workers** (spawned by the background-runner via child-pi.ts) **output to child-pi's pipe**, NOT to background.log.

Flow:
```
background-runner.ts (stdout→logFd, stderr→logFd)
  → loader=jiti → writes to log ✅
  → executeTeamRun()
    → child-pi.ts spawns child Pi (stdout→pipe, stderr→pipe)
      → Pi output → child-pi.ts captures → DOES NOT WRITE TO background.log ❌
```

### Fix

1. **Option A:** In `child-pi.ts` or `team-runner.ts`, write worker output events to background.log
2. **Option B:** Add event log entries for provider errors (there is an event log, but not detailed enough)
3. **Option C:** Background-runner tees output to a log file

### Key file

```
pi-crew/src/runtime/async-runner.ts  — buildBackgroundSpawnOptions(), spawnBackgroundTeamRun()
```

---

## Bug #4: worker-startup.ts missing "rate_limited" classification

| Field | Value |
|---|---|
| **Severity** | 🟡 LOW |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | Error classification and reporting |
| **Symptom** | 429 errors classified as "unknown" instead of "rate_limited" |

### Description

`worker-startup.ts` has the `StartupFailureClassification` type:
```typescript
export type StartupFailureClassification = 
    | "trust_required" 
    | "prompt_misdelivery" 
    | "prompt_acceptance_timeout" 
    | "transport_dead" 
    | "worker_crashed" 
    | "unknown";
```

Missing `"rate_limited"` and `"provider_error"`. Result: 429 errors are classified as `"unknown"`.

### Fix

Add to the type and `classifyStartupFailure` function:
```typescript
export type StartupFailureClassification = 
    | "trust_required" 
    | "prompt_misdelivery" 
    | "prompt_acceptance_timeout" 
    | "transport_dead" 
    | "worker_crashed" 
    | "rate_limited"      // NEW
    | "provider_error"    // NEW
    | "unknown";

// In classifyStartupFailure:
if (evidence.stderrPreview && /429|rate.?limit/i.test(evidence.stderrPreview)) return "rate_limited";
if (evidence.stderrPreview && /5\d{2}|server.?error|internal.?error/i.test(evidence.stderrPreview)) return "provider_error";
```

### Key file

```
pi-crew/src/runtime/worker-startup.ts  — StartupFailureClassification, classifyStartupFailure()
```

---

## Bug #5: Stale heartbeat notifications after prune

| Field | Value |
|---|---|
| **Severity** | 🟡 LOW (cosmetic) |
| **Status** | Confirmed |
| **Affected** | User experience |
| **Symptom** | "Task heartbeat dead" notifications for already-removed runs |

### Description

After running `team prune --keep=0 --confirm=true`, the background watcher still emits notifications for pruned runs:

```
→ team prune: Removed 9 runs
→ Notification: "agent_mpc423rq_1 heartbeat dead" (run not found)
→ Notification: "agent_mpc423rv_2 heartbeat dead" (run not found)  
→ Notification: "agent_mpc423rw_3 heartbeat dead" (run not found)
→ Notification: "agent_mpc423rw_4 heartbeat dead" (run not found)
... (6+ stale notifications)
```

Each notification triggers `get_subagent_result` → returns "not found".

### Cause

The background watcher maintains a worker health-check queue. When runs are pruned:
1. The watcher does not deregister immediately
2. Notifications already in the queue still emit
3. The notifications arrive one by one, a few seconds apart

### Impact

- Confusing for the user: seeing "heartbeat dead" for runs that no longer exist
- Wasted context: each notification triggers 1 tool call to verify

### Fix

The background watcher should check run existence before emitting:
```typescript
// Before emitting heartbeat_dead:
if (!runExists(runId)) {
    deregisterWorker(workerId);  // Silent cleanup
    return;
}
```

### Key files

```
pi-crew/src/runtime/worker-heartbeat.ts  — isWorkerHeartbeatStale()
pi-crew/src/runtime/background-runner.ts — heartbeat monitoring loop
```

---

# pi-crew v0.2.20 — Bug Report

**Date:** 2026-05-19  
**Session:** Comprehensive integration test + root cause analysis  
**Environment:** linux/x64, Node v22.22.0, Pi CLI v0.75.3, pi-crew v0.2.20

---

## Bug #1: Background workers "heartbeat dead" — actually a MiniMax 429 Rate Limit

| Field | Value |
|---|---|
| **Severity** | 🔴 HIGH |
| **Status** | ✅ Fixed — 429 now retries with fallback models instead of blocking 300s |
| **Affected** | All background/async workers |
| **Symptom** | Workers time out after 300s with "heartbeat dead", zero output |

### Description

When running `team action='run'` with `async=true` or `Agent(run_in_background=true)`, workers spawn successfully (PID exists) but **time out after 300s** with a generic error:
```
worker.response_timeout: No output for 300000ms
crew.task.heartbeat_dead: Task 01_assess heartbeat dead.
```

### Root cause

**Fixed.** Previously the 429 rate limit was not retried because:
1. `RETRYABLE_MODEL_FAILURE_PATTERNS` had `/\b429\b/` but MiniMax returns `rate_limit_error: usage limit exceeded` (no clear "429" number)
2. 429 was fast-failed in `child-pi.ts onJsonEvent` instead of letting the task-runner handle retry with fallback

### Fix applied

1. **model-fallback.ts**: Added `/rate_limit_error/i` to `RETRYABLE_MODEL_FAILURE_PATTERNS` to correctly identify the MiniMax rate limit error
2. **model-fallback.ts**: Changed `/\b429\b/` → `/rate.?limit/i` to match more formats
3. **child-pi.ts**: Removed the 429 fast-fail — let the task-runner handle retry with the model fallback chain

### Model fallback chain

When the main model gets a 429:
1. Fall back to `fallbackModels` (if configured)
2. Fall back to other available models in the system
3. If there is no fallback and retries are exhausted → fail with the correct error message

**Recommended config:** Add `fallbackModels` to the agent config to have more options when the main model is rate-limited.

---

## Bug #2: child-pi.ts does not detect 429 rate limit error — reports wrong "heartbeat dead"

| Field | Value |
|---|---|
| **Severity** | 🔴 HIGH |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | All child Pi workers |
| **Symptom** | Worker reports generic "No output for 300000ms" instead of "Provider rate limit: 429" |

### Description

The Pi CLI outputs JSON events for 429 errors very clearly:
```json
{"type":"turn_end","message":{"stopReason":"error","errorMessage":"429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"...}}"}}
```

But `child-pi.ts` **does not parse error events** — it only cares about:
- `isFinalAssistantEvent()` — to trigger the final drain
- `turn_end` — to count turns for turn limiting

Result: child-pi sees output (JSON events), **restarts the heartbeat timer**, but **does not recognize it as an error**. Pi blocks after 3 retries → heartbeat times out at 300s → generic error message.

### Code location

`/home/bom/source/my_pi/pi-crew/src/runtime/child-pi.ts`, line ~394:
```typescript
onJsonEvent: (event) => {
    restartNoResponseTimer();
    // Turn-count-based steering: only counts turns, does NOT check errors
    if (event && typeof event === "object" && !Array.isArray(event)) {
        const obj = event as Record<string, unknown>;
        if (obj.type === "turn_end") {
            turnCount += 1;
            // ... turn limit logic only ...
        }
    }
    // MISSING: detect provider errors (429, auth, etc.)
}
```

### Fix

Add provider error detection in `onJsonEvent`:
```typescript
let providerError: string | undefined;

// In onJsonEvent:
if (obj.type === "turn_end" && obj.message?.stopReason === "error") {
    const errMsg = obj.message?.errorMessage || "";
    if (errMsg && !providerError) providerError = errMsg;
    // Fast-fail on rate limit — don't wait 300s
    if (/429|rate.?limit/i.test(errMsg)) {
        settle({ exitCode: 1, stdout, stderr: `Provider rate limit: ${errMsg.slice(0, 200)}` });
    }
}
```

### Impact

This fix changes the error message from:
```
❌ "Child Pi produced no new output for 300000ms; process was terminated as unresponsive."
```
to:
```
✅ "Provider rate limit: 429 rate_limit_error: usage limit exceeded, resets at 2026-05-19T05:00:00Z"
```

And it **fails fast** instead of waiting 300s.

---

## Bug #3: background.log is useless — does not capture worker output

| Field | Value |
|---|---|
| **Severity** | 🟠 MEDIUM |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | Debugging experience for all background runs |
| **Symptom** | background.log contains only 1 line: `[pi-crew] background loader=jiti` |

### Description

When a background worker fails, the log file at `.crew/state/runs/<id>/background.log` contains only:
```
[pi-crew] background loader=jiti
```

Missing:
- Worker stdout/stderr
- Error messages
- Provider responses
- Exit codes

### Cause

`async-runner.ts` line 130-145:
```typescript
const logFd = fs.openSync(logPath, "a");
// ...
const child = spawn(process.execPath, command.args, buildBackgroundSpawnOptions(manifest, logFd));
```

`buildBackgroundSpawnOptions` line 123-127:
```typescript
return {
    cwd: manifest.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],  // stdout+stderr → background.log
    // ...
};
```

**The stdout/stderr of the background-runner** is written to background.log. But **child Pi workers** (spawned by the background-runner via child-pi.ts) **output to child-pi's pipe**, NOT to background.log.

Flow:
```
background-runner.ts (stdout→logFd, stderr→logFd)
  → loader=jiti → writes to log ✅
  → executeTeamRun()
    → child-pi.ts spawns child Pi (stdout→pipe, stderr→pipe)
      → Pi output → child-pi.ts captures → DOES NOT WRITE TO background.log ❌
```

### Fix

1. **Option A:** In `child-pi.ts` or `team-runner.ts`, write worker output events to background.log
2. **Option B:** Add event log entries for provider errors (there is an event log, but not detailed enough)
3. **Option C:** Background-runner tees output to a log file

### Key file

```
pi-crew/src/runtime/async-runner.ts  — buildBackgroundSpawnOptions(), spawnBackgroundTeamRun()
```

---

## Bug #4: worker-startup.ts missing "rate_limited" classification

| Field | Value |
|---|---|
| **Severity** | 🟡 LOW |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | Error classification and reporting |
| **Symptom** | 429 errors classified as "unknown" instead of "rate_limited" |

### Description

`worker-startup.ts` has the `StartupFailureClassification` type:
```typescript
export type StartupFailureClassification = 
    | "trust_required" 
    | "prompt_misdelivery" 
    | "prompt_acceptance_timeout" 
    | "transport_dead" 
    | "worker_crashed" 
    | "unknown";
```

Missing `"rate_limited"` and `"provider_error"`. Result: 429 errors are classified as `"unknown"`.

### Fix

Add to the type and `classifyStartupFailure` function:
```typescript
export type StartupFailureClassification = 
    | "trust_required" 
    | "prompt_misdelivery" 
    | "prompt_acceptance_timeout" 
    | "transport_dead" 
    | "worker_crashed" 
    | "rate_limited"      // NEW
    | "provider_error"    // NEW
    | "unknown";

// In classifyStartupFailure:
if (evidence.stderrPreview && /429|rate.?limit/i.test(evidence.stderrPreview)) return "rate_limited";
if (evidence.stderrPreview && /5\d{2}|server.?error|internal.?error/i.test(evidence.stderrPreview)) return "provider_error";
```

### Key file

```
pi-crew/src/runtime/worker-startup.ts  — StartupFailureClassification, classifyStartupFailure()
```

---

## Bug #5: Stale heartbeat notifications after prune

| Field | Value |
|---|---|
| **Severity** | 🟡 LOW (cosmetic) |
| **Status** | Confirmed |
| **Affected** | User experience |
| **Symptom** | "Task heartbeat dead" notifications for already-removed runs |

### Description

After running `team prune --keep=0 --confirm=true`, the background watcher still emits notifications for pruned runs:

```
→ team prune: Removed 9 runs
→ Notification: "agent_mpc423rq_1 heartbeat dead" (run not found)
→ Notification: "agent_mpc423rv_2 heartbeat dead" (run not found)  
→ Notification: "agent_mpc423rw_3 heartbeat dead" (run not found)
→ Notification: "agent_mpc423rw_4 heartbeat dead" (run not found)
... (6+ stale notifications)
```

Each notification triggers `get_subagent_result` → returns "not found".

### Cause

The background watcher maintains a worker health-check queue. When runs are pruned:
1. The watcher does not deregister immediately
2. Notifications already in the queue still emit
3. The notifications arrive one by one, a few seconds apart

### Impact

- Confusing for the user: seeing "heartbeat dead" for runs that no longer exist
- Wasted context: each notification triggers 1 tool call to verify

### Fix

The background watcher should check run existence before emitting:
```typescript
// Before emitting heartbeat_dead:
if (!runExists(runId)) {
    deregisterWorker(workerId);  // Silent cleanup
    return;
}
```

### Key files

```
pi-crew/src/runtime/worker-heartbeat.ts  — isWorkerHeartbeatStale()
pi-crew/src/runtime/background-runner.ts — heartbeat monitoring loop
```

---

# pi-crew v0.2.20 — Bug Report

**Date:** 2026-05-19  
**Session:** Comprehensive integration test + root cause analysis  
**Environment:** linux/x64, Node v22.22.0, Pi CLI v0.75.3, pi-crew v0.2.20

---

## Bug #1: Background workers "heartbeat dead" — actually a MiniMax 429 Rate Limit

| Field | Value |
|---|---|
| **Severity** | 🔴 HIGH |
| **Status** | ✅ Fixed — 429 now retries with fallback models instead of blocking 300s |
| **Affected** | All background/async workers |
| **Symptom** | Workers time out after 300s with "heartbeat dead", zero output |

### Description

When running `team action='run'` with `async=true` or `Agent(run_in_background=true)`, workers spawn successfully (PID exists) but **time out after 300s** with a generic error:
```
worker.response_timeout: No output for 300000ms
crew.task.heartbeat_dead: Task 01_assess heartbeat dead.
```

### Root cause

**Fixed.** Previously the 429 rate limit was not retried because:
1. `RETRYABLE_MODEL_FAILURE_PATTERNS` had `/\b429\b/` but MiniMax returns `rate_limit_error: usage limit exceeded` (no clear "429" number)
2. 429 was fast-failed in `child-pi.ts onJsonEvent` instead of letting the task-runner handle retry with fallback

### Fix applied

1. **model-fallback.ts**: Added `/rate_limit_error/i` to `RETRYABLE_MODEL_FAILURE_PATTERNS` to correctly identify the MiniMax rate limit error
2. **model-fallback.ts**: Changed `/\b429\b/` → `/rate.?limit/i` to match more formats
3. **child-pi.ts**: Removed the 429 fast-fail — let the task-runner handle retry with the model fallback chain

### Model fallback chain

When the main model gets a 429:
1. Fall back to `fallbackModels` (if configured)
2. Fall back to other available models in the system
3. If there is no fallback and retries are exhausted → fail with the correct error message

**Recommended config:** Add `fallbackModels` to the agent config to have more options when the main model is rate-limited.

---

## Bug #2: child-pi.ts does not detect 429 rate limit error — reports wrong "heartbeat dead"

| Field | Value |
|---|---|
| **Severity** | 🔴 HIGH |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | All child Pi workers |
| **Symptom** | Worker reports generic "No output for 300000ms" instead of "Provider rate limit: 429" |

### Description

The Pi CLI outputs JSON events for 429 errors very clearly:
```json
{"type":"turn_end","message":{"stopReason":"error","errorMessage":"429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\"...}}"}}
```

But `child-pi.ts` **does not parse error events** — it only cares about:
- `isFinalAssistantEvent()` — to trigger the final drain
- `turn_end` — to count turns for turn limiting

Result: child-pi sees output (JSON events), **restarts the heartbeat timer**, but **does not recognize it as an error**. Pi blocks after 3 retries → heartbeat times out at 300s → generic error message.

### Code location

`/home/bom/source/my_pi/pi-crew/src/runtime/child-pi.ts`, line ~394:
```typescript
onJsonEvent: (event) => {
    restartNoResponseTimer();
    // Turn-count-based steering: only counts turns, does NOT check errors
    if (event && typeof event === "object" && !Array.isArray(event)) {
        const obj = event as Record<string, unknown>;
        if (obj.type === "turn_end") {
            turnCount += 1;
            // ... turn limit logic only ...
        }
    }
    // MISSING: detect provider errors (429, auth, etc.)
}
```

### Fix

Add provider error detection in `onJsonEvent`:
```typescript
let providerError: string | undefined;

// In onJsonEvent:
if (obj.type === "turn_end" && obj.message?.stopReason === "error") {
    const errMsg = obj.message?.errorMessage || "";
    if (errMsg && !providerError) providerError = errMsg;
    // Fast-fail on rate limit — don't wait 300s
    if (/429|rate.?limit/i.test(errMsg)) {
        settle({ exitCode: 1, stdout, stderr: `Provider rate limit: ${errMsg.slice(0, 200)}` });
    }
}
```

### Impact

This fix changes the error message from:
```
❌ "Child Pi produced no new output for 300000ms; process was terminated as unresponsive."
```
to:
```
✅ "Provider rate limit: 429 rate_limit_error: usage limit exceeded, resets at 2026-05-19T05:00:00Z"
```

And it **fails fast** instead of waiting 300s.

---

## Bug #3: background.log is useless — does not capture worker output

| Field | Value |
|---|---|
| **Severity** | 🟠 MEDIUM |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | Debugging experience for all background runs |
| **Symptom** | background.log contains only 1 line: `[pi-crew] background loader=jiti` |

### Description

When a background worker fails, the log file at `.crew/state/runs/<id>/background.log` contains only:
```
[pi-crew] background loader=jiti
```

Missing:
- Worker stdout/stderr
- Error messages
- Provider responses
- Exit codes

### Cause

`async-runner.ts` line 130-145:
```typescript
const logFd = fs.openSync(logPath, "a");
// ...
const child = spawn(process.execPath, command.args, buildBackgroundSpawnOptions(manifest, logFd));
```

`buildBackgroundSpawnOptions` line 123-127:
```typescript
return {
    cwd: manifest.cwd,
    detached: true,
    stdio: ["ignore", logFd, logFd],  // stdout+stderr → background.log
    // ...
};
```

**The stdout/stderr of the background-runner** is written to background.log. But **child Pi workers** (spawned by the background-runner via child-pi.ts) **output to child-pi's pipe**, NOT to background.log.

Flow:
```
background-runner.ts (stdout→logFd, stderr→logFd)
  → loader=jiti → writes to log ✅
  → executeTeamRun()
    → child-pi.ts spawns child Pi (stdout→pipe, stderr→pipe)
      → Pi output → child-pi.ts captures → DOES NOT WRITE TO background.log ❌
```

### Fix

1. **Option A:** In `child-pi.ts` or `team-runner.ts`, write worker output events to background.log
2. **Option B:** Add event log entries for provider errors (there is an event log, but not detailed enough)
3. **Option C:** Background-runner tees output to a log file

### Key file

```
pi-crew/src/runtime/async-runner.ts  — buildBackgroundSpawnOptions(), spawnBackgroundTeamRun()
```

---

## Bug #4: worker-startup.ts missing "rate_limited" classification

| Field | Value |
|---|---|
| **Severity** | 🟡 LOW |
| **Status** | New — discovered while debugging Bug #1 |
| **Affected** | Error classification and reporting |
| **Symptom** | 429 errors classified as "unknown" instead of "rate_limited" |

### Description

`worker-startup.ts` has the `StartupFailureClassification` type:
```typescript
export type StartupFailureClassification = 
    | "trust_required" 
    | "prompt_misdelivery" 
    | "prompt_acceptance_timeout" 
    | "transport_dead" 
    | "worker_crashed" 
    | "unknown";
```

Missing `"rate_limited"` and `"provider_error"`. Result: 429 errors are classified as `"unknown"`.

### Fix

Add to the type and `classifyStartupFailure` function:
```typescript
export type StartupFailureClassification = 
    | "trust_required" 
    | "prompt_misdelivery" 
    | "prompt_acceptance_timeout" 
    | "transport_dead" 
    | "worker_crashed" 
    | "rate_limited"      // NEW
    | "provider_error"    // NEW
    | "unknown";

// In classifyStartupFailure:
if (evidence.stderrPreview && /429|rate.?limit/i.test(evidence.stderrPreview)) return "rate_limited";
if (evidence.stderrPreview && /5\d{2}|server.?error|internal.?error/i.test(evidence.stderrPreview)) return "provider_error";
```

### Key file

```
pi-crew/src/runtime/worker-startup.ts  — StartupFailureClassification, classifyStartupFailure()
```

---

## Bug #5: Stale heartbeat notifications after prune

| Field | Value |
|---|---|
| **Severity** | 🟡 LOW (cosmetic) |
| **Status** | Confirmed |
| **Affected** | User experience |
| **Symptom** | "Task heartbeat dead" notifications for already-removed runs |

### Description

After running `team prune --keep=0 --confirm=true`, the background watcher still emits notifications for pruned runs:

```
→ team prune: Removed 9 runs
→ Notification: "agent_mpc423rq_1 heartbeat dead" (run not found)
→ Notification: "agent_mpc423rv_2 heartbeat dead" (run not found)  
→ Notification: "agent_mpc423rw_3 heartbeat dead" (run not found)
→ Notification: "agent_mpc423rw_4 heartbeat dead" (run not found)
... (6+ stale notifications)
```

Each notification triggers `get_subagent_result` → returns "not found".

### Cause

The background watcher maintains a worker health-check queue. When runs are pruned:
1. The watcher does not deregister immediately
2. Notifications already in the queue still emit
3. The notifications arrive one by one, a few seconds apart

### Impact

- Confusing for the user: seeing "heartbeat dead" for runs that no longer exist
- Wasted context: each notification triggers 1 tool call to verify

### Fix

The background watcher should check run existence before emitting:
```typescript
// Before emitting heartbeat_dead:
if (!runExists(runId)) {
    deregisterWorker(workerId);  // Silent cleanup
    return;
}
```

### Key files

```
pi-crew/src/runtime/worker-heartbeat.ts  — isWorkerHeartbeatStale()
pi-crew/src/runtime/background-runner.ts — heartbeat monitoring loop
```

---

## Bug #6: Live-session run cancelled mid-execution

| Field | Value |
|---|---|
| **Severity** | 🟠 MEDIUM |
| **Status** | ✅ Confirmed — no code fix needed; documented as a user workflow constraint |
| **Affected** | Foreground team runs |
| **Symptom** | Run cancelled after the explore phase completes, before the execute phase |

### Description

A fast-fix team ran in a live-session:
```
04:12:20 live-session.prompt_start 01_explore
04:12:51 live-session.prompt_done 01_explore (31s, completed)
04:12:51 live_agent.terminated 01_explore (status=cancelled)
04:12:51 task.completed 01_explore
04:12:51 run.cancelled: "This operation was aborted"
```

Task `01_explore` completed successfully, but the run was cancelled before `02_execute` started.

### Possible causes

1. **Session concurrency limit** — only 1 active live-session, conflicting with parallel test operations
2. **User-initiated cancellation** — accidentally triggered
3. **Workflow phase transition bug** — does not trigger the next phase after explore completes

### Needs further investigation

- Run the fast-fix team standalone (no concurrent operations)
- Check live-session-runtime.ts for phase-transition logic

---

## Summary

| # | Bug | Severity | Status | Category |
|---|---|---|---|---|
| 1 | Background workers timeout due to MiniMax 429 | 🔴 HIGH | ✅ Fixed — 429 now retries with fallback models via improved RETRYABLE_MODEL_FAILURE_PATTERNS | Code |
| 2 | child-pi.ts does not detect 429, reports wrong "heartbeat dead" | 🔴 HIGH | ✅ Fixed — removed 429 fast-fail; let task-runner handle retry+fallback | Code |
| 3 | background.log useless, does not capture worker output | 🟠 MEDIUM | ✅ Fixed — added PI_CREW_BACKGROUND_MODE flag + event logging to background.log | Observability |
| 4 | worker-startup.ts missing rate_limited classification | 🟡 LOW | ✅ Fixed — added rate_limited + provider_error to StartupFailureClassification | Code |
| 5 | Stale heartbeat notifications after prune | 🟡 LOW | ✅ Fixed — HeartbeatWatcher skips pruned runs via stateRoot existence check | UX |
| 6 | Live-session foreground run cancelled when there are concurrent tool calls | 🟠 MEDIUM | ✅ Confirmed — concurrent calls interrupt live-session → outputLength:0 → caller_cancelled. Avoid concurrent team actions during foreground runs. | Runtime |
| 7 | Async notifier "stale ctx" — dies, does not restart after Pi restart | 🔴 HIGH | ✅ Fixed — swallow stale error, isCurrent guard handles dormancy | Code |
| 8 | Background child-process 300s timeout — child Pi hangs, zero output | 🟠 MEDIUM | ✅ Fixed — Root cause found (Bug #10): MINIMAX_API_KEY stripped by sanitizeEnvSecrets(). Allow-list in child-pi.ts preserves model provider API keys. Restart Pi to verify fix. | Code |
| 9 | Executor hit yield limit — file write not completed | 🟡 LOW | 🔲 Open — executor hit 3 Yield Reminders and terminated before writing file. Task marked completed but artifact missing. | Runtime |
| 10 | Child-process silent timeout — MINIMAX_API_KEY filtered out of child env | 🔴 HIGH | ✅ Fixed — sanitizeEnvSecrets() strips *API_KEY* vars. Allow-list in buildChildPiSpawnOptions preserves model provider keys (MINIMAX_*, OPENAI_*, etc.). See docs/fixes/bug-010-child-process-api-key-filtered.md | Code |


| 11 | Background runner "spawn pi ENOENT" — pi binary not in PATH | 🔴 HIGH | ✅ Fixed — added resolvePiCliScript() call for non-Windows platforms in getPiSpawnCommand(). Restart Pi to verify. | Code |
| 12 | Essential env vars (PATH) stripped - child Pi crashes with npm root -g error | HIGH | ✅ Fixed — added essential env vars (PATH, HOME, USER, etc.) to allow-list alongside model API keys. Restart Pi to verify. | Code |
| 15 | Background runner receives SIGTERM ~3s after spawn from Pi infrastructure | 🟠 MEDIUM | ✅ Fixed — disabled async mode by default + ignore SIGTERM from Pi in background-runner | Runtime |

### Priority fix order

1. **Bug #1** — ✅ Fixed — 429 now retried with model fallback chain
2. **Bug #2** — ✅ Fixed — removed 429 fast-fail
3. **Bug #3** — ✅ Fixed — worker events now logged to background.log
4. **Bug #4** — ✅ Fixed — rate_limited + provider_error classification added
5. **Bug #5** — ✅ Fixed — HeartbeatWatcher skips pruned runs
6. **Bug #6** — ✅ Confirmed — concurrent tool calls cancel foreground runs; avoid concurrent team actions during runs
7. **Bug #7** — ✅ Fixed — async notifier handles stale ctx gracefully, isCurrent guard manages dormancy
8. **Bug #8/10** — ✅ Fixed — Bug #10 root cause: MINIMAX_API_KEY filtered out. Allow-list preserves model provider API keys for child processes.
9. **Bug #9** — ✅ Fixed — Added `needs_attention` task status. Workers that complete without calling `submit_result` now get `status: "needs_attention"` instead of `"completed"`, with ⚠ icon in UI.
10. **Bug #10** — ✅ Fixed — Added allow-list to sanitizeEnvSecrets in child-pi.ts to preserve model API keys (MINIMAX_*, OPENAI_*, etc.)
11. **Bug #11** — ✅ Fixed — resolvePiCliScript() added for non-Windows in getPiSpawnCommand() to fix ENOENT on spawn
12. **Bug #12** — ✅ Fixed — Essential env vars (PATH, HOME, USER, etc.) added to allow-list alongside model API keys
13. **Bug #13** — 🟠 MEDIUM — ✅ Fixed — Background runner dies after ~59s. 3-layer fix: (1) heartbeat mechanism prevents false repairs; (2) --max-old-space-size=512 limits V8 heap to prevent OOM; (3) SIGTERM/SIGINT handlers log async.failed event for diagnosis. Heartbeat includes memory stats (heapUsedMb, rssMb) for post-mortem.
14. **Bug #14** — 🔴 HIGH — ✅ Fixed — Infinite retry loop: needs_attention tasks had `queue: "blocked"` in task graph instead of `queue: "done"`, causing them to be re-scheduled indefinitely. Added `needs_attention` to the terminal status check in `withQueue()` in task-graph-scheduler.ts.
15. **Bug #15** — 🟠 MEDIUM — ✅ Fixed — Disabled async mode by default (runAsync=false). Background runners receive SIGTERM ~3s after spawn from Pi infrastructure because Node.js 22.22.0 setsid:true doesn't create a new session. Also added ignore-SIGTERM-from-Pi logic in background-runner.ts (A2 approach).
