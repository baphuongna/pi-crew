# Performance Plan: Cold Context + Subagent Streaming

## Problem

Subagent execution feels slower than the main session. Root causes:

1. **Cold context**: `inheritContext` defaults to `false` — subagents start with
   ZERO parent context, must re-explore/re-read files the main session already has.
   Each subagent does redundant LLM work.

2. **No streaming feedback**: `onJsonEvent` is plumbed end-to-end but only feeds
   `overflowTracker`. The user sees a black box until the task completes. Even
   though the LLM runs at the same speed, perceived latency is much higher.

## Phase 1: Cold Context Fix (Quick Win)

### 1A. Enable inheritContext by default

**Problem**: `buildParentContext()` builds parent context (last 20 messages)
but `inheritContext` defaults to `false`, so it's never used.

**Files**:
- `src/ui/settings-overlay.ts:330` — change `"runtime.inheritContext": false` → `true`
- `src/extension/team-tool/handle-settings.ts:17` — same change
- `src/config/config.ts:707` — verify parse default

**Risk**: parent context may contain large content (file reads, bash output)
that bloats the subagent's token budget. Must add a size guard (1B below).

### 1B. Add token budget to buildParentContext()

**Problem**: `buildParentContext()` takes last 20 messages with no size limit.
A parent session with large file reads could inject 50K+ tokens into every
subagent — more than the task itself.

**File**: `src/extension/team-tool/context.ts:50`

**Change**:
```typescript
const MAX_PARENT_CONTEXT_CHARS = 12_000; // ~3K tokens, ~$0.01 per task

export function buildParentContext(ctx: TeamContext): string | undefined {
    // ... existing logic ...
    // NEW: accumulate until budget, then stop
    let totalChars = 0;
    const budgeted: string[] = [];
    for (const part of parts.reverse()) { // most recent first
        if (totalChars + part.length > MAX_PARENT_CONTEXT_CHARS) break;
        budgeted.unshift(part);
        totalChars += part.length;
    }
    // ... build header + budgeted parts ...
}
```

**Why reverse?** Most recent context is most relevant. If budget is hit,
drop oldest messages first.

### 1C. Filter noisy content from parent context

**Problem**: bash output and file reads in parent context are noisy and
rarely useful for subagents. User instructions and assistant reasoning are.

**File**: `src/extension/team-tool/context.ts`

