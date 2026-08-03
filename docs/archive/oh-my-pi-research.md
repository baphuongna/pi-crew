# Research: oh-my-pi v15.0.0 — Features Applicable to pi-crew

> Date: 2026-05-13
> Source: `D:/my/my_project/source/oh-my-pi` (v15.0.0)
> Purpose: Find features that can be ported into pi-crew

---

## 1. Feature: Hashline Engine (`hashline/`)

### Purpose
Fully replace the old hashline with a new engine supporting:
- Line-level content addressing (hash each line)
- Semantic anchors (not just line numbers but content hashes)
- Recovery mode (recover from crash state)
- Conflict resolution (3-way merge)
- Streaming diff output

### How it works

**Core types** (`hashline/types.ts`):
```typescript
export type Anchor = { line: number; hash: string; contentHint?: string };
export type HashlineCursor =
  | { kind: "bof" }
  | { kind: "eof" }
  | { kind: "before_anchor"; anchor: Anchor }
  | { kind: "after_anchor"; anchor: Anchor };
export type HashlineEdit =
  | { kind: "insert"; cursor: HashlineCursor; text: string; lineNum: number; index: number }
  | { kind: "delete"; anchor: Anchor; lineNum: number; index: number; oldAssertion?: string };
```

**Key modules:**
- `hash.ts` (694→) — Line hashing with bigram index
- `parser.ts` (192 lines) — Parse hashline input
- `apply.ts` (716 lines) — Apply edits with validation
- `recovery.ts` (72 lines) — Recovery from crash state
- `execute.ts` (267 lines) — Execute hashline commands
- `diff.ts` / `diff-preview.ts` — Streaming diff

### Potential application to pi-crew

**Option A — Use directly (if oh-my-pi splits hashline into a separate package):**
- pi-crew needs to edit files in worktrees
- The hashline engine could help detect conflicts when multiple agents edit the same file

**Option B — Conflict detection (already have `conflict-detect.ts`):**
- See the next feature

**Effort: HIGH** — hashline is strongly coupled to oh-my-pi internals (ToolSession, LSP batch request, etc.)

### Risk/Dependency
- Requires the oh-my-pi package or a fork
- Strong dependency on oh-my-pi's tool execution model

---

## 2. Feature: Conflict Detection & Resolution (`conflict-detect.ts`)

### Purpose
Detect git merge conflicts (<<<<<<, =======, >>>>>>>) in file content without extra I/O. Each conflict block is assigned a stable id; the agent can resolve it by writing to `conflict://<id>`.

### How it works

```typescript
export interface ConflictBlock {
  startLine: number;      // 1-indexed line of <<<<<<<
  separatorLine: number;  // 1-indexed line of =======
  endLine: number;        // 1-indexed line of >>>>>>>
  baseLine?: number;      // 1-indexed line of ||||||| (diff3 only)
  oursLabel?: string;
  baseLabel?: string;
  theirsLabel?: string;
  oursLines: string[];
  baseLines?: string[];
  theirsLines: string[];
}

// scanConflictLines: scan array of lines (no extra I/O)
// registerConflict: assign stable id via ConflictHistory
// resolveConflict: write chosen content via conflict://<id>
```

**Workflow:**
1. `read` collects lines from disk
2. `scanConflictLines` inspects for `<<<<<<<` / `=======` / `>>>>>>>` markers
3. Each completed block → `ConflictHistory` (stable id)
4. Read output returns with a footer containing conflict ids
5. Agent calls `write({ path: "conflict://<id>", content })` to resolve

**Key insight:** Marker shape must be strict — column-0, exact prefix length, followed by EOL or a single space + label.

### Potential application to pi-crew

**HIGH VALUE for pi-crew:**
- When multiple agents edit the same file in a worktree, conflicts can occur
- Conflict detection lets the agent recognize and resolve them automatically

**Implementation approach:**
1. Fork `conflict-detect.ts` (license OK — MIT)
2. Integrate into pi-crew's file read path
3. Register conflicts into `LiveAgentHandle.activity` or the artifact store
4. Provide a `conflict://` protocol in the write tool
5. Add a `detect-conflicts` tool for agents

**Effort: MEDIUM** — standalone module, can be copied + adapted

### Risk/Dependency
- Need to handle the `conflict://` protocol in the write tool
- Need to update the read tool to detect and report conflicts

---

## 3. Feature: ACP Client Bridge (`acp-client-bridge.ts`)

