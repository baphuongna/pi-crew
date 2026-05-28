# coding-agent Changes: Optimization Opportunities for pi-crew

**Date:** 2026-05-28  
**Source:** Direct analysis of `packages/coding-agent/` commits (133 commits in May 2026)  
**Focus:** Changes that can help pi-crew work better, faster, or more reliably

---

## Executive Summary

**133 coding-agent commits in May 2026.** Many are internal fixes, but several directly impact pi-crew's child-process spawning and RPC communication. This doc focuses on actionable optimization opportunities.

---

## 1. HIGH IMPACT — Direct pi-crew Benefit

### A. RPC Backpressure Handling (`d0d1d8ed`, `ce0e801d`)

**Problem:** Large bash output could block RPC stdout, causing backpressure and hangs.

**Solution:** pi now uses async stdout writes with backpressure signaling:

```typescript
// rpc-mode.ts
const output = async (obj: ...): Promise<void> => {
  await writeRawStdout(serializeJsonLine(obj));
};
```

**pi-crew relevance:** `child-pi.ts` already has backpressure handling (line ~560 `stdout.resume()` / `stdout.pause()`). **This fix improves the underlying child process's stdout handling.** When pi-crew spawns a child Pi, that child now handles large output better.

**Optimization opportunity:** Consider adding explicit backpressure acknowledgment in `child-pi.ts` — currently it uses `stdout.pause()` but doesn't explicitly signal to pi when it's ready to resume. pi now handles this internally.

### B. Child Process Exit Handling (`e007fcd0`)

**Problem:** When a child process exits unexpectedly, pending RPC requests would hang forever.

**Solution:** RpcClient now tracks child process exit and rejects pending requests:

```typescript
// rpc-client.ts
childProcess.once("exit", (code, signal) => {
  const error = this.createProcessExitError(code, signal);
  this.exitError = error;
  this.rejectPendingRequests(error);
});
```

**pi-crew relevance:** **Critical.** pi-crew's `child-pi.ts` spawns child Pi processes. If the child exits unexpectedly (OOM, crash, SIGKILL), pi-crew should:
1. Capture the exit code/signal
2. Reject any pending operations
3. Log the error with stderr context

**Current gap:** `child-pi.ts` captures exit codes but doesn't propagate stderr context when rejecting pending work.

### C. Bash Output Truncation Fix (`f9530678`)

**Problem:** Bash truncation counted lines incorrectly when output ended with a newline.

**Fix:** `OutputAccumulator` now correctly tracks `completedLines` vs `totalLines`:

```typescript
// output-accumulator.ts
this.completedLines = 0;
this.totalLines = 0;
this.hasOpenLine = false;
// ...
const lines = splitLinesForCounting(content);
// If content ends with \n, pop the empty final line
```

**pi-crew relevance:** pi-crew shows task output in `team action='status'`. If the output is truncated, the line count is now accurate. **No code change needed** — this is internal to pi.

### D. Session ID Naming (`52dc08c1`)

**New feature:** Users can specify explicit session IDs with `--session-id <name>`.

**pi-crew relevance:** Could enable named sessions for:
- `team action='run'` with `inheritContext: true` → pass named session instead of JSON
- Debugging: label sessions by task/team
- Cross-reference: match pi-crew run IDs to pi session IDs

**Implementation:** `assertValidSessionId(id)` validates format (`^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`).

### E. Compact Read Output (`373bd128`)

**New feature:** Large file reads are collapsed by default, with "Show more" toggle.

**pi-crew relevance:** Tasks that read large files now show cleaner output in logs/UI. **No code change needed.**

---

## 2. MEDIUM IMPACT — Optimization Opportunities

### A. `excludeFromContext` Flag (`61babc24`)

**New RPC command:**
```typescript
{ type: "bash", command: "ls -la", excludeFromContext: true }
```

When `excludeFromContext: true`, the bash command output is **not included in the agent's context**. This prevents noisy commands (e.g., `ls -la` in large directories) from consuming context tokens.

**pi-crew opportunity:** pi-crew could add a `--no-context` flag to `team action='run'` that maps to `excludeFromContext: true` for certain agent operations. Currently, all agent operations contribute to context.

**Implementation would be in:** `child-pi.ts` → when spawning, pass `excludeFromContext: true` for non-essential commands.

### B. Async Tool Operations (`e9146a5f`, `ba09f1c9`)

**Change:** Tools (read, write, edit) now use async operations instead of sync.

**pi-crew relevance:** Tasks that run many file operations will be faster (non-blocking I/O). **No code change needed.**

### C. Edit Tool Unified Patch (`60a55a23`)

**New feature:** Edit tool results now include a `patch` field (standard unified diff):

```typescript
// edit.ts
export interface EditToolDetails {
  diff: string;         // Display-oriented diff
  patch: string;        // Standard unified patch
  firstChangedLine?: number;
}
```