**Change**: In the message extraction loop, skip or truncate:
- `[Assistant]` messages longer than 500 chars → truncate to first 200 chars
- Messages that look like file dumps (start with `````, >1000 chars) → skip
- Keep `[User]` messages and `[Summary]` entries in full

### 1D. Exclude capability-locked agents

**File**: `src/runtime/goal-evaluator.ts:204` — already has `inheritContext: false`

**Verify**: capability-locked agents (goal-judge) must NOT inherit context.
This is already correct but add a test to lock it in.

### Phase 1 Tests
- `test/unit/build-parent-context.test.ts`:
  - Returns undefined when no session branch
  - Includes last N messages up to budget
  - Truncates at MAX_PARENT_CONTEXT_CHARS
  - Drops oldest messages when over budget
  - Filters noisy content (file dumps)
- `test/unit/inherit-context-default.test.ts`:
  - Default config has inheritContext=true
  - goal-evaluator explicitly disables

---

## Phase 2: Subagent Streaming (Medium Effort)

### 2A. Surface tool execution to widget (already partially wired)

**Current**: `progress-tracker.ts:54` handles `tool_execution_start/end` →
emits to `crewEventBus` → widget updates. But this only works for
**live-session** runtime (subscribes to AgentSession events).

For **child-process** runtime, `onJsonEvent` fires but isn't connected to
`progress-tracker`.

**File**: `src/extension/register.ts:1473`

**Change**: Connect `onJsonEvent` to progress tracker:
```typescript
onJsonEvent: (taskId, runId, event) => {
    const record = event as Record<string, unknown>;
    const eventType = typeof record.type === "string" ? record.type : undefined;
    if (eventType) lifecycleState.overflowTracker?.feedEvent(taskId, runId, eventType);
    // NEW: forward to progress tracker for child-process runtime
    if (eventType === "tool_execution_start" || eventType === "tool_execution_end") {
        progressTracker.handleWorkerEvent(taskId, runId, record);
    }
},
```

**File**: `src/runtime/progress-tracker.ts` — add `handleWorkerEvent()` method
that mirrors `handleEvent()` but for child-process JSON events.

### 2B. Stream assistant text deltas to widget

**Current**: Child-process emits `message` events with assistant text, but
they're only stored in transcript — never shown live.

**File**: `src/runtime/child-pi.ts:1277` — `onJsonEvent` callback

**Change**: Extract assistant text from `message` events and forward:
```typescript
// In the onJsonEvent handler, detect assistant text:
if (record.type === "message" || record.type === "message_end") {
    const message = record.message;
    if (message?.role === "assistant") {
        const text = extractTextContent(message.content);
        if (text) {
            progressTracker.handleAssistantText(taskId, runId, text);
        }
    }
}
```

**File**: `src/runtime/progress-tracker.ts` — add `handleAssistantText()` that
emits a `crewEventBus` event with partial text.

**File**: Widget renderer — show last N chars of assistant text in the
active-runs widget.

### 2C. Auto-open live sidebar for foreground subagents

**Current**: `installLiveSidebar` only opens when `autoOpenDashboard: true`
AND `autoOpenDashboardForForegroundRuns: true` AND placement is "right".

**Change**: For foreground `ctx.agent()` calls (not background team runs),
auto-open a compact progress view showing:
```
┌─ agent: explorer (agent_abc123) ──────────┐
│ tool: grep "security" src/                 │
│                                            │
│ Found 3 matches in auth.ts...              │
│ (partial assistant text streaming here)    │
└────────────────────────────────────────────┘
```

This gives the user real-time feedback without a full dashboard.

**Files**:
- `src/extension/registration/subagent-tools.ts` — trigger sidebar on spawn
- `src/extension/registration/ui.ts` — compact sidebar variant

### Phase 2 Tests
- `test/unit/progress-tracker-worker.test.ts`:
  - handleWorkerEvent processes tool_execution_start
  - handleWorkerEvent processes tool_execution_end
  - handleAssistantText emits crewEventBus event
- Integration: child-process agent shows tool calls in widget

---

## Phase 3: Inline Streaming (Future, Complex)

### Goal: Stream subagent output directly into the main conversation

Instead of a separate widget/sidebar, show subagent progress inline:
```
> ctx.agent("Read package.json and list dependencies")

  [agent: explorer] Reading package.json...
  [agent: explorer] Found 24 dependencies
  
  Result: The project has 24 dependencies including...
```

**Challenge**: Pi's TUI architecture expects one conversation stream. Injecting
subagent events requires either:
- `ctx.ui.notify()` for each event (noisy, no persistence)
- A custom TUI component that overlays the conversation (complex)
- Writing progress to the conversation transcript as system messages (hacky)

**Defer** until Phase 1+2 validated.

---

## Implementation Order

| Step | Effort | Impact | Files |
|------|--------|--------|-------|
| 1A: Enable inheritContext default | 30 min | HIGH | settings-overlay, handle-settings |
| 1B: Token budget guard | 1 hr | HIGH | context.ts |
| 1C: Filter noisy content | 1 hr | MEDIUM | context.ts |
| 2A: Wire onJsonEvent → progress | 2 hr | MEDIUM | register.ts, progress-tracker.ts |
| 2B: Stream assistant text | 3 hr | HIGH | child-pi.ts, progress-tracker.ts, widget |
| 2C: Auto-open compact sidebar | 3 hr | MEDIUM | subagent-tools.ts, ui.ts |
| 1D+tests | 2 hr | — | test files |

**Total**: ~12.5 hours. Phase 1 (1A+1B+1C) = 2.5 hrs, highest ROI.

## Risks

1. **Token bloat**: inheritContext=true with large parent sessions could
   slow down subagent LLM calls (more input tokens). Mitigated by 1B budget.

2. **Context leakage**: parent context might contain sensitive info (API keys
   in bash output). Mitigated by 1C filtering + existing env sanitization.

3. **Widget performance**: streaming every text delta could cause excessive
   TUI re-renders. Mitigate with throttling (update widget max 2x/second).

4. **Live-session vs child-process parity**: Phase 2 changes must work for
   BOTH runtimes. Live-session already subscribes to AgentSession events;
   child-process needs the onJsonEvent bridge.