### Purpose
A bridge between oh-my-pi's internal ClientBridge interface and the ACP (Agent Client Protocol) SDK. Allows tools (read/write/bash/edit) to route through the client when the client has the capabilities.

### How it works

```typescript
export interface ClientBridgeCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
  requestPermission: boolean;
}

export interface ClientBridge {
  capabilities: ClientBridgeCapabilities;
  readTextFile?: (params: { path: string; line?: number; limit?: number }) => Promise<string>;
  writeTextFile?: (params: { path: string; content: string }) => Promise<void>;
  terminal?: (params: ClientBridgeCreateTerminalParams) => Promise<ClientBridgeTerminalHandle>;
  requestPermission?: (params: ClientBridgePermissionToolCall) => Promise<ClientBridgePermissionOutcome>;
}
```

**Pattern:** Feature detection → conditional implementation. If the client lacks a capability, fall back to the default implementation.

### Potential application to pi-crew

**LOW-MEDIUM VALUE:**

pi-crew already has `LiveExtensionBridge` and `LiveAgentControl` — doesn't need an ACP bridge. However, this pattern is useful for:

1. **pi-crew tool permission system** — Could use this pattern to check permission before allowing tool execution
2. **Cross-extension communication** — The `ClientBridge` pattern could be adapted for `CrossExtensionRPC`

**Effort: LOW** — just learn the pattern, no need to port code

### Risk/Dependency
- ACP SDK is proprietary (`@agentclientprotocol/sdk`)
- The pattern can be applied without the SDK

---

## 4. Feature: Todo Helper (`todo.ts`)

### Purpose
A slash command helper that lets agents manage a todo list within a project. Supports subcommands: `done`, `drop`, `rm`, and parses markdown todo format.

### How it works

**Tokenize approach:**
```typescript
// Handle escape sequences, quoted strings, whitespace
function tokenize(input: string): string[] {
  let current = "";
  let inQuote = false;
  // ... parsing logic
}

// Subcommands:
// /todo done <phase> <task> — mark task done
// /todo drop <phase> <task> — remove task
// /todo rm <phase> <task> — alias for drop
```

**Markdown ↔ Phases conversion:**
- `markdownToPhases` — Parse markdown todo format
- `phasesToMarkdown` — Convert back to markdown
- `getLatestTodoPhasesFromEntries` — Get latest version

**Tokenize features:**
- Quoted strings: `"task with spaces"`
- Escape sequences: `\<char>`
- Whitespace splitting

### Potential application to pi-crew

**HIGH VALUE for pi-crew:**

pi-crew has `YieldReminder` and `TaskRunner` — can integrate todo management:

1. **Team task tracking** — Workflow tasks can be represented as todos
2. **Yield + Todo integration** — When an agent yields with a todo request, can parse and update the todo list
3. **Slash command `/crew todo`** — Management interface for team tasks

**Implementation approach:**
1. Fork the `todo.ts` helper (279 lines)
2. Integrate into `CrewTaskRunner` or `YieldHandler`
3. Add a `/crew todo` slash command
4. Wire into the `TaskDisplay` component

**Effort: MEDIUM** — can copy the module, needs integration with the existing task system

### Risk/Dependency
- Dependency on `todo-write.ts` tool
- Needs to sync with actual task state in the manifest

---

## 5. Feature: Compaction Error Types (`compaction/errors.ts`)

### Purpose
Typed error sentinels for compaction operations. Uses `instanceof` discrimination instead of string matching.

### How it works

```typescript
export class CompactionCancelledError extends Error {
  readonly name = "CompactionCancelledError" as const;
  constructor(message = "Compaction cancelled") { super(message); }
}

export type CompactionOutcome = "ok" | "cancelled" | "failed";
```

**Pattern:**
- Sentinel class with a readonly `name` property
- Downstream callers use `instanceof CompactionCancelledError`
- Source-agnostic: Esc, extension hook, programmatic abort all share the same type

### Potential application to pi-crew

**MEDIUM VALUE for pi-crew:**

pi-crew has `YieldResult` and compaction tracking — can use this pattern:

1. **Typed cancellation errors** — `CrewCancelledError`, `CrewTimeoutError`, `CrewDeadletterError`
2. **Better error discrimination** — Instead of string matching, use `instanceof`
3. **Error outcome tracking** — `CrewRunOutcome = "ok" | "cancelled" | "failed" | "deadletter"`

