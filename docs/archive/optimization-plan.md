# pi-crew Optimization Plan: coding-agent Integration

> **Status note (2026-06-22):** Dated 2026-05-28 — verify against current code before acting. Some items may already be implemented.

**Date:** 2026-05-28  
**Based on:** 133 coding-agent commits (May 2026), direct source analysis  
**Goal:** Implement 4 optimization opportunities for pi-crew

---

## Implementation Order

| # | Optimization | Priority | Effort | Files to Change |
|---|--------------|----------|--------|-----------------|
| 1 | Child Process Exit Handling | P0 | Medium | `src/runtime/child-pi.ts` |
| 2 | `excludeFromContext` Flag | P1 | Small | `src/runtime/child-pi.ts`, `src/config/types.ts` |
| 3 | Edit Tool Patch Capture | P2 | Small | `src/runtime/task-runner.ts` |
| 4 | Session ID Alignment | P2 | Small | `src/state/crew-init.ts`, `src/runtime/child-pi.ts` |

---

## Optimization 1: Child Process Exit Handling (P0)

### Problem

When a child Pi process exits unexpectedly (OOM, crash, SIGKILL), pi-crew:
- ✅ Captures exit code
- ✅ Logs to event log
- ❌ **Does NOT reject pending operations** (if any are in-flight)
- ❌ **Does NOT include stderr context** in error reporting
- ❌ **No clear error message** for unexpected exits

### Current Behavior (child-pi.ts ~line 625)

```typescript
// Only emits lifecycle event, doesn't track pending state
input.onLifecycleEvent?.({ type: "exit", pid: child.pid, exitCode: code, ts: ... });

// settle() handles exit but with limited context
settle({
  exitCode: finalExitCode,
  stdout,
  stderr,
  ...(timeoutError ? { error: timeoutError.error } : {}),
  ...
});
```

### Reference: pi's RpcClient approach (rpc-client.ts ~line 89)

```typescript
childProcess.once("exit", (code, signal) => {
  const error = this.createProcessExitError(code, signal);
  this.exitError = error;
  this.rejectPendingRequests(error);  // ← key missing in pi-crew
});
```

### Implementation

**File:** `src/runtime/child-pi.ts`

#### Step 1: Add pending operations tracker

After line ~416 (`let turnCount = 0;`), add:

```typescript
// Track in-flight operations for proper rejection on unexpected exit
interface PendingOperation {
  id: string;
  type: "prompt" | "steer" | "json_event";
  startedAt: number;
}
const pendingOperations = new Map<string, PendingOperation>();
let operationIdCounter = 0;

const startOperation = (type: PendingOperation["type"]): string => {
  const id = `op-${++operationIdCounter}`;
  pendingOperations.set(id, { id, type, startedAt: Date.now() });
  return id;
};

const rejectPendingOperations = (error: Error): void => {
  for (const [id, op] of pendingOperations) {
    logInternalError(
      "child-pi.pending-operation-rejected",
      error,
      `opId=${id} type=${op.type} elapsed=${Date.now() - op.startedAt}ms`,
    );
  }
  pendingOperations.clear();
};

const completeOperation = (id: string): void => {
  pendingOperations.delete(id);
};
```

#### Step 2: Track operations in onJsonEvent

In the `onJsonEvent` callback (line ~453), add:

```typescript
onJsonEvent: (event) => {
  restartNoResponseTimer();
  
  // Track json events as operations
  const eventOpId = startOperation("json_event");
  
  try {
    // ... existing turn-count logic ...
    
    if (event && typeof event === "object" && !Array.isArray(event)) {
      const obj = event as Record<string, unknown>;
      if (obj.type === "turn_end") {
        // ...
      }
    }
    
    // Complete the operation after processing
    completeOperation(eventOpId);
  } catch (err) {
    completeOperation(eventOpId);
    throw err;
  }
  
  input.onJsonEvent?.(event);
  // ...
}
```

#### Step 3: Enhance exit handling

Replace the exit handler (line ~604):

