# pi-subagents3 Deep Analysis — Patterns for pi-crew In-Process Runtime

## Executive Summary

After deep reading of `source/pi-subagents3/`, this document catalogs every production-ready pattern that pi-crew should adopt for its in-process (live-session) runtime. pi-subagents3 is a mature single-agent system with many features pi-crew's team orchestration currently lacks.

---

## 1. Promise-Based Agent Lifecycle ✅ DONE

### pi-subagents3 Pattern
```typescript
class AgentManager {
    spawn(...) {
        const record = { ... };
        record.promise = runAgent(...).then(...);
        return id;
    }
    async spawnAndWait(...) {
        const id = this.spawn(...);
        const record = this.agents.get(id)!;
        await record.promise;  // ← Await actual completion
        return record;
    }
    async waitForAll() {
        while (true) {
            const pending = [...this.agents.values()]
                .filter(r => r.status === "running" || r.status === "queued")
                .map(r => r.promise);
            if (pending.length === 0) break;
            await Promise.allSettled(pending);
        }
    }
}
```

### pi-crew Implementation
**Status:** Done in `src/runtime/run-tracker.ts` (`a88e552`)
- `registerRunPromise()`, `resolveRunPromise()`, `waitForRun()`
- Fast path (disk terminal), medium path (foreground Promise), fallback (exponential backoff poll)

---

## 2. Soft Turn Limit + Graceful Steering ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
let turnCount = 0;
const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
let softLimitReached = false;
let aborted = false;

session.subscribe((event) => {
    if (event.type === "turn_end") {
        turnCount++;
        if (maxTurns != null) {
            if (!softLimitReached && turnCount >= maxTurns) {
                softLimitReached = true;
                session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
            } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
                aborted = true;
                session.abort();
            }
        }
    }
});
```

**Key insight:** Instead of hard cutoff, it steers the agent to wrap up. Only aborts after `graceTurns` (default 5) additional turns. This produces much better output than sudden termination.

**Settings:** `defaultMaxTurns`, `graceTurns` — persisted per project.

### pi-crew Gap
- `maxTurns` exists but no soft-limit steering mechanism
- No `graceTurns` concept
- Hard abort at maxTurns causes incomplete responses

### Implementation Sketch
Add to `live-session-runtime.ts`:
```typescript
const turnCount = 0;
const maxTurns = agent.maxTurns ?? config.defaultMaxTurns;
const graceTurns = config.graceTurns ?? 5;
let softLimitReached = false;

session.subscribe((event) => {
    if (event.type === "turn_end") {
        turnCount++;
        if (maxTurns != null && !softLimitReached && turnCount >= maxTurns) {
            softLimitReached = true;
            session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
            session.abort();
        }
    }
});
```

---

## 3. Persistent Agent Memory ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
// Memory scopes: "user" | "project" | "local"
const memoryDir = resolveMemoryDir(agentName, scope, cwd);
// Agent gets a persistent directory and MEMORY.md instructions
// Agent can read/write/edit memory files using its tools
```

**Memory block injected into system prompt:**
```markdown
# Agent Memory
You have a persistent memory directory at: {memoryDir}/
Memory scope: {scope}
This memory persists across sessions. Use it to build up knowledge over time.
```

**Features:**
- MEMORY.md index file (max 200 lines)
- Frontmatter format for structured memories
- Read-only mode for agents without write/edit tools
- Symlink attack prevention (`isSymlink`, `safeReadFile`)

### pi-crew Gap
- No persistent memory per agent across runs
- Agents start fresh every time
- No MEMORY.md concept

---

## 4. Context % Indicator ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
    if (!session) return null;
    try { return session.getSessionStats().contextUsage?.percent ?? null; }
    catch { return null; }
}
```

**Used in:**
- Dashboard widget showing "Context: 67%" to warn before compaction
- Scheduling decisions (don't schedule if context is critically full)
- UI streaming display

### pi-crew Gap
- No context usage percentage display
- No early warning before compaction
- Dashboard doesn't show "how full is the context window"

---

## 5. Skill Preloading (vs. Skill Path Passing) ⬜ PARTIAL IN PI-CREW

### pi-subagents3 Pattern
```typescript
// Load skill content INTO the prompt instead of passing paths to child
const loaded = preloadSkills(skills, effectiveCwd);
if (loaded.length > 0) {
    extras.skillBlocks = loaded;
}

// In prompt:
// # Preloaded Skill: skill-name
// <skill content here>
```

**Advantages over path passing:**
- No child-process skill loader dependency
- Content is visible to LLM immediately (no extra tool call)
- Works with `noSkills: true` (skills already in prompt)
- Graceful degradation: missing skills show "(Skill not found)" note instead of crash

### pi-crew Gap
- pi-crew passes `--skill <path>` to child Pi process
- Child has to load skills separately
- For live-session, skills should be preloaded into prompt

---

## 6. Batch Notification Grouping (GroupJoinManager) ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
class GroupJoinManager {
    registerGroup(groupId, agentIds);
    onAgentComplete(record) {
        // Hold results until ALL agents in group complete
        // OR timeout fires (default 30s)
        // Then deliver ONE consolidated notification
    }
}
```

**Join modes:** `async` (individual), `group` (batch), `smart` (heuristic)

**Benefits:**
- 10 parallel research agents → 1 notification instead of 10
- Reduces parent context disruption
- Configurable timeout for stragglers

### pi-crew Gap
- Each completed task sends individual notification
- No batch grouping for parallel tasks
- Parent gets spammed with completion messages

---

## 7. Scheduling (SubagentScheduler) ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
class SubagentScheduler {
    addJob({ name, schedule: "0 0 9 * * 1", subagent_type, prompt });
    // Supports: cron | interval ("5m") | once ("+10m" | ISO)
    // Persistence: session-scoped ScheduleStore with PID-locked atomic writes
    // Bypasses concurrency queue when firing
}
```

**Features:**
- Croner library for cron expressions
- Session-scoped persistence (survives `/resume`, resets on `/new`)
- PID-based file locking with stale lock detection
- Master switch: `schedulingEnabled` setting

### pi-crew Gap
- No scheduling capability at all
- No cron/interval/once job support
- No session-scoped persistent job store

---

## 8. Settings Persistence with Sanitization ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
// Global: ~/.pi/agent/subagents.json (defaults, never written here)
// Project: <cwd>/.pi/subagents.json (overrides)

export interface SubagentsSettings {
    maxConcurrent?: number;
    defaultMaxTurns?: number;
    graceTurns?: number;
    defaultJoinMode?: JoinMode;
    schedulingEnabled?: boolean;
}

function sanitize(raw: unknown): SubagentsSettings {
    // Drop invalid fields, apply ceilings
    // maxConcurrent: 1-1024
    // defaultMaxTurns: 0-10000 (0 = unlimited)
    // graceTurns: 1-1000
}
```

**Features:**
- Merged load: global defaults + project overrides
- Sanitization drops garbage silently
- Settings events: `subagents:settings_loaded`, `subagents:settings_changed`
- Toast formatting for persist success/failure

### pi-crew Gap
- pi-crew has `CrewConfig` but no project-local `.pi/crew.json` persistence
- No sanitization with ceilings
- No settings change events

---

## 9. Usage Tracking (Survives Compaction) ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
export type LifetimeUsage = { input: number; output: number; cacheWrite: number };

// Accumulated via message_end events (survives compaction)
session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
        const u = event.message.usage;
        if (u) options.onAssistantUsage?.({
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
        });
    }
});
```

**Key design:** `getSessionTokens()` resets at compaction (upstream replaces messages array), but `LifetimeUsage` survives because it's independently accumulated.

**cacheRead deliberately excluded** — summing across turns counts the cached prefix N times (issue #38).

### pi-crew Gap
- pi-crew tracks usage per task but doesn't survive compaction
- No lifetime usage across sessions
- No `cacheWrite`/`cacheRead` distinction logic

---

## 10. Worktree Isolation ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
    // git worktree add --detach <temp-path> HEAD
    // Returns { path, branch }
}

export function cleanupWorktree(cwd, worktree, description) {
    // No changes → remove worktree
    // Changes → git add -A, git commit, create branch, remove worktree
    // Returns { hasChanges, branch }
}
```

**Features:**
- Strict: fails loud if not a git repo (no silent fallback)
- Crash recovery: `pruneWorktrees()` on dispose
- Branch naming: `pi-agent-{agentId}`, with timestamp suffix if conflict

### pi-crew Gap
- pi-crew has worktree support but less robust
- No automatic branch creation for changes
- No worktree cleanup on error

---

## 11. Model Resolution (Fuzzy + Availability) ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
export function resolveModel(input: string, registry: ModelRegistry): any | string {
    // 1. Exact match "provider/modelId" — only if available (has auth)
    // 2. Fuzzy match with scoring:
    //    - exact id match (100)
    //    - id contains query (60-90)
    //    - name contains query (40-60)
    //    - all parts present (20)
    // 3. No match → return error message with available models list
}
```

### pi-crew Gap
- pi-crew passes model string directly to child Pi
- No fuzzy resolution
- No availability check before spawn

---

## 12. Agent Config System (Defaults + Override) ⬜ PARTIAL IN PI-CREW

### pi-subagents3 Pattern
```typescript
const DEFAULT_AGENTS = new Map([
    ["general-purpose", { extensions: true, skills: true, promptMode: "append" }],
    ["Explore", { builtinToolNames: ["read", "bash", "grep", "find", "ls"], model: "anthropic/claude-haiku-...", promptMode: "replace" }],
    ["Plan", { builtinToolNames: ["read", "bash", "grep", "find", "ls"], promptMode: "replace" }],
]);

