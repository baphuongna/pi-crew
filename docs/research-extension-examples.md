# Research: Extension Examples & Patterns

> Ngày: 2026-04-29 | Read-only research | Source: `source/pi-mono/packages/coding-agent/examples/extensions/`

## 1. Example Catalog (86 files, 60+ extensions)

### 1.1 Sorted by relevance to pi-crew

| Priority | Example | Relevance |
|---|---|---|
| ⭐⭐⭐ | `subagent/` | Most similar to pi-crew: child Pi spawning, parallel, chain |
| ⭐⭐⭐ | `custom-compaction.ts` | Hook compaction — useful for preserving run state |
| ⭐⭐⭐ | `event-bus.ts` | Cross-extension communication pattern |
| ⭐⭐⭐ | `plan-mode/` | State persistence, dynamic tools, widget management |
| ⭐⭐⭐ | `structured-output.ts` | `terminate: true` — save LLM turns |
| ⭐⭐ | `handoff.ts` | Context transfer to new session |
| ⭐⭐ | `dynamic-tools.ts` | Register tools at runtime |
| ⭐⭐ | `permission-gate.ts` | Gate dangerous operations |
| ⭐⭐ | `trigger-compact.ts` | Proactive compaction monitoring |
| ⭐⭐ | `send-user-message.ts` | sendUserMessage pattern |
| ⭐ | `dirty-repo-guard.ts` | Guard against uncommitted changes |
| ⭐ | `model-status.ts` | Model status in footer |
| ⭐ | `confirm-destructive.ts` | Confirm destructive operations |

## 2. Deep Analysis of Key Examples

### 2.1 subagent/ — The Reference Implementation

**Files:**
- `index.ts` (~530 dòng): Main tool with execute + render
- `agents.ts` (~130 dòng): Agent discovery (user/project scope)

**Architecture:**
```
subagent tool
  ├── Single: runSingleAgent() → spawn pi --mode json -p
  ├── Parallel: mapWithConcurrencyLimit(tasks, 4, runSingleAgent)
  └── Chain: sequential loop with {previous} placeholder
```

**Key patterns:**
- Agent discovery: `discoverAgents(cwd, scope)` — scans `.md` files with YAML frontmatter
- Child process: `getPiInvocation()` detects current runtime (node/bun/pi binary)
- Streaming: `onUpdate` callback for partial results during execution
- Render: `renderCall()` + `renderResult()` with collapsed/expanded views
- Abort: AbortSignal propagated to child process

**What pi-crew does better:**
- Durable state (manifest, tasks, events) instead of in-memory only
- Team/workflow abstraction instead of flat agent list
- Task graph with DAG dependencies instead of linear chain
- Async background runner with PID tracking
- Policy engine for limits/retry/escalation
- Mailbox for inter-task communication
- Worktree isolation per task

**What pi-crew could adopt from this:**
- `terminate: true` on final results (not used in example either, but available)
- `renderCall/Result` custom rendering patterns
- `mapWithConcurrencyLimit` pattern (pi-crew already has similar)

### 2.2 custom-compaction.ts — Custom Compaction

**Pattern:**
```typescript
pi.on("session_before_compact", async (event, ctx) => {
  // 1. Get preparation data
  const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId } = event.preparation;

  // 2. Use different model for summarization (cheaper)
  const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");

  // 3. Custom prompt
  const summary = await complete(model, { messages: [...] }, { apiKey, signal });

  // 4. Return custom compaction result
  return {
    compaction: { summary, firstKeptEntryId, tokensBefore }
  };
});
```

**Relevance to pi-crew:**
- Can use cheap model to summarize completed tasks
- Can protect foreground runs from being compacted mid-execution
- Can store structured artifact index in compaction `details`

### 2.3 event-bus.ts — Cross-Extension Communication

**Pattern:**
```typescript
// Extension A: emit events
pi.events.emit("my:notification", { message: "hello", from: "ext-a" });

// Extension B: listen
pi.events.on("my:notification", (data) => {
  currentCtx?.ui.notify(`Event from ${data.from}: ${data.message}`);
});
```

**Relevance to pi-crew:**
- Already used for internal events (`subagent.stuck-blocked`)
- Could publish structured events for other extensions to consume:
  - `pi-crew:run:completed`
  - `pi-crew:subagent:completed`
  - `pi-crew:run:failed`

### 2.4 plan-mode/ — State Persistence + Dynamic Tools

**Key patterns:**

State persistence:
```typescript
// Save
pi.appendEntry("plan-mode", { enabled, todos, executing });

// Restore on session_start
const entries = ctx.sessionManager.getEntries();
const state = entries
  .filter(e => e.type === "custom" && e.customType === "plan-mode")
  .pop()?.data;
```

Dynamic tools:
```typescript
// Switch between tool sets
if (planModeEnabled) {
  pi.setActiveTools(["read", "bash", "grep", "find", "ls"]);
} else {
  pi.setActiveTools(["read", "bash", "edit", "write"]);
}
```

Tool call gate:
```typescript
pi.on("tool_call", async (event) => {
  if (planModeEnabled && event.toolName === "bash") {
    if (!isSafeCommand(event.input.command)) {
      return { block: true, reason: "..." };
    }
  }
});
```

**Relevance to pi-crew:**
- `pi.appendEntry` pattern for cross-session run awareness
- `pi.setActiveTools` could be used to restrict tools during team runs
- `tool_call` gate for destructive team actions

### 2.5 structured-output.ts — terminate: true

**Pattern:**
```typescript
async execute(_toolCallId, params) {
  return {
    content: [{ type: "text", text: "Done" }],
    details: { headline, summary, actionItems },
    terminate: true,  // ← No follow-up LLM turn needed
  };
}
```

**Relevance to pi-crew:**
- `Agent` tool results could use `terminate: true` when background run queued
- `get_subagent_result` could terminate when result is final
- `team` tool status/list/recommend actions could terminate

### 2.6 handoff.ts — Context Transfer to New Session

**Pattern:**
```typescript
// 1. Extract conversation context
const messages = ctx.sessionManager.getBranch()
  .filter(e => e.type === "message")
  .map(e => e.message);

// 2. Generate focused prompt
const prompt = await complete(model, { systemPrompt, messages }, { apiKey });

// 3. Create new session with pre-filled editor
await ctx.newSession({
  parentSession: currentSessionFile,
  withSession: async (replacementCtx) => {
    replacementCtx.ui.setEditorText(prompt);
  },
});
```

**Relevance to pi-crew:**
- When a task in a team run needs isolated context, could handoff to new session
- Parent session tracking via `parentSession`

### 2.7 permission-gate.ts — Dangerous Operation Gate

**Pattern:**
```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName !== "bash") return;
  if (isDangerousPattern(event.input.command)) {
    const choice = await ctx.ui.select("Allow?", ["Yes", "No"]);
    if (choice !== "Yes") {
      return { block: true, reason: "Blocked by user" };
    }
  }
});
```

**Relevance to pi-crew:**
- Gate destructive team actions (delete, forget, prune)
- Only allow with explicit `confirm: true` parameter

### 2.8 trigger-compact.ts — Proactive Compaction

**Pattern:**
```typescript
pi.on("turn_end", (_event, ctx) => {
  const usage = ctx.getContextUsage();
  if (usage?.tokens && usage.tokens > THRESHOLD) {
    ctx.compact({ customInstructions: "..." });
  }
});
```

**Relevance to pi-crew:**
- Monitor context during long team runs
- Auto-compact before hitting overflow errors
- Use compact's callback to track state

## 3. Pattern Summary

### 3.1 Patterns pi-crew already implements well

| Pattern | pi-crew implementation |
|---|---|
| Child Pi spawning | `SubagentManager` + `spawn.ts` with full process management |
| Parallel execution | `mapConcurrent` in team runner |
| State persistence | Durable file-based (manifest, tasks, events, artifacts) |
| Widget rendering | `CrewWidget`, `LiveRunSidebar`, `Powerbar` |
| Lifecycle hooks | `session_start`, `session_before_switch`, `session_shutdown` |
| Config merge | `loadConfig` with user/project priority |
| Abort propagation | `AbortController` trees in foreground runs |

### 3.2 Patterns pi-crew could adopt

| Pattern | Current status | Recommendation |
|---|---|---|
| `terminate: true` | ❌ Not used | Add to Agent/get_subagent_result |
| `session_before_compact` hook | ❌ Not hooked | Cancel compact during foreground runs |
| Custom compaction model | ❌ Not used | Use Haiku/Gemini Flash for task summaries |
| `pi.events` publish | ⚠️ Internal only | Add public structured events |
| `pi.appendEntry` | ❌ Not used | Cross-session run references |
| `tool_call` permission gate | ❌ Not gated | Gate destructive team actions |
| Config-driven tool registration | ❌ Always all | Register tools per config |
| Working indicator | ❌ Widget only | Use `ctx.ui.setWorkingIndicator` |
| Session name auto-set | ❌ Manual only | Auto-name from team run context |
| `ctx.compact()` proactive | ❌ No monitoring | Monitor + auto-compact at threshold |

## 4. Example: Complete Tool with terminate + render

This shows a hypothetical optimized pi-crew Agent tool:

```typescript
// OPTIMIZED Agent tool pattern
const AgentTool = defineTool({
  name: "Agent",
  label: "Agent",
  description: "Launch a real pi-crew subagent...",
  parameters: Type.Object({
    prompt: Type.String(),
    description: Type.String(),
    subagent_type: Type.String(),
    run_in_background: Type.Optional(Type.Boolean()),
  }),
  async execute(_id, params, signal, _onUpdate, ctx) {
    // ... spawn subagent ...
    if (params.run_in_background) {
      return {
        content: [{ type: "text", text: `Agent queued. ID: ${record.id}` }],
        details: { agentId: record.id, status: "queued" },
        terminate: true,  // ← No need for LLM follow-up
      };
    }
    await record.promise;
    const output = readResult(record);
    return {
      content: [{ type: "text", text: output }],
      details: { agentId: record.id, status: record.status },
      terminate: true,  // ← Final result, save LLM turn
    };
  },
  renderResult(result, { expanded }, theme) {
    // Custom rendering with colored status icons
    // Collapsed/expanded views
    // Usage stats display
  },
});
```