```typescript
// OLD:
child.on("exit", (code) => {
  if (child.pid) {
    activeChildProcesses.delete(child.pid);
    clearHardKillTimer(child.pid);
  }
  try {
    input.onLifecycleEvent?.({ type: "exit", pid: child.pid, exitCode: code, ts: new Date().toISOString() });
  } catch (err) {
    logInternalError("child-pi.on-lifecycle-event", err, `event=exit, pid=${child.pid}`);
  }
  // ...
});

// NEW:
child.on("exit", (code, signal) => {
  if (child.pid) {
    activeChildProcesses.delete(child.pid);
    clearHardKillTimer(child.pid);
  }
  
  // Build comprehensive exit error
  const isUnexpectedExit = !childExited && !settled && !responseTimeoutHit && !abortRequested;
  const exitError = isUnexpectedExit
    ? new Error(
        `Child Pi process exited unexpectedly (code=${code ?? "null"} signal=${signal ?? "null"}). ` +
        `Stderr: ${stderr.slice(-1000) || "(none)"}`,
      )
    : null;
  
  // Reject any pending operations with context
  if (exitError) {
    rejectPendingOperations(exitError);
  }
  
  try {
    input.onLifecycleEvent?.({
      type: "exit",
      pid: child.pid,
      exitCode: code,
      ts: new Date().toISOString(),
      error: exitError?.message,  // Include error context
      stderrExcerpt: stderr.slice(-500),  // Last 500 chars of stderr
    });
  } catch (err) {
    logInternalError("child-pi.on-lifecycle-event", err, `event=exit, pid=${child.pid}`);
  }
  
  // ... rest unchanged ...
});
```

#### Step 4: Enhance error handler

Update the `child.on("error")` handler (line ~571):

```typescript
// OLD:
child.on("error", (error) => {
  settle({ exitCode: null, stdout, stderr, error: error.message });
});

// NEW:
child.on("error", (error) => {
  // Reject pending operations with process error context
  const processError = new Error(
    `Child Pi process error: ${error.message}. Stderr: ${stderr.slice(-500) || "(none)"}`,
  );
  rejectPendingOperations(processError);
  
  try {
    input.onLifecycleEvent?.({
      type: "spawn_error",
      pid: child.pid,
      error: processError.message,
      ts: new Date().toISOString(),
      stderrExcerpt: stderr.slice(-500),
    });
  } catch (err) {
    logInternalError("child-pi.on-lifecycle-event", err, `event=error, pid=${child.pid}`);
  }
  
  settle({ exitCode: null, stdout, stderr, error: processError.message });
});
```

#### Step 5: Update ChildPiLifecycleEvent type

**File:** `src/runtime/child-pi.ts` (type definition around line ~109)

```typescript
export interface ChildPiLifecycleEvent {
  type: "spawned" | "spawn_error" | "response_timeout" | "final_drain" | "hard_kill" | "exit" | "close";
  pid?: number;
  exitCode?: number | null;
  error?: string;  // NEW: error message for unexpected exits
  stderr?: string;
  stderrExcerpt?: string;  // NEW: last N chars of stderr for error context
  ts: string;
}
```

### Test Plan

**File:** `test/unit/child-pi-exit.test.ts` (new)

```typescript
import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import { runChildPi } from "../../src/runtime/child-pi.ts";

// Mock child-pi for exit testing
describe("Child process exit handling", () => {
  it("rejects pending operations on unexpected exit", async () => {
    // Create a mock child that exits immediately with non-zero code
    const mockChild = {
      pid: 99999,
      stdin: { write: () => {}, on: () => {} },
      stdout: { on: () => {}, pause: () => {}, resume: () => {}, removeAllListeners: () => {} },
      stderr: { on: () => {} },
      on: (event: string, cb: (...args: unknown[]) => void) => {
        if (event === "exit") cb(1, null);
        return mockChild;
      },
      kill: () => {},
    };
    
    // Verify that pending operations are rejected
    // with stderr context included in error
  });

  it("includes stderr excerpt in exit error", async () => {
    // Child exits with crash message in stderr
    // Verify exit error includes stderr content
  });

  it("does NOT reject pending operations on graceful exit", async () => {
    // Child exits with code 0 after normal completion
    // Verify no error is logged for pending ops
  });
});
```

---

## Optimization 2: `excludeFromContext` Flag (P1)

### Problem

pi now supports `excludeFromContext: true` on bash commands — output is not included in agent context. pi-crew could leverage this for noisy commands.

### Use Cases

1. **Intermediate/staging commands** — commands that prepare data but don't need to be remembered
2. **Debug commands** — `ls`, `find`, `grep` that are useful but consume context tokens
3. **Status checks** — health checks, version checks that are transient

### Implementation

#### Step 1: Add config flag

**File:** `src/config/types.ts`