**Implementation approach:**
```typescript
// src/errors/crew-errors.ts
export class CrewCancelledError extends Error {
  readonly name = "CrewCancelledError" as const;
}

export class CrewTimeoutError extends Error {
  readonly name = "CrewTimeoutError" as const;
}

export class CrewDeadletterError extends Error {
  readonly name = "CrewDeadletterError" as const;
  constructor(public readonly agentId: string, public readonly reason: string) {
    super(`Agent ${agentId} deadlettered: ${reason}`);
  }
}
```

**Effort: LOW** — just create the error classes and replace `instanceof Error` checks

### Risk/Dependency
- None — pure TypeScript, can copy the pattern
- Need to audit existing error handling to update

---

## 6. Feature: ACP Agent Session (`acp-agent.ts`)

### Purpose
ACP protocol handler in oh-my-pi. Extends from `agent-session.ts` with:
- Fork sessions (clone session state)
- Session list/load/resume
- Model state management
- MCP server discovery

### How it works

**ACP Protocol types:**
```typescript
type NewSessionRequest, ForkSessionRequest, LoadSessionRequest, ResumeSessionRequest
type SetSessionModelRequest, SetSessionModeRequest
type SessionInfo, SessionModelState, SessionModeState
type ClientCapabilities (fs, terminal, permission)
```

**Key capabilities:**
- `forkSession` — Clone a session with the same conversation history
- `listSessions` — Enumerate active sessions
- `loadSession` / `resumeSession` — Restore a previous session
- `setSessionModel` — Change model mid-session

### Potential application to pi-crew

**HIGH VALUE for pi-crew:**

1. **Fork session** — In workflow orchestration, could fork an agent session to run parallel experiments
2. **Session resume** — Resume a previous run from manifest/events
3. **Model switching** — Change model for specific tasks (e.g. cheap model for exploration, expensive model for final generation)

**Current pi-crew state:**
- pi-crew already has `ResumeSession` for team runs (re-spawn child Pi)
- But no in-process session fork

**Implementation approach:**
- `forkLiveAgentSession()` — Clone `LiveAgentHandle` with the same conversation
- Store forked sessions in `live-agent-manager.ts`
- Add a `fork-session` operation to the `team-tool api`

**Effort: HIGH** — needs deep understanding of `LiveSessionHandle` and session state

### Risk/Dependency
- Requires oh-my-pi internals (AgentSession, ToolSession)
- pi-crew uses a child Pi process — fork may not be compatible

---

## 7. Feature: User Metrics (`stats/src/user-metrics.ts`)

### Purpose
Tracking and aggregation of user behavior metrics: edits, tool usage, model selection, cost, session quality.

### How it works

**Database schema:**
- Sessions table: session_id, start_time, end_time, model, cost
- Tool usage: session_id, tool_name, count, duration
- Edit patterns: session_id, lines_added, lines_removed, files_changed
- Behavior models: quality score, efficiency score

**Analytics:**
- Behavior chart: edits over time, tool usage distribution
- Model comparison: cost vs quality per model
- Session summary: duration, token usage, task completion rate

### Potential application to pi-crew

**MEDIUM VALUE:**

pi-crew already has `UsageTracker` and `MetricsRegistry` — can learn from:

1. **Team metrics** — Track team run performance (workflow duration, agent utilization, cost)
2. **Agent quality scoring** — Rate agent output quality
3. **Cost tracking** — Per-agent, per-task, per-team cost

**Effort: MEDIUM** — Need to design a database schema and API

### Risk/Dependency
- SQLite or a separate database
- Privacy implications (storing user behavior data)

---

## 8. Feature: Shell Minimizer (`crates/pi-shell/src/minimizer/`)

### Purpose
Automatically minimize command output (remove noise like progress bars, ANSI codes) so the LLM can read cleaner results.

### How it works

**100+ TOML config files:**
- `cargo.toml` — Filter cargo progress output
- `npm-install.toml` — Filter npm package output
- `terraform-plan.toml` — Simplify terraform plans
- etc.

**Engine:**
```rust
// minimizer/engine.rs
pub struct Minimizer {
    filters: Vec<Box<dyn Filter>>,
}

// Filter types: line removal, replacement, truncation
```

### Potential application to pi-crew

**HIGH VALUE for pi-crew:**

pi-crew agents run bash commands — the output can be very noisy. The minimizer helps:
- Agents read clean output
- Reduces context usage
- Focuses on important information