**pi-crew opportunity:** `team action='status'` could show the unified patch instead of display diff, enabling:
- More precise change tracking
- `git apply` compatibility for rollback
- Better diff visualization in logs

**Implementation would be in:** `task-runner.ts` → capture `toolResult.details.patch` instead of `toolResult.details.diff`.

### D. HTTP Idle Timeout (`849f9d9c`)

**Change:** Coding-agent now configures HTTP idle timeout for network requests.

**pi-crew relevance:** When pi-crew tasks make HTTP requests (e.g., calling external APIs), the idle timeout prevents hanging connections. **No code change needed** — this is internal to pi's HTTP client.

### E. Retry Marking for Agent End Events (`c685b273`)

**Change:** When an agent retries a turn, the `agent_end` event is now marked as a retry.

**pi-crew relevance:** `team action='status'` could show retry count. Currently, pi-crew tracks task retries via `run_recovery` hook but doesn't surface retry reasons.

---

## 3. LOW IMPACT — Nice to Know

### A. Theme Detection (`f4f0ac7a`, `088987b2`)

Update notes shown on startup. Themes listed by content name.

**No action needed.**

### B. OpenCode Session Headers (`42379a37`)

Session headers for OpenCode provider (Qwen models).

**No action needed.**

### C. Clipboard Sidecar (`3f89350c`)

Bun binaries now include clipboard helper.

**No action needed.**

### D. Path Handling Fix (`c100620b`)

Corrected path resolution for pattern matching.

**No action needed.**

---

## 4. Optimization Roadmap (Priority Order)

### Priority 1: Child Process Exit Handling

**Gap:** `child-pi.ts` captures exit code but doesn't reject pending work with stderr context.

**Current code:** `child-pi.ts` line ~635
```typescript
const wasGraceAborted = softLimitReached && turnCount >= ...
```

**Missing:** When child exits unexpectedly, propagate `exitError` to any pending operations.

**Fix:**
```typescript
// In child-pi.ts, handle unexpected exit
childProcess.once("exit", (code, signal) => {
  const exitError = new Error(
    `Agent process exited (code=${code} signal=${signal}). Stderr: ${stderr}`
  );
  // Reject any pending operations
  // Log exitError to event log
});
```

### Priority 2: `excludeFromContext` Integration

**New capability in pi:** Commands can opt out of context.

**pi-crew opportunity:** Add config flag to `team action='run'`:
```
team action='run' goal='...' exclude-context-bash=true
```

This would mark intermediate/staging bash commands as `excludeFromContext: true`.

**Implementation:**
1. Add `excludeContextBash?: boolean` to `PiTeamsAutonomousConfig`
2. In `child-pi.ts`, wrap commands with `excludeFromContext` flag

### Priority 3: Edit Tool Patch Capture

**Current:** `task-runner.ts` captures `toolResult.details.diff` for reporting.

**Opportunity:** Capture `toolResult.details.patch` for:
- Rollback capability (`git apply` patch)
- Precise change tracking
- Better visualization

**Implementation:** Change `task-runner.ts` line ~1114 to read `details.patch` instead of `details.diff`.

### Priority 4: Session ID Alignment

**New capability:** `--session-id <name>` for explicit session naming.

**pi-crew opportunity:** Align pi session IDs with pi-crew run IDs:
```
pi --session-id "crew-run-{runId}"
```

This would enable:
- Easy cross-reference between pi sessions and pi-crew runs
- Named resume: `pi --session crew-run-abc` resumes a specific run
- Better debugging in `.crew/sessions/`

---

## 5. Key Files to Watch

| File | Significance |
|------|-------------|
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | RPC protocol — pi-crew's child communicates via this |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | Client that handles child process lifecycle |
| `packages/coding-agent/src/core/session-manager.ts` | Session naming, fork, resume |
| `packages/coding-agent/src/core/tools/bash.ts` | Bash execution with backpressure |
| `packages/coding-agent/src/core/tools/output-accumulator.ts` | Output truncation logic |
| `packages/coding-agent/src/core/tools/edit.ts` | Edit tool with unified patch |

---

## 6. Summary

| Category | Finding | Action |
|----------|---------|--------|
| **Critical** | Child exit handling improved | Verify `child-pi.ts` rejects pending work on unexpected exit |
| **Opportunity** | `excludeFromContext` flag | Add to `team action='run'` config |
| **Opportunity** | Edit tool unified patch | Capture in `task-runner.ts` for rollback |
| **Nice-to-have** | Session ID alignment | Align pi session IDs with pi-crew run IDs |
| **No action** | Bash truncation fix | Already benefits pi-crew (internal) |
| **No action** | Compact reads | Already benefits pi-crew (internal) |
| **No action** | Async tools | Already benefits pi-crew (internal) |

**Primary recommendation:** Implement Priority 1 (child exit handling) and Priority 2 (excludeFromContext) in `child-pi.ts`.