```typescript
export interface PiTeamsAutonomousConfig {
  // ... existing fields ...
  
  /**
   * When true, certain agent commands (ls, find, status checks) will be
   * marked with `excludeFromContext: true` to reduce context overhead.
   * Default: false
   */
  excludeContextBash?: boolean;
}
```

#### Step 2: Add CLI option to schema

**File:** `src/schema/team-tool-schema.ts`

In the `run` action schema, add:

```typescript
excludeContextBash?: {
  type: "boolean",
  description: "Mark certain commands as excludeFromContext to reduce context tokens",
  default: false,
};
```

#### Step 3: Pass to child-pi

**File:** `src/runtime/child-pi.ts`

Add to `ChildPiRunInput` (around line ~133):

```typescript
export interface ChildPiRunInput {
  // ... existing fields ...
  
  /** Pass to pi to mark certain commands as context-excluded */
  excludeContextBash?: boolean;
}
```

#### Step 4: Document in register.ts

**File:** `src/extension/register.ts`

Add the config to documentation.

### Impact Assessment

**Before:** All bash output consumes context tokens.

**After:** Selected commands don't count against context.

**Estimation:** 10-20% context token reduction for typical tasks with many `ls`/`find` operations.

---

## Optimization 3: Edit Tool Patch Capture (P2)

### Problem

pi's edit tool now returns both `diff` (display) and `patch` (standard unified format). pi-crew currently captures only `diff`.

### Benefits

1. **Rollback capability** — can use `git apply` on patch
2. **Precise change tracking** — patch is deterministic
3. **Better visualization** — can render with standard diff tools

### Implementation

#### Step 1: Update artifact structure

**File:** `src/runtime/task-runner.ts`

Currently (line ~882):
```typescript
const diffArtifact = workspace.worktreePath
  ? writeArtifact(manifest.artifactsRoot, {
      kind: "diff",
      relativePath: `diffs/${task.id}.diff`,
      content: buildDiffFromArtifacts(task, manifest),
      producer: task.id,
    })
  : undefined;
```

**Change:** Also capture `patch` artifacts from tool results.

Add after line ~882:

```typescript
// Capture unified patches from edit tool results
const extractPatchFromToolResult = (events: unknown[]): string => {
  for (const event of events) {
    if (typeof event !== "object" || event === null) continue;
    const obj = event as Record<string, unknown>;
    if (obj.type === "tool_result") {
      const content = obj.content as Array<Record<string, unknown>> | undefined;
      if (content) {
        const patchBlock = content.find(
          (c: Record<string, unknown>) => (c as Record<string, unknown>).type === "text" && 
            typeof (c as Record<string, unknown>).text === "string" &&
            ((c as Record<string, unknown>).text as string).includes("--- a/")
        );
        if (patchBlock) {
          return (patchBlock as Record<string, unknown>).text as string;
        }
      }
    }
  }
  return "";
};

const patchArtifact = workspace.worktreePath && parsedOutput?.jsonEvents
  ? writeArtifact(manifest.artifactsRoot, {
      kind: "patch",
      relativePath: `patches/${task.id}.patch`,
      content: extractPatchFromToolResult(parsedOutput.jsonEvents as unknown[]),
      producer: task.id,
    })
  : undefined;
```

#### Step 2: Include in result bundle

Around line ~1105, add `patchArtifact` to artifact list:

```typescript
return {
  manifest,
  tasks,
  artifacts: [
    resultArtifact,
    logArtifact,
    // ... existing ...
    ...(patchArtifact ? [patchArtifact] : []),
  ],
};
```

### Test Plan

**File:** `test/unit/edit-patch-capture.test.ts` (new)

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("Edit tool patch capture", () => {
  it("extracts unified patch from tool results", async () => {
    // Mock jsonEvents with tool_result containing patch
    const patch = extractPatchFromToolResult([{
      type: "tool_result",
      content: [{
        type: "text",
        text: `--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n line1\n+newLine\n line2\n`
      }]
    }]);
    
    assert.ok(patch.includes("--- a/"));
    assert.ok(patch.includes("+++ b/"));
    assert.ok(patch.includes("@@"));
  });
});
```

---

## Optimization 4: Session ID Alignment (P2)

### Problem

pi-crew run IDs and pi session IDs are not aligned. Cross-referencing is difficult.

### Current State

- **pi-crew run ID:** `run-{uuid}` format (e.g., `run-01J8X...`)
- **pi session ID:** uuidv7 format (e.g., `01J8Y...`)

### Implementation

#### Step 1: Add session ID to manifest

**File:** `src/state/crew-init.ts`

When creating a run manifest, pass a named session to pi:

```typescript
import { assertValidSessionId } from "../utils/session-utils.ts";  // New