**Implementation approach:**
1. Fork the minimizer engine (Rust) or port to TypeScript
2. Integrate into `TaskRunner` bash execution
3. Auto-detect command type and apply the appropriate filter

**Effort: HIGH** — Rust code needs rewriting or integration via FFI

### Risk/Dependency
- Rust dependency
- May not be necessary if oh-my-pi splits it into a standalone tool

---

## 9. Feature: MCP Helper (`slash-commands/helpers/mcp.ts`)

### Purpose
Helper for MCP (Model Context Protocol) slash commands. Manages MCP server configuration and tool invocation.

### How it works

532 lines of TypeScript. **Key functions:**
- `resolveMcpServer` — Resolve MCP server config
- `invokeMcpTool` — Call an MCP tool
- `listMcpResources` — List available resources
- `mcpServerStatus` — Check server health

### Potential application to pi-crew

**MEDIUM VALUE:**

pi-crew already has `McpProxy` in `live-extension-bridge.ts` — can learn more:
1. **MCP server lifecycle** — Start/stop MCP servers per team
2. **MCP tool routing** — Route MCP calls through the team session

**Effort: LOW** — just learn the pattern, no need to port code

### Risk/Dependency
- MCP protocol knowledge required
- Can reuse the existing `buildMcpProxyFromSession`

---

## 10. Feature: Issue-PR Protocol (`internal-urls/issue-pr-protocol.ts`)

### Purpose
Protocol handler for `issue://` and `pr://` internal URLs. Lets agents interact with GitHub/GitLab issues and PRs through a unified interface.

### How it works

```typescript
// Handle URLs like:
// issue://github.com/owner/repo/123
// pr://github.com/owner/repo/456
// issue://gitlab.com/owner/repo/789
```

**Operations:**
- `read` — Get issue/PR content
- `search` — Search issues/PRs
- `comment` — Add comment
- `close` / `reopen` — State transitions

### Potential application to pi-crew

**HIGH VALUE for pi-crew:**

pi-crew workflow agents can benefit from issue/PR integration:
1. **Task creation** — Create an issue from a failed task
2. **PR review** — Use the `pr://` protocol in the review workflow
3. **Task linking** — Link workflow tasks to issues

**Effort: MEDIUM** — Need to port `issue-pr-protocol.ts` (577 lines)

### Risk/Dependency
- GitHub API authentication
- Complex state machine (open/close/reopen/merge)

---

## Summary: Recommendations

### Tier 1 — High Value, Medium Effort (High priority)

| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Conflict Detection** | Prevents data loss when multiple agents edit the same file | MEDIUM | Fork `conflict-detect.ts`, add `conflict://` protocol |
| **Typed Crew Errors** | Better error handling, cleaner code | LOW | Create `CrewCancelledError`, `CrewTimeoutError`, `CrewDeadletterError` |
| **Todo Integration** | Task tracking for team workflows | MEDIUM | Fork `todo.ts`, integrate with `TaskRunner` |
| **Issue-PR Protocol** | Link team tasks to GitHub issues | MEDIUM | Port `issue-pr-protocol.ts` |

### Tier 2 — High Value, High Effort (Lower priority)

| Feature | Why | Effort | Notes |
|---|---|---|---|
| **Shell Minimizer** | Clean command output for agents | HIGH | Rust → TypeScript port or FFI |
| **ACP Fork Session** | Parallel agent experiments | HIGH | Needs deep `LiveSessionHandle` understanding |
| **User Metrics** | Team performance analytics | MEDIUM | Design DB schema, build API |

### Tier 3 — Low Value (Not prioritized)

| Feature | Why | Effort |
|---|---|---|
| Hashline Engine | Strongly coupled to oh-my-pi | HIGH |
| ACP Client Bridge | pi-crew already has `LiveExtensionBridge` | LOW |
| MCP Helper | pi-crew already has `McpProxy` | LOW |

---

## Next Steps

1. **Conflict Detection** — Start with porting `conflict-detect.ts` because it's standalone and high-value
2. **Typed Errors** — Quick win, just create the error classes
3. **Todo Integration** — Long-term, needs integration with the workflow engine

## Files to read further

- `packages/coding-agent/src/tools/conflict-detect.ts` (entire file)
- `packages/coding-agent/src/tools/todo-write.ts` (dependency of todo.ts)
- `packages/coding-agent/src/session/agent-session.ts` (the fork/resume session part)
- `crates/pi-shell/src/minimizer/engine.rs` (if you want to port the shell minimizer)