// User-defined .md files with same name override defaults
// Resolution: explicit option > config.model > parent model
```

**Features:**
- `builtinToolNames` — restrict tool set per agent type
- `disallowedTools` — denylist (removed even if extensions include them)
- `promptMode: "replace" | "append"` — full control vs. parent clone
- `extensions: true | string[] | false` — selective extension inheritance
- `skills: true | string[] | false` — selective skill inheritance
- `isolated: boolean` — no extension tools

### pi-crew Gap
- pi-crew has agent configs but no `builtinToolNames` per agent
- No `disallowedTools` concept
- No `promptMode` (always append-ish)
- `extensions`/`skills` are boolean only (no selective)

---

## 13. Streaming Output (Real-Time Transcript) ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
// AgentRecord has:
outputFile?: string;
outputCleanup?: () => void;

// In spawn:
const outputFile = path.join(stateDir, `${id}.output.md`);
const stream = createWriteStream(outputFile);
// Subscribe to session events, write text deltas to stream
// onComplete: flush stream, cleanup
```

**Benefits:**
- Real-time transcript file for long-running agents
- Parent can `tail -f` the file for progress
- `outputCleanup` ensures stream is closed

### pi-crew Gap
- pi-crew writes artifacts after task completes
- No real-time streaming transcript during task execution
- Parent must wait for completion to see output

---

## 14. Cross-Extension RPC ⬜ NOT IN PI-CREW

### pi-subagents3 Pattern
```typescript
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
    const unsubPing = handleRpc(events, "subagents:rpc:ping", () => ({ version: PROTOCOL_VERSION }));
    const unsubSpawn = handleRpc(events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
        const ctx = getCtx();
        return { id: manager.spawn(pi, ctx, type, prompt, options ?? {}) };
    });
    const unsubStop = handleRpc(events, "subagents:rpc:stop", ({ agentId }) => {
        if (!manager.abort(agentId)) throw new Error("Agent not found");
    });
    return { unsubPing, unsubSpawn, unsubStop };
}
```

**Features:**
- Per-request scoped reply channels: `${channel}:reply:${requestId}`
- Envelope: `{ success: true, data? } | { success: false, error }`
- Protocol versioning

### pi-crew Gap
- pi-crew has no RPC for external extensions to spawn team runs
- No protocol versioning
- Extensions can only use `team` tool

---

## 15. Concurrency Queue with Bypass ⬜ PARTIAL IN PI-CREW

### pi-subagents3 Pattern
```typescript
spawn(..., { isBackground: true, bypassQueue: false }) {
    if (runningBackground >= maxConcurrent) {
        record.status = "queued";
        queue.push({ id, args });
        return id;
    }
    startAgent(id, record, args);
}

// When agent completes:
this.runningBackground--;
this.drainQueue();  // Start next queued agent

// Scheduled jobs bypass queue:
manager.spawn(..., { bypassQueue: true });  // Always starts immediately
```

### pi-crew Status
- pi-crew has `SubagentManager` with `runningBackground` counter
- Has queue logic but no `bypassQueue` flag
- No `drainQueue()` — queued agents may not auto-start

---

## 16. Parent Signal Wiring ⬜ PARTIAL IN PI-CREW

### pi-subagents3 Pattern
```typescript
// In spawn:
if (options.signal) {
    const onParentAbort = () => this.abort(id);
    options.signal.addEventListener("abort", onParentAbort, { once: true });
    detachParentSignal = () => options.signal!.removeEventListener("abort", onParentAbort);
}

// Cleanup in .then() and .catch():
detach();  // Remove listener to avoid leak
```

### pi-crew Status
- pi-crew passes `signal` to `runTeamTask` and `runLiveSessionTask`
- But no explicit detach cleanup after completion
- Listener may leak

---

## Priority Implementation Roadmap

### P0 — Immediate (next commit)
1. **Soft turn limit + grace steering** — Best output quality improvement
2. **Context % indicator** — Dashboard enhancement, low effort

### P1 — This Week
3. **Skill preloading** — Required for live-session to work without child-process skill loader
4. **Persistent agent memory** — Major differentiator, medium effort
5. **Usage tracking (survives compaction)** — Metrics accuracy

### P2 — Next Sprint
6. **Batch notification grouping** — Parallel run UX
7. **Settings persistence with sanitization** — Config robustness
8. **Streaming output transcript** — Real-time progress visibility
9. **Worktree auto-branch** — Isolation improvement

### P3 — Future
10. **Scheduling** — New feature category
11. **Cross-extension RPC** — Ecosystem integration
12. **Model fuzzy resolution** — UX polish