// In createRunManifest() or wherever session is created
const sessionId = `crew-${manifest.runId.replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}`;

// Validate that it's safe for pi
try {
  assertValidSessionId(sessionId);
} catch {
  // Fallback to uuid
  sessionId = `crew-${Date.now().toString(36)}`;
}

// Store in manifest
manifest.sessionId = sessionId;
```

**File:** `src/utils/session-utils.ts` (new)

```typescript
/**
 * Validate session ID format per pi's requirements.
 * Format: ^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$
 */
export function assertValidSessionId(id: string): void {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
    throw new Error(
      `Invalid session id: must be non-empty, alphanumeric with '-', '_', '.' and start/end with alphanumeric`,
    );
  }
}

/**
 * Convert a pi-crew run ID to a valid pi session ID.
 */
export function toPiSessionId(runId: string): string {
  // Strip non-alphanumeric, lowercase, prefix with "crew-"
  const sanitized = runId.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return `crew-${sanitized.slice(0, 16)}`;
}
```

#### Step 2: Pass to child-pi

**File:** `src/runtime/child-pi.ts`

In `ChildPiRunInput`:

```typescript
export interface ChildPiRunInput {
  // ... existing fields ...
  
  /** Session ID for pi session naming (aligns with pi-crew run ID) */
  sessionId?: string;
}
```

In the `runChildPi` function, add to `buildCommand`:

```typescript
const buildCommand = (): string => {
  const args = [
    input.cwd,
    "--agent", input.agent.name,
    "--goal", input.task,
  ];
  
  if (input.sessionId) {
    args.push("--session-id", input.sessionId);
  }
  
  // ... rest
};
```

#### Step 3: Read session ID in register.ts

**File:** `src/extension/register.ts`

Document the session ID format for users who want to resume pi sessions.

### Benefits

1. **Easy cross-reference:** User sees `crew-run-abc123` in both pi and pi-crew
2. **Named resume:** `pi --session crew-run-abc123` works
3. **Debugging:** Match logs between pi and pi-crew by session ID
4. **Persistence:** Sessions persist in `.pi/sessions/` with human-readable names

---

## Rollout Plan

### Phase 1: Child Process Exit Handling (Week 1)

1. Add `PendingOperation` tracker
2. Update `ChildPiLifecycleEvent` type
3. Enhance exit/error handlers
4. Add tests

**Risk:** Low — internal changes, no API change.

### Phase 2: Session ID Alignment (Week 1-2)

1. Create `session-utils.ts`
2. Update `crew-init.ts` to generate session IDs
3. Pass to `child-pi.ts`
4. Document in `register.ts`

**Risk:** Low — additive feature.

### Phase 3: `excludeFromContext` (Week 2-3)

1. Add config flag to types
2. Update schema
3. Pass to child-pi
4. Document

**Risk:** Medium — user-facing config change.

### Phase 4: Edit Patch Capture (Week 3-4)

1. Update `task-runner.ts` to extract patches
2. Add artifact generation
3. Add tests

**Risk:** Low — additive feature.

---

## Success Metrics

| Optimization | Metric | Target |
|--------------|--------|--------|
| Child Exit Handling | % of unexpected exits with error context | 100% |
| Session ID Alignment | % of runs with named sessions | 100% |
| `excludeFromContext` | Context token reduction for typical task | 10-20% |
| Edit Patch Capture | % of edit operations with patch artifact | 100% |

---

## Files Summary

| File | Changes |
|------|---------|
| `src/runtime/child-pi.ts` | Pending ops tracker, exit handling, session ID, excludeContext |
| `src/runtime/task-runner.ts` | Patch artifact capture |
| `src/state/crew-init.ts` | Session ID generation |
| `src/utils/session-utils.ts` | New: session ID utilities |
| `src/config/types.ts` | `excludeContextBash` flag |
| `src/schema/team-tool-schema.ts` | CLI option for exclude context |
| `src/extension/register.ts` | Documentation |
| `test/unit/child-pi-exit.test.ts` | New: exit handling tests |
| `test/unit/edit-patch-capture.test.ts` | New: patch capture tests